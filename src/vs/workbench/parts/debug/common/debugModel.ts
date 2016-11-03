/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import uri from 'vs/base/common/uri';
import { TPromise } from 'vs/base/common/winjs.base';
import * as lifecycle from 'vs/base/common/lifecycle';
import Event, { Emitter } from 'vs/base/common/event';
import { generateUuid } from 'vs/base/common/uuid';
import { clone } from 'vs/base/common/objects';
import severity from 'vs/base/common/severity';
import { isObject, isString } from 'vs/base/common/types';
import { distinct } from 'vs/base/common/arrays';
import { ISuggestion } from 'vs/editor/common/modes';
import { Position } from 'vs/editor/common/core/position';
import * as debug from 'vs/workbench/parts/debug/common/debug';
import { Source } from 'vs/workbench/parts/debug/common/debugSource';

const MAX_REPL_LENGTH = 10000;
const UNKNOWN_SOURCE_LABEL = nls.localize('unknownSource', "Unknown Source");

function massageValue(value: string): string {
	return value ? value.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') : value;
}

export class OutputElement implements debug.ITreeElement {
	private static ID_COUNTER = 0;

	constructor(private id = OutputElement.ID_COUNTER++) {
		// noop
	}

	public getId(): string {
		return `outputelement:${this.id}`;
	}
}

export class ValueOutputElement extends OutputElement {

	constructor(
		public value: string,
		public severity: severity,
		public category?: string,
		public counter: number = 1
	) {
		super();
	}
}

export class KeyValueOutputElement extends OutputElement {

	private static MAX_CHILDREN = 1000; // upper bound of children per value

	private children: debug.ITreeElement[];
	private _valueName: string;

	constructor(public key: string, public valueObj: any, public annotation?: string) {
		super();

		this._valueName = null;
	}

	public get value(): string {
		if (this._valueName === null) {
			if (this.valueObj === null) {
				this._valueName = 'null';
			} else if (Array.isArray(this.valueObj)) {
				this._valueName = `Array[${this.valueObj.length}]`;
			} else if (isObject(this.valueObj)) {
				this._valueName = 'Object';
			} else if (isString(this.valueObj)) {
				this._valueName = `"${massageValue(this.valueObj)}"`;
			} else {
				this._valueName = String(this.valueObj);
			}

			if (!this._valueName) {
				this._valueName = '';
			}
		}

		return this._valueName;
	}

	public getChildren(): debug.ITreeElement[] {
		if (!this.children) {
			if (Array.isArray(this.valueObj)) {
				this.children = (<any[]>this.valueObj).slice(0, KeyValueOutputElement.MAX_CHILDREN).map((v, index) => new KeyValueOutputElement(String(index), v, null));
			} else if (isObject(this.valueObj)) {
				this.children = Object.getOwnPropertyNames(this.valueObj).slice(0, KeyValueOutputElement.MAX_CHILDREN).map(key => new KeyValueOutputElement(key, this.valueObj[key], null));
			} else {
				this.children = [];
			}
		}

		return this.children;
	}
}

export abstract class ExpressionContainer implements debug.IExpressionContainer {

	public static allValues: { [id: string]: string } = {};
	// Use chunks to support variable paging #9537
	private static BASE_CHUNK_SIZE = 100;

	public valueChanged: boolean;
	private _value: string;

	constructor(
		public stackFrame: debug.IStackFrame,
		public reference: number,
		private id: string,
		public namedVariables: number,
		public indexedVariables: number,
		private startOfVariables = 0
	) { }

	public getChildren(): TPromise<debug.IExpression[]> {
		// only variables with reference > 0 have children.
		if (this.reference <= 0) {
			return TPromise.as([]);
		}

		if (!this.getChildrenInChunks) {
			return this.fetchVariables(undefined, undefined, undefined);
		}

		// Check if object has named variables, fetch them independent from indexed variables #9670
		return (!!this.namedVariables ? this.fetchVariables(undefined, undefined, 'named') : TPromise.as([])).then(childrenArray => {
			// Use a dynamic chunk size based on the number of elements #9774
			let chunkSize = ExpressionContainer.BASE_CHUNK_SIZE;
			while (this.indexedVariables > chunkSize * ExpressionContainer.BASE_CHUNK_SIZE) {
				chunkSize *= ExpressionContainer.BASE_CHUNK_SIZE;
			}

			if (this.indexedVariables > chunkSize) {
				// There are a lot of children, create fake intermediate values that represent chunks #9537
				const numberOfChunks = Math.ceil(this.indexedVariables / chunkSize);
				for (let i = 0; i < numberOfChunks; i++) {
					const start = this.startOfVariables + i * chunkSize;
					const count = Math.min(chunkSize, this.indexedVariables - i * chunkSize);
					childrenArray.push(new Variable(this.stackFrame, this, this.reference, `[${start}..${start + count - 1}]`, '', '', null, count, null, true, start));
				}

				return childrenArray;
			}

			return this.fetchVariables(this.startOfVariables, this.indexedVariables, 'indexed')
				.then(variables => childrenArray.concat(variables));
		});
	}

	public getId(): string {
		return this.id;
	}

	public get value(): string {
		return this._value;
	}

	public get hasChildren(): boolean {
		return this.reference > 0;
	}

	private fetchVariables(start: number, count: number, filter: 'indexed' | 'named'): TPromise<Variable[]> {
		return this.stackFrame.thread.process.session.variables({
			variablesReference: this.reference,
			start,
			count,
			filter
		}).then(response => {
			return response && response.body && response.body.variables ? distinct(response.body.variables.filter(v => !!v), v => v.name).map(
				v => new Variable(this.stackFrame, this, v.variablesReference, v.name, v.evaluateName, v.value, v.namedVariables, v.indexedVariables, v.type)
			) : [];
		}, (e: Error) => [new Variable(this.stackFrame, this, 0, null, e.message, '', 0, 0, null, false)]);
	}

	// The adapter explicitly sents the children count of an expression only if there are lots of children which should be chunked.
	private get getChildrenInChunks(): boolean {
		return !!this.indexedVariables;
	}

	public set value(value: string) {
		this._value = massageValue(value);
		this.valueChanged = ExpressionContainer.allValues[this.getId()] &&
			ExpressionContainer.allValues[this.getId()] !== Expression.DEFAULT_VALUE && ExpressionContainer.allValues[this.getId()] !== value;
		ExpressionContainer.allValues[this.getId()] = value;
	}
}

export class Expression extends ExpressionContainer implements debug.IExpression {
	static DEFAULT_VALUE = 'not available';

	public available: boolean;
	public type: string;

	constructor(public name: string, id = generateUuid()) {
		super(null, 0, id, 0, 0);
		this.available = false;
		// name is not set if the expression is just being added
		// in that case do not set default value to prevent flashing #14499
		if (name) {
			this.value = Expression.DEFAULT_VALUE;
		}
	}

	public evaluate(process: debug.IProcess, stackFrame: debug.IStackFrame, context: string): TPromise<void> {
		if (!process) {
			this.value = context === 'repl' ? nls.localize('startDebugFirst', "Please start a debug session to evaluate") : Expression.DEFAULT_VALUE;
			this.available = false;
			this.reference = 0;

			return TPromise.as(null);
		}

		// Create a fake stack frame which is just used as a container for the process.
		// TODO@Isidor revisit if variables should have a reference to the StackFrame or a process after all
		this.stackFrame = stackFrame || new StackFrame(new Thread(process, undefined, undefined), undefined, undefined, undefined, undefined, undefined);

		return process.session.evaluate({
			expression: this.name,
			frameId: stackFrame ? stackFrame.frameId : undefined,
			context
		}).then(response => {
			this.available = !!(response && response.body);
			if (response && response.body) {
				this.value = response.body.result;
				this.reference = response.body.variablesReference;
				this.namedVariables = response.body.namedVariables;
				this.indexedVariables = response.body.indexedVariables;
				this.type = response.body.type;
			}
		}, err => {
			this.value = err.message;
			this.available = false;
			this.reference = 0;
		});
	}
}

export class Variable extends ExpressionContainer implements debug.IExpression {

	// Used to show the error message coming from the adapter when setting the value #7807
	public errorMessage: string;
	private static NOT_PROPERTY_SYNTAX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
	private static ARRAY_ELEMENT_SYNTAX = /\[.*\]$/;

	constructor(
		stackFrame: debug.IStackFrame,
		public parent: debug.IExpressionContainer,
		reference: number,
		public name: string,
		private _evaluateName: string,
		value: string,
		namedVariables: number,
		indexedVariables: number,
		public type: string = null,
		public available = true,
		startOfVariables = 0
	) {
		super(stackFrame, reference, `variable:${parent.getId()}:${name}:${reference}`, namedVariables, indexedVariables, startOfVariables);
		this.value = massageValue(value);
	}

	public get evaluateName(): string {
		if (this._evaluateName) {
			return this._evaluateName;
		}

		let names = [this.name];
		let v = this.parent;
		while (v instanceof Variable || v instanceof Expression) {
			names.push((<Variable>v).name);
			v = (<Variable>v).parent;
		}
		names = names.reverse();

		let result = null;
		names.forEach(name => {
			if (!result) {
				result = name;
			} else if (Variable.ARRAY_ELEMENT_SYNTAX.test(name) || (this.stackFrame.thread.process.session.configuration.type === 'node' && !Variable.NOT_PROPERTY_SYNTAX.test(name))) {
				// use safe way to access node properties a['property_name']. Also handles array elements.
				result = name && name.indexOf('[') === 0 ? `${result}${name}` : `${result}['${name}']`;
			} else {
				result = `${result}.${name}`;
			}
		});

		return result;
	}

	public setVariable(value: string): TPromise<any> {
		return this.stackFrame.thread.process.session.setVariable({
			name: this.name,
			value,
			variablesReference: (<ExpressionContainer>this.parent).reference
		}).then(response => {
			if (response && response.body) {
				this.value = response.body.value;
				this.type = response.body.type || this.type;
				this.reference = response.body.variablesReference;
				this.namedVariables = response.body.namedVariables;
				this.indexedVariables = response.body.indexedVariables;
			}
			// TODO@Isidor notify stackFrame that a change has happened so watch expressions get revelauted
		}, err => {
			this.errorMessage = err.message;
		});
	}
}

export class Scope extends ExpressionContainer implements debug.IScope {

	constructor(
		stackFrame: debug.IStackFrame,
		public name: string,
		reference: number,
		public expensive: boolean,
		namedVariables: number,
		indexedVariables: number
	) {
		super(stackFrame, reference, `scope:${stackFrame.getId()}:${name}:${reference}`, namedVariables, indexedVariables);
	}
}

export class StackFrame implements debug.IStackFrame {

	private scopes: TPromise<Scope[]>;

	constructor(
		public thread: debug.IThread,
		public frameId: number,
		public source: Source,
		public name: string,
		public lineNumber: number,
		public column: number
	) {
		this.scopes = null;
	}

	public getId(): string {
		return `stackframe:${this.thread.getId()}:${this.frameId}`;
	}

	public getScopes(): TPromise<debug.IScope[]> {
		if (!this.scopes) {
			this.scopes = this.thread.process.session.scopes({ frameId: this.frameId }).then(response => {
				return response && response.body && response.body.scopes ?
					response.body.scopes.map(rs => new Scope(this, rs.name, rs.variablesReference, rs.expensive, rs.namedVariables, rs.indexedVariables)) : [];
			}, err => []);
		}

		return this.scopes;
	}

	public restart(): TPromise<any> {
		return this.thread.process.session.restartFrame({ frameId: this.frameId });
	}

	public completions(text: string, position: Position, overwriteBefore: number): TPromise<ISuggestion[]> {
		if (!this.thread.process.session.configuration.capabilities.supportsCompletionsRequest) {
			return TPromise.as([]);
		}

		return this.thread.process.session.completions({
			frameId: this.frameId,
			text,
			column: position.column,
			line: position.lineNumber
		}).then(response => {
			return response && response.body && response.body.targets ? response.body.targets.map(item => (<ISuggestion>{
				label: item.label,
				insertText: item.text || item.label,
				type: item.type,
				overwriteBefore: item.length || overwriteBefore
			})) : [];
		}, err => []);
	}
}

export class Thread implements debug.IThread {
	private promisedCallStack: TPromise<debug.IStackFrame[]>;
	private cachedCallStack: debug.IStackFrame[];
	public stoppedDetails: debug.IRawStoppedDetails;
	public stopped: boolean;

	constructor(public process: debug.IProcess, public name: string, public threadId: number) {
		this.promisedCallStack = undefined;
		this.stoppedDetails = undefined;
		this.cachedCallStack = undefined;
		this.stopped = false;
	}

	public getId(): string {
		return `thread:${this.process.getId()}:${this.name}:${this.threadId}`;
	}

	public clearCallStack(): void {
		this.promisedCallStack = undefined;
		this.cachedCallStack = undefined;
	}

	public getCachedCallStack(): debug.IStackFrame[] {
		return this.cachedCallStack;
	}

	public getCallStack(getAdditionalStackFrames = false): TPromise<debug.IStackFrame[]> {
		if (!this.stopped) {
			return TPromise.as([]);
		}

		if (!this.promisedCallStack) {
			this.promisedCallStack = this.getCallStackImpl(0).then(callStack => {
				this.cachedCallStack = callStack;
				return callStack;
			});
		} else if (getAdditionalStackFrames) {
			this.promisedCallStack = this.promisedCallStack.then(callStackFirstPart => this.getCallStackImpl(callStackFirstPart.length).then(callStackSecondPart => {
				this.cachedCallStack = callStackFirstPart.concat(callStackSecondPart);
				return this.cachedCallStack;
			}));
		}

		return this.promisedCallStack;
	}

	private getCallStackImpl(startFrame: number): TPromise<debug.IStackFrame[]> {
		return this.process.session.stackTrace({ threadId: this.threadId, startFrame, levels: 20 }).then(response => {
			if (!response || !response.body) {
				return [];
			}

			if (this.stoppedDetails) {
				this.stoppedDetails.totalFrames = response.body.totalFrames;
			}

			return response.body.stackFrames.map((rsf, level) => {
				if (!rsf) {
					return new StackFrame(this, 0, new Source({ name: UNKNOWN_SOURCE_LABEL }, false), nls.localize('unknownStack', "Unknown stack location"), undefined, undefined);
				}

				return new StackFrame(this, rsf.id, rsf.source ? new Source(rsf.source) : new Source({ name: UNKNOWN_SOURCE_LABEL }, false), rsf.name, rsf.line, rsf.column);
			});
		}, (err: Error) => {
			if (this.stoppedDetails) {
				this.stoppedDetails.framesErrorMessage = err.message;
			}

			return [];
		});
	}

	public next(): TPromise<any> {
		return this.process.session.next({ threadId: this.threadId });
	}

	public stepIn(): TPromise<any> {
		return this.process.session.stepIn({ threadId: this.threadId });
	}

	public stepOut(): TPromise<any> {
		return this.process.session.stepOut({ threadId: this.threadId });
	}

	public stepBack(): TPromise<any> {
		return this.process.session.stepBack({ threadId: this.threadId });
	}

	public continue(): TPromise<any> {
		return this.process.session.continue({ threadId: this.threadId });
	}

	public pause(): TPromise<any> {
		return this.process.session.pause({ threadId: this.threadId });
	}
}

export class Process implements debug.IProcess {

	private threads: { [reference: number]: debug.IThread; };

	constructor(public name: string, private _session: debug.ISession & debug.ITreeElement) {
		this.threads = {};
	}

	public get session(): debug.ISession {
		return this._session;
	}

	public getThread(threadId: number): debug.IThread {
		return this.threads[threadId];
	}

	public getAllThreads(): debug.IThread[] {
		return Object.keys(this.threads).map(key => this.threads[key]);
	}

	public getId(): string {
		return this._session.getId();
	}

	public rawUpdate(data: debug.IRawModelUpdate): void {

		if (data.thread && !this.threads[data.threadId]) {
			// A new thread came in, initialize it.
			this.threads[data.threadId] = new Thread(this, data.thread.name, data.thread.id);
		}

		if (data.stoppedDetails) {
			// Set the availability of the threads' callstacks depending on
			// whether the thread is stopped or not
			if (data.allThreadsStopped) {
				Object.keys(this.threads).forEach(ref => {
					// Only update the details if all the threads are stopped
					// because we don't want to overwrite the details of other
					// threads that have stopped for a different reason
					this.threads[ref].stoppedDetails = clone(data.stoppedDetails);
					this.threads[ref].stopped = true;
					this.threads[ref].clearCallStack();
				});
			} else {
				// One thread is stopped, only update that thread.
				this.threads[data.threadId].stoppedDetails = data.stoppedDetails;
				this.threads[data.threadId].clearCallStack();
				this.threads[data.threadId].stopped = true;
			}
		}
	}

	public clearThreads(removeThreads: boolean, reference: number = undefined): void {
		if (reference) {
			if (this.threads[reference]) {
				this.threads[reference].clearCallStack();
				this.threads[reference].stoppedDetails = undefined;
				this.threads[reference].stopped = false;

				if (removeThreads) {
					delete this.threads[reference];
				}
			}
		} else {
			Object.keys(this.threads).forEach(ref => {
				this.threads[ref].clearCallStack();
				this.threads[ref].stoppedDetails = undefined;
				this.threads[ref].stopped = false;
			});

			if (removeThreads) {
				this.threads = {};
				ExpressionContainer.allValues = {};
			}
		}
	}

	public sourceIsUnavailable(source: Source): void {
		Object.keys(this.threads).forEach(key => {
			if (this.threads[key].getCachedCallStack()) {
				this.threads[key].getCachedCallStack().forEach(stackFrame => {
					if (stackFrame.source.uri.toString() === source.uri.toString()) {
						stackFrame.source.available = false;
					}
				});
			}
		});
	}
}

export class Breakpoint implements debug.IBreakpoint {

	public lineNumber: number;
	public verified: boolean;
	public idFromAdapter: number;
	public message: string;
	private id: string;

	constructor(
		public uri: uri,
		public desiredLineNumber: number,
		public enabled: boolean,
		public condition: string,
		public hitCondition: string
	) {
		if (enabled === undefined) {
			this.enabled = true;
		}
		this.lineNumber = this.desiredLineNumber;
		this.verified = false;
		this.id = generateUuid();
	}

	public getId(): string {
		return this.id;
	}
}

export class FunctionBreakpoint implements debug.IFunctionBreakpoint {

	private id: string;
	public verified: boolean;
	public idFromAdapter: number;

	constructor(public name: string, public enabled: boolean, public hitCondition: string) {
		this.verified = false;
		this.id = generateUuid();
	}

	public getId(): string {
		return this.id;
	}
}

export class ExceptionBreakpoint implements debug.IExceptionBreakpoint {

	private id: string;

	constructor(public filter: string, public label: string, public enabled: boolean) {
		this.id = generateUuid();
	}

	public getId(): string {
		return this.id;
	}
}

export class Model implements debug.IModel {

	private processes: Process[];
	private toDispose: lifecycle.IDisposable[];
	private replElements: debug.ITreeElement[];
	private _onDidChangeBreakpoints: Emitter<void>;
	private _onDidChangeCallStack: Emitter<void>;
	private _onDidChangeWatchExpressions: Emitter<debug.IExpression>;
	private _onDidChangeREPLElements: Emitter<void>;

	constructor(
		private breakpoints: Breakpoint[],
		private breakpointsActivated: boolean,
		private functionBreakpoints: FunctionBreakpoint[],
		private exceptionBreakpoints: ExceptionBreakpoint[],
		private watchExpressions: Expression[]
	) {
		this.processes = [];
		this.replElements = [];
		this.toDispose = [];
		this._onDidChangeBreakpoints = new Emitter<void>();
		this._onDidChangeCallStack = new Emitter<void>();
		this._onDidChangeWatchExpressions = new Emitter<debug.IExpression>();
		this._onDidChangeREPLElements = new Emitter<void>();
	}

	public getId(): string {
		return 'root';
	}

	public getProcesses(): Process[] {
		return this.processes;
	}

	public addProcess(name: string, session: debug.ISession & debug.ITreeElement): Process {
		const process = new Process(name, session);
		this.processes.push(process);

		return process;
	}

	public removeProcess(id: string): void {
		this.processes = this.processes.filter(p => p.getId() !== id);
		this._onDidChangeCallStack.fire();
	}

	public get onDidChangeBreakpoints(): Event<void> {
		return this._onDidChangeBreakpoints.event;
	}

	public get onDidChangeCallStack(): Event<void> {
		return this._onDidChangeCallStack.event;
	}

	public get onDidChangeWatchExpressions(): Event<debug.IExpression> {
		return this._onDidChangeWatchExpressions.event;
	}

	public get onDidChangeReplElements(): Event<void> {
		return this._onDidChangeREPLElements.event;
	}

	public rawUpdate(data: debug.IRawModelUpdate): void {
		let process = this.processes.filter(p => p.getId() === data.sessionId).pop();
		if (process) {
			process.rawUpdate(data);
			this._onDidChangeCallStack.fire();
		}
	}

	public clearThreads(id: string, removeThreads: boolean, reference: number = undefined): void {
		const process = this.processes.filter(p => p.getId() === id).pop();
		if (process) {
			process.clearThreads(removeThreads, reference);
			this._onDidChangeCallStack.fire();
		}
	}

	public getBreakpoints(): Breakpoint[] {
		return this.breakpoints;
	}

	public getFunctionBreakpoints(): debug.IFunctionBreakpoint[] {
		return this.functionBreakpoints;
	}

	public getExceptionBreakpoints(): debug.IExceptionBreakpoint[] {
		return this.exceptionBreakpoints;
	}

	public setExceptionBreakpoints(data: DebugProtocol.ExceptionBreakpointsFilter[]): void {
		if (data) {
			this.exceptionBreakpoints = data.map(d => {
				const ebp = this.exceptionBreakpoints.filter(ebp => ebp.filter === d.filter).pop();
				return new ExceptionBreakpoint(d.filter, d.label, ebp ? ebp.enabled : d.default);
			});
		}
	}

	public areBreakpointsActivated(): boolean {
		return this.breakpointsActivated;
	}

	public setBreakpointsActivated(activated: boolean): void {
		this.breakpointsActivated = activated;
		this._onDidChangeBreakpoints.fire();
	}

	public addBreakpoints(uri: uri, rawData: debug.IRawBreakpoint[]): void {
		this.breakpoints = this.breakpoints.concat(rawData.map(rawBp =>
			new Breakpoint(uri, rawBp.lineNumber, rawBp.enabled, rawBp.condition, rawBp.hitCondition)));
		this.breakpointsActivated = true;
		this._onDidChangeBreakpoints.fire();
	}

	public removeBreakpoints(toRemove: debug.IBreakpoint[]): void {
		this.breakpoints = this.breakpoints.filter(bp => !toRemove.some(toRemove => toRemove.getId() === bp.getId()));
		this._onDidChangeBreakpoints.fire();
	}

	public updateBreakpoints(data: { [id: string]: DebugProtocol.Breakpoint }): void {
		this.breakpoints.forEach(bp => {
			const bpData = data[bp.getId()];
			if (bpData) {
				bp.lineNumber = bpData.line ? bpData.line : bp.lineNumber;
				bp.verified = bpData.verified;
				bp.idFromAdapter = bpData.id;
				bp.message = bpData.message;
			}
		});
		this._onDidChangeBreakpoints.fire();
	}

	public setEnablement(element: debug.IEnablement, enable: boolean): void {
		element.enabled = enable;
		if (element instanceof Breakpoint && !element.enabled) {
			var breakpoint = <Breakpoint>element;
			breakpoint.lineNumber = breakpoint.desiredLineNumber;
			breakpoint.verified = false;
		}

		this._onDidChangeBreakpoints.fire();
	}

	public enableOrDisableAllBreakpoints(enable: boolean): void {
		this.breakpoints.forEach(bp => {
			bp.enabled = enable;
			if (!enable) {
				bp.lineNumber = bp.desiredLineNumber;
				bp.verified = false;
			}
		});
		this.exceptionBreakpoints.forEach(ebp => ebp.enabled = enable);
		this.functionBreakpoints.forEach(fbp => fbp.enabled = enable);

		this._onDidChangeBreakpoints.fire();
	}

	public addFunctionBreakpoint(functionName: string): void {
		this.functionBreakpoints.push(new FunctionBreakpoint(functionName, true, null));
		this._onDidChangeBreakpoints.fire();
	}

	public updateFunctionBreakpoints(data: { [id: string]: { name?: string, verified?: boolean; id?: number; hitCondition?: string } }): void {
		this.functionBreakpoints.forEach(fbp => {
			const fbpData = data[fbp.getId()];
			if (fbpData) {
				fbp.name = fbpData.name || fbp.name;
				fbp.verified = fbpData.verified;
				fbp.idFromAdapter = fbpData.id;
				fbp.hitCondition = fbpData.hitCondition;
			}
		});

		this._onDidChangeBreakpoints.fire();
	}

	public removeFunctionBreakpoints(id?: string): void {
		this.functionBreakpoints = id ? this.functionBreakpoints.filter(fbp => fbp.getId() !== id) : [];
		this._onDidChangeBreakpoints.fire();
	}

	public getReplElements(): debug.ITreeElement[] {
		return this.replElements;
	}

	public addReplExpression(process: debug.IProcess, stackFrame: debug.IStackFrame, name: string): TPromise<void> {
		const expression = new Expression(name);
		this.addReplElements([expression]);
		return expression.evaluate(process, stackFrame, 'repl')
			.then(() => this._onDidChangeREPLElements.fire());
	}

	public logToRepl(value: string | { [key: string]: any }, severity?: severity): void {
		let elements: OutputElement[] = [];
		let previousOutput = this.replElements.length && (<ValueOutputElement>this.replElements[this.replElements.length - 1]);

		// string message
		if (typeof value === 'string') {
			if (value && value.trim() && previousOutput && previousOutput.value === value && previousOutput.severity === severity) {
				previousOutput.counter++; // we got the same output (but not an empty string when trimmed) so we just increment the counter
			} else {
				let lines = value.trim().split('\n');
				lines.forEach((line, index) => {
					elements.push(new ValueOutputElement(line, severity));
				});
			}
		}

		// key-value output
		else {
			elements.push(new KeyValueOutputElement((<any>value).prototype, value, nls.localize('snapshotObj', "Only primitive values are shown for this object.")));
		}

		if (elements.length) {
			this.addReplElements(elements);
		}
		this._onDidChangeREPLElements.fire();
	}

	public appendReplOutput(value: string, severity?: severity): void {
		const elements: OutputElement[] = [];
		let previousOutput = this.replElements.length && (<ValueOutputElement>this.replElements[this.replElements.length - 1]);
		let lines = value.split('\n');
		let groupTogether = !!previousOutput && (previousOutput.category === 'output' && severity === previousOutput.severity);

		if (groupTogether) {
			// append to previous line if same group
			previousOutput.value += lines.shift();
		} else if (previousOutput && previousOutput.value === '') {
			// remove potential empty lines between different output types
			this.replElements.pop();
		}

		// fill in lines as output value elements
		lines.forEach((line, index) => {
			elements.push(new ValueOutputElement(line, severity, 'output'));
		});

		this.addReplElements(elements);
		this._onDidChangeREPLElements.fire();
	}

	private addReplElements(newElements: debug.ITreeElement[]): void {
		this.replElements.push(...newElements);
		if (this.replElements.length > MAX_REPL_LENGTH) {
			this.replElements.splice(0, this.replElements.length - MAX_REPL_LENGTH);
		}
	}

	public removeReplExpressions(): void {
		if (this.replElements.length > 0) {
			this.replElements = [];
			this._onDidChangeREPLElements.fire();
		}
	}

	public getWatchExpressions(): Expression[] {
		return this.watchExpressions;
	}

	public addWatchExpression(process: debug.IProcess, stackFrame: debug.IStackFrame, name: string): TPromise<void> {
		const we = new Expression(name);
		this.watchExpressions.push(we);
		if (!name) {
			this._onDidChangeWatchExpressions.fire(we);
			return TPromise.as(null);
		}

		return this.evaluateWatchExpressions(process, stackFrame, we.getId());
	}

	public renameWatchExpression(process: debug.IProcess, stackFrame: debug.IStackFrame, id: string, newName: string): TPromise<void> {
		const filtered = this.watchExpressions.filter(we => we.getId() === id);
		if (filtered.length === 1) {
			filtered[0].name = newName;
			return filtered[0].evaluate(process, stackFrame, 'watch').then(() => {
				this._onDidChangeWatchExpressions.fire(filtered[0]);
			});
		}

		return TPromise.as(null);
	}

	public evaluateWatchExpressions(process: debug.IProcess, stackFrame: debug.IStackFrame, id: string = null): TPromise<void> {
		if (id) {
			const filtered = this.watchExpressions.filter(we => we.getId() === id);
			if (filtered.length !== 1) {
				return TPromise.as(null);
			}

			return filtered[0].evaluate(process, stackFrame, 'watch').then(() => {
				this._onDidChangeWatchExpressions.fire(filtered[0]);
			});
		}

		return TPromise.join(this.watchExpressions.map(we => we.evaluate(process, stackFrame, 'watch'))).then(() => {
			this._onDidChangeWatchExpressions.fire();
		});
	}

	public removeWatchExpressions(id: string = null): void {
		this.watchExpressions = id ? this.watchExpressions.filter(we => we.getId() !== id) : [];
		this._onDidChangeWatchExpressions.fire();
	}

	public moveWatchExpression(id: string, position: number): void {
		const we = this.watchExpressions.filter(we => we.getId() === id).pop();
		this.watchExpressions = this.watchExpressions.filter(we => we.getId() !== id);
		this.watchExpressions = this.watchExpressions.slice(0, position).concat(we, this.watchExpressions.slice(position));

		this._onDidChangeWatchExpressions.fire();
	}

	public sourceIsUnavailable(source: Source): void {
		this.processes.forEach(p => p.sourceIsUnavailable(source));
		this._onDidChangeCallStack.fire();
	}

	public dispose(): void {
		this.toDispose = lifecycle.dispose(this.toDispose);
	}
}
