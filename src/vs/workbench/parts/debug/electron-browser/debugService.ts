/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import * as lifecycle from 'vs/base/common/lifecycle';
import { guessMimeTypes } from 'vs/base/common/mime';
import Event, { Emitter } from 'vs/base/common/event';
import * as paths from 'vs/base/common/paths';
import * as strings from 'vs/base/common/strings';
import { generateUuid } from 'vs/base/common/uuid';
import uri from 'vs/base/common/uri';
import { Action } from 'vs/base/common/actions';
import { first, distinct } from 'vs/base/common/arrays';
import { isObject, isUndefinedOrNull } from 'vs/base/common/types';
import * as errors from 'vs/base/common/errors';
import severity from 'vs/base/common/severity';
import { TPromise } from 'vs/base/common/winjs.base';
import * as aria from 'vs/base/browser/ui/aria/aria';
import { Client as TelemetryClient } from 'vs/base/parts/ipc/node/ipc.cp';
import { ICodeEditor } from 'vs/editor/browser/editorBrowser';
import { IContextKeyService, IContextKey } from 'vs/platform/contextkey/common/contextkey';
import { IMarkerService } from 'vs/platform/markers/common/markers';
import { ILifecycleService } from 'vs/platform/lifecycle/common/lifecycle';
import { IExtensionService } from 'vs/platform/extensions/common/extensions';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IFileService, FileChangesEvent, FileChangeType, EventType } from 'vs/platform/files/common/files';
import { IEventService } from 'vs/platform/event/common/event';
import { IMessageService, CloseAction } from 'vs/platform/message/common/message';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { TelemetryService } from 'vs/platform/telemetry/common/telemetryService';
import { TelemetryAppenderClient } from 'vs/platform/telemetry/common/telemetryIpc';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';
import { IEditorGroupService } from 'vs/workbench/services/group/common/groupService';
import { asFileEditorInput } from 'vs/workbench/common/editor';
import * as debug from 'vs/workbench/parts/debug/common/debug';
import { RawDebugSession } from 'vs/workbench/parts/debug/electron-browser/rawDebugSession';
import { Model, ExceptionBreakpoint, FunctionBreakpoint, Breakpoint, Expression } from 'vs/workbench/parts/debug/common/debugModel';
import { DebugStringEditorInput, DebugErrorEditorInput } from 'vs/workbench/parts/debug/browser/debugEditorInputs';
import { ViewModel } from 'vs/workbench/parts/debug/common/debugViewModel';
import * as debugactions from 'vs/workbench/parts/debug/browser/debugActions';
import { ConfigurationManager } from 'vs/workbench/parts/debug/node/debugConfigurationManager';
import { Source } from 'vs/workbench/parts/debug/common/debugSource';
import { ITaskService, TaskEvent, TaskType, TaskServiceEvents, ITaskSummary } from 'vs/workbench/parts/tasks/common/taskService';
import { TaskError, TaskErrors } from 'vs/workbench/parts/tasks/common/taskSystem';
import { VIEWLET_ID as EXPLORER_VIEWLET_ID } from 'vs/workbench/parts/files/common/files';
import { IViewletService } from 'vs/workbench/services/viewlet/common/viewletService';
import { IPanelService } from 'vs/workbench/services/panel/common/panelService';
import { IPartService } from 'vs/workbench/services/part/common/partService';
import { ITextFileService } from 'vs/workbench/services/textfile/common/textfiles';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { IWorkbenchEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IWindowIPCService, IBroadcast } from 'vs/workbench/services/window/electron-browser/windowService';
import { ILogEntry, EXTENSION_LOG_BROADCAST_CHANNEL, EXTENSION_ATTACH_BROADCAST_CHANNEL, EXTENSION_TERMINATE_BROADCAST_CHANNEL } from 'vs/workbench/electron-browser/extensionHost';
import { ipcRenderer as ipc } from 'electron';

const DEBUG_BREAKPOINTS_KEY = 'debug.breakpoint';
const DEBUG_BREAKPOINTS_ACTIVATED_KEY = 'debug.breakpointactivated';
const DEBUG_FUNCTION_BREAKPOINTS_KEY = 'debug.functionbreakpoint';
const DEBUG_EXCEPTION_BREAKPOINTS_KEY = 'debug.exceptionbreakpoint';
const DEBUG_WATCH_EXPRESSIONS_KEY = 'debug.watchexpressions';
const DEBUG_SELECTED_CONFIG_NAME_KEY = 'debug.selectedconfigname';

export class DebugService implements debug.IDebugService {
	public _serviceBrand: any;

	private sessionStates: { [id: string]: debug.State };
	private _onDidChangeState: Emitter<void>;
	private model: Model;
	private viewModel: ViewModel;
	private configurationManager: ConfigurationManager;
	private customTelemetryService: ITelemetryService;
	private lastTaskEvent: TaskEvent;
	private toDispose: lifecycle.IDisposable[];
	private toDisposeOnSessionEnd: { [id: string]: lifecycle.IDisposable[] };
	private inDebugMode: IContextKey<boolean>;
	private breakpointsToSendOnResourceSaved: { [uri: string]: boolean };

	constructor(
		@IStorageService private storageService: IStorageService,
		@IWorkbenchEditorService private editorService: IWorkbenchEditorService,
		@ITextFileService private textFileService: ITextFileService,
		@IViewletService private viewletService: IViewletService,
		@IPanelService private panelService: IPanelService,
		@IFileService private fileService: IFileService,
		@IMessageService private messageService: IMessageService,
		@IPartService private partService: IPartService,
		@IWindowIPCService private windowService: IWindowIPCService,
		@ITelemetryService private telemetryService: ITelemetryService,
		@IWorkspaceContextService private contextService: IWorkspaceContextService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IEditorGroupService private editorGroupService: IEditorGroupService,
		@IEventService eventService: IEventService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IExtensionService private extensionService: IExtensionService,
		@IMarkerService private markerService: IMarkerService,
		@ITaskService private taskService: ITaskService,
		@IConfigurationService private configurationService: IConfigurationService
	) {
		this.toDispose = [];
		this.toDisposeOnSessionEnd = {};
		this.breakpointsToSendOnResourceSaved = {};
		this._onDidChangeState = new Emitter<void>();
		this.sessionStates = {};

		this.configurationManager = this.instantiationService.createInstance(ConfigurationManager);
		this.inDebugMode = debug.CONTEXT_IN_DEBUG_MODE.bindTo(contextKeyService);

		this.model = new Model(this.loadBreakpoints(), this.storageService.getBoolean(DEBUG_BREAKPOINTS_ACTIVATED_KEY, StorageScope.WORKSPACE, true), this.loadFunctionBreakpoints(),
			this.loadExceptionBreakpoints(), this.loadWatchExpressions());
		this.toDispose.push(this.model);
		this.viewModel = new ViewModel(this.storageService.get(DEBUG_SELECTED_CONFIG_NAME_KEY, StorageScope.WORKSPACE, null));

		this.registerListeners(eventService, lifecycleService);
	}

	private registerListeners(eventService: IEventService, lifecycleService: ILifecycleService): void {
		this.toDispose.push(eventService.addListener2(EventType.FILE_CHANGES, (e: FileChangesEvent) => this.onFileChanges(e)));

		if (this.taskService) {
			this.toDispose.push(this.taskService.addListener2(TaskServiceEvents.Active, (e: TaskEvent) => {
				this.lastTaskEvent = e;
			}));
			this.toDispose.push(this.taskService.addListener2(TaskServiceEvents.Inactive, (e: TaskEvent) => {
				if (e.type === TaskType.SingleRun) {
					this.lastTaskEvent = null;
				}
			}));
			this.toDispose.push(this.taskService.addListener2(TaskServiceEvents.Terminated, (e: TaskEvent) => {
				this.lastTaskEvent = null;
			}));
		}

		lifecycleService.onShutdown(this.store, this);
		lifecycleService.onShutdown(this.dispose, this);

		this.toDispose.push(this.windowService.onBroadcast(this.onBroadcast, this));
	}

	private onBroadcast(broadcast: IBroadcast): void {

		// attach: PH is ready to be attached to
		// TODO@Isidor this is a hack to just get any 'extensionHost' session.
		// Optimally the broadcast would contain the id of the session
		// We are only intersted if we have an active debug session for extensionHost
		const session = <RawDebugSession>this.model.getProcesses().map(p => p.session).filter(s => s.configuration.type === 'extensionHost').pop();
		if (broadcast.channel === EXTENSION_ATTACH_BROADCAST_CHANNEL) {
			this.rawAttach(session, broadcast.payload.port);
			return;
		}

		if (broadcast.channel === EXTENSION_TERMINATE_BROADCAST_CHANNEL) {
			this.onSessionEnd(session);
			return;
		}

		// from this point on we require an active session
		if (!session) {
			return;
		}

		// a plugin logged output, show it inside the REPL
		if (broadcast.channel === EXTENSION_LOG_BROADCAST_CHANNEL) {
			let extensionOutput: ILogEntry = broadcast.payload;
			let sev = extensionOutput.severity === 'warn' ? severity.Warning : extensionOutput.severity === 'error' ? severity.Error : severity.Info;

			let args: any[] = [];
			try {
				let parsed = JSON.parse(extensionOutput.arguments);
				args.push(...Object.getOwnPropertyNames(parsed).map(o => parsed[o]));
			} catch (error) {
				args.push(extensionOutput.arguments);
			}

			// add output for each argument logged
			let simpleVals: any[] = [];
			for (let i = 0; i < args.length; i++) {
				let a = args[i];

				// undefined gets printed as 'undefined'
				if (typeof a === 'undefined') {
					simpleVals.push('undefined');
				}

				// null gets printed as 'null'
				else if (a === null) {
					simpleVals.push('null');
				}

				// objects & arrays are special because we want to inspect them in the REPL
				else if (isObject(a) || Array.isArray(a)) {

					// flush any existing simple values logged
					if (simpleVals.length) {
						this.logToRepl(simpleVals.join(' '), sev);
						simpleVals = [];
					}

					// show object
					this.logToRepl(a, sev);
				}

				// string: watch out for % replacement directive
				// string substitution and formatting @ https://developer.chrome.com/devtools/docs/console
				else if (typeof a === 'string') {
					let buf = '';

					for (let j = 0, len = a.length; j < len; j++) {
						if (a[j] === '%' && (a[j + 1] === 's' || a[j + 1] === 'i' || a[j + 1] === 'd')) {
							i++; // read over substitution
							buf += !isUndefinedOrNull(args[i]) ? args[i] : ''; // replace
							j++; // read over directive
						} else {
							buf += a[j];
						}
					}

					simpleVals.push(buf);
				}

				// number or boolean is joined together
				else {
					simpleVals.push(a);
				}
			}

			// flush simple values
			if (simpleVals.length) {
				this.logToRepl(simpleVals.join(' '), sev);
			}
		}
	}

	private registerSessionListeners(session: RawDebugSession): void {
		this.toDisposeOnSessionEnd[session.getId()].push(session);
		this.toDisposeOnSessionEnd[session.getId()].push(session.onDidInitialize(event => {
			aria.status(nls.localize('debuggingStarted', "Debugging started."));
			const sendConfigurationDone = () => {
				if (session && session.configuration.capabilities.supportsConfigurationDoneRequest) {
					session.configurationDone().done(null, e => {
						// Disconnect the debug session on configuration done error #10596
						if (session) {
							session.disconnect().done(null, errors.onUnexpectedError);
						}
						this.messageService.show(severity.Error, e.message);
					});
				}
			};
			const process = this.model.getProcesses().filter(p => p.getId() === session.getId()).pop();
			this.sendAllBreakpoints(process).done(sendConfigurationDone, sendConfigurationDone);
		}));

		this.toDisposeOnSessionEnd[session.getId()].push(session.onDidStop(event => {
			this.setStateAndEmit(session.getId(), debug.State.Stopped);
			const threadId = event.body.threadId;

			session.threads().then(response => {
				if (!response || !response.body || !response.body.threads) {
					return;
				}

				const rawThread = response.body.threads.filter(t => t.id === threadId).pop();
				this.model.rawUpdate({
					sessionId: session.getId(),
					thread: rawThread,
					threadId,
					stoppedDetails: event.body,
					allThreadsStopped: event.body.allThreadsStopped
				});

				const process = this.model.getProcesses().filter(p => p.getId() === session.getId()).pop();
				const thread = process && process.getThread(threadId);
				if (thread) {
					thread.getCallStack().then(callStack => {
						if (callStack.length > 0) {
							// focus first stack frame from top that has source location
							const stackFrameToFocus = first(callStack, sf => sf.source && sf.source.available, callStack[0]);
							this.setFocusedStackFrameAndEvaluate(stackFrameToFocus).done(null, errors.onUnexpectedError);
							this.windowService.getWindow().focus();
							aria.alert(nls.localize('debuggingPaused', "Debugging paused, reason {0}, {1} {2}", event.body.reason, stackFrameToFocus.source ? stackFrameToFocus.source.name : '', stackFrameToFocus.lineNumber));

							return this.openOrRevealSource(stackFrameToFocus.source, stackFrameToFocus.lineNumber, false, false);
						} else {
							this.setFocusedStackFrameAndEvaluate(null).done(null, errors.onUnexpectedError);
						}
					});
				}
			}, errors.onUnexpectedError);
		}));

		this.toDisposeOnSessionEnd[session.getId()].push(session.onDidThread(event => {
			if (event.body.reason === 'started') {
				session.threads().done(response => {
					if (response && response.body && response.body.threads) {
						response.body.threads.forEach(thread =>
							this.model.rawUpdate({
								sessionId: session.getId(),
								threadId: thread.id,
								thread
							}));
					}
				}, errors.onUnexpectedError);
			} else if (event.body.reason === 'exited') {
				this.model.clearThreads(session.getId(), true, event.body.threadId);
			}
		}));

		this.toDisposeOnSessionEnd[session.getId()].push(session.onDidTerminateDebugee(event => {
			aria.status(nls.localize('debuggingStopped', "Debugging stopped."));
			if (session && session.getId() === event.body.sessionId) {
				if (event.body && typeof event.body.restart === 'boolean' && event.body.restart) {
					const process = this.model.getProcesses().filter(p => p.getId() === session.getId()).pop();
					this.restartProcess(process).done(null, err => this.messageService.show(severity.Error, err.message));
				} else {
					session.disconnect().done(null, errors.onUnexpectedError);
				}
			}
		}));

		this.toDisposeOnSessionEnd[session.getId()].push(session.onDidContinued(event => {
			this.transitionToRunningState(session, event.body.allThreadsContinued ? undefined : event.body.threadId);
		}));

		this.toDisposeOnSessionEnd[session.getId()].push(session.onDidOutput(event => {
			if (event.body && event.body.category === 'telemetry') {
				// only log telemetry events from debug adapter if the adapter provided the telemetry key
				// and the user opted in telemetry
				if (this.customTelemetryService && this.telemetryService.isOptedIn) {
					this.customTelemetryService.publicLog(event.body.output, event.body.data);
				}
			} else if (event.body && typeof event.body.output === 'string' && event.body.output.length > 0) {
				this.onOutput(event);
			}
		}));

		this.toDisposeOnSessionEnd[session.getId()].push(session.onDidBreakpoint(event => {
			const id = event.body && event.body.breakpoint ? event.body.breakpoint.id : undefined;
			const breakpoint = this.model.getBreakpoints().filter(bp => bp.idFromAdapter === id).pop();
			if (breakpoint) {
				this.model.updateBreakpoints({ [breakpoint.getId()]: event.body.breakpoint });
			} else {
				const functionBreakpoint = this.model.getFunctionBreakpoints().filter(bp => bp.idFromAdapter === id).pop();
				if (functionBreakpoint) {
					this.model.updateFunctionBreakpoints({ [functionBreakpoint.getId()]: event.body.breakpoint });
				}
			}
		}));

		this.toDisposeOnSessionEnd[session.getId()].push(session.onDidExitAdapter(event => {
			// 'Run without debugging' mode VSCode must terminate the extension host. More details: #3905
			if (session && session.configuration.type === 'extensionHost' && this.sessionStates[session.getId()] === debug.State.RunningNoDebug) {
				ipc.send('vscode:closeExtensionHostWindow', this.contextService.getWorkspace().resource.fsPath);
			}
			if (session && session.getId() === event.body.sessionId) {
				this.onSessionEnd(session);
			}
		}));
	}

	private onOutput(event: DebugProtocol.OutputEvent): void {
		const outputSeverity = event.body.category === 'stderr' ? severity.Error : event.body.category === 'console' ? severity.Warning : severity.Info;
		this.appendReplOutput(event.body.output, outputSeverity);
	}

	private loadBreakpoints(): Breakpoint[] {
		let result: Breakpoint[];
		try {
			result = JSON.parse(this.storageService.get(DEBUG_BREAKPOINTS_KEY, StorageScope.WORKSPACE, '[]')).map((breakpoint: any) => {
				return new Breakpoint(uri.parse(breakpoint.uri.external || breakpoint.source.uri.external), breakpoint.desiredLineNumber || breakpoint.lineNumber, breakpoint.enabled, breakpoint.condition, breakpoint.hitCondition);
			});
		} catch (e) { }

		return result || [];
	}

	private loadFunctionBreakpoints(): FunctionBreakpoint[] {
		let result: FunctionBreakpoint[];
		try {
			result = JSON.parse(this.storageService.get(DEBUG_FUNCTION_BREAKPOINTS_KEY, StorageScope.WORKSPACE, '[]')).map((fb: any) => {
				return new FunctionBreakpoint(fb.name, fb.enabled, fb.hitCondition);
			});
		} catch (e) { }

		return result || [];
	}

	private loadExceptionBreakpoints(): ExceptionBreakpoint[] {
		let result: ExceptionBreakpoint[];
		try {
			result = JSON.parse(this.storageService.get(DEBUG_EXCEPTION_BREAKPOINTS_KEY, StorageScope.WORKSPACE, '[]')).map((exBreakpoint: any) => {
				return new ExceptionBreakpoint(exBreakpoint.filter || exBreakpoint.name, exBreakpoint.label, exBreakpoint.enabled);
			});
		} catch (e) { }

		return result || [];
	}

	private loadWatchExpressions(): Expression[] {
		let result: Expression[];
		try {
			result = JSON.parse(this.storageService.get(DEBUG_WATCH_EXPRESSIONS_KEY, StorageScope.WORKSPACE, '[]')).map((watchStoredData: { name: string, id: string }) => {
				return new Expression(watchStoredData.name, watchStoredData.id);
			});
		} catch (e) { }

		return result || [];
	}

	public get state(): debug.State {
		if (!this.contextService.getWorkspace()) {
			return debug.State.Disabled;
		}

		const focusedProcess = this.viewModel.focusedProcess;
		if (focusedProcess) {
			return this.sessionStates[focusedProcess.getId()];
		}
		const processes = this.model.getProcesses();
		if (processes.length > 0) {
			return this.sessionStates[processes[0].getId()];
		}

		return debug.State.Inactive;
	}

	public get onDidChangeState(): Event<void> {
		return this._onDidChangeState.event;
	}

	private setStateAndEmit(sessionId: string, newState: debug.State): void {
		this.sessionStates[sessionId] = newState;
		this._onDidChangeState.fire();
	}

	public get enabled(): boolean {
		return !!this.contextService.getWorkspace();
	}

	public setFocusedStackFrameAndEvaluate(focusedStackFrame: debug.IStackFrame, process?: debug.IProcess): TPromise<void> {
		const processes = this.model.getProcesses();
		if (!process) {
			process = focusedStackFrame ? focusedStackFrame.thread.process : processes.length ? processes[0] : null;
		}
		if (process && !focusedStackFrame) {
			const thread = process.getAllThreads().pop();
			const callStack = thread ? thread.getCachedCallStack() : null;
			focusedStackFrame = callStack && callStack.length ? callStack[0] : null;
		}

		this.viewModel.setFocusedStackFrame(focusedStackFrame, process);
		this._onDidChangeState.fire();

		return this.model.evaluateWatchExpressions(process, focusedStackFrame);
	}

	public enableOrDisableBreakpoints(enable: boolean, breakpoint?: debug.IEnablement): TPromise<void> {
		if (breakpoint) {
			this.model.setEnablement(breakpoint, enable);
			if (breakpoint instanceof Breakpoint) {
				return this.sendBreakpoints(breakpoint.uri);
			} else if (breakpoint instanceof FunctionBreakpoint) {
				return this.sendFunctionBreakpoints();
			}

			return this.sendExceptionBreakpoints();
		}

		this.model.enableOrDisableAllBreakpoints(enable);
		return this.sendAllBreakpoints();
	}

	public addBreakpoints(uri: uri, rawBreakpoints: debug.IRawBreakpoint[]): TPromise<void> {
		this.model.addBreakpoints(uri, rawBreakpoints);
		rawBreakpoints.forEach(rbp => aria.status(nls.localize('breakpointAdded', "Added breakpoint, line {0}, file {1}", rbp.lineNumber, uri.fsPath)));

		return this.sendBreakpoints(uri);
	}

	public removeBreakpoints(id?: string): TPromise<any> {
		const toRemove = this.model.getBreakpoints().filter(bp => !id || bp.getId() === id);
		toRemove.forEach(bp => aria.status(nls.localize('breakpointRemoved', "Removed breakpoint, line {0}, file {1}", bp.lineNumber, bp.uri.fsPath)));
		const urisToClear = distinct(toRemove, bp => bp.uri.toString()).map(bp => bp.uri);

		this.model.removeBreakpoints(toRemove);
		return TPromise.join(urisToClear.map(uri => this.sendBreakpoints(uri)));
	}

	public setBreakpointsActivated(activated: boolean): TPromise<void> {
		this.model.setBreakpointsActivated(activated);
		return this.sendAllBreakpoints();
	}

	public addFunctionBreakpoint(): void {
		this.model.addFunctionBreakpoint('');
	}

	public renameFunctionBreakpoint(id: string, newFunctionName: string): TPromise<void> {
		this.model.updateFunctionBreakpoints({ [id]: { name: newFunctionName } });
		return this.sendFunctionBreakpoints();
	}

	public removeFunctionBreakpoints(id?: string): TPromise<void> {
		this.model.removeFunctionBreakpoints(id);
		return this.sendFunctionBreakpoints();
	}

	public addReplExpression(name: string): TPromise<void> {
		this.telemetryService.publicLog('debugService/addReplExpression');
		return this.model.addReplExpression(this.viewModel.focusedProcess, this.viewModel.focusedStackFrame, name)
			// Evaluate all watch expressions again since repl evaluation might have changed some.
			.then(() => this.setFocusedStackFrameAndEvaluate(this.viewModel.focusedStackFrame));
	}

	public logToRepl(value: string | { [key: string]: any }, severity?: severity): void {
		this.model.logToRepl(value, severity);
	}

	public appendReplOutput(value: string, severity?: severity): void {
		this.model.appendReplOutput(value, severity);
	}

	public removeReplExpressions(): void {
		this.model.removeReplExpressions();
	}

	public addWatchExpression(name: string): TPromise<void> {
		return this.model.addWatchExpression(this.viewModel.focusedProcess, this.viewModel.focusedStackFrame, name);
	}

	public renameWatchExpression(id: string, newName: string): TPromise<void> {
		return this.model.renameWatchExpression(this.viewModel.focusedProcess, this.viewModel.focusedStackFrame, id, newName);
	}

	public moveWatchExpression(id: string, position: number): void {
		this.model.moveWatchExpression(id, position);
	}

	public removeWatchExpressions(id?: string): void {
		this.model.removeWatchExpressions(id);
	}

	public createProcess(configurationOrName: debug.IConfig | string): TPromise<any> {
		this.removeReplExpressions();
		const sessionId = generateUuid();
		this.setStateAndEmit(sessionId, debug.State.Initializing);

		return this.textFileService.saveAll()							// make sure all dirty files are saved
			.then(() => this.configurationService.reloadConfiguration()	// make sure configuration is up to date
				.then(() => this.extensionService.onReady()
					.then(() => this.configurationManager.getConfiguration(configurationOrName)
						.then(configuration => {
							if (!configuration) {
								return this.configurationManager.openConfigFile(false).then(openend => {
									if (openend) {
										this.messageService.show(severity.Info, nls.localize('NewLaunchConfig', "Please set up the launch configuration file for your application."));
									}
								});
							}
							if (configuration.silentlyAbort) {
								return;
							}
							if (strings.equalsIgnoreCase(configuration.type, 'composite') && configuration.configurationNames) {
								return TPromise.join(configuration.configurationNames.map(name => this.createProcess(name)));
							}

							if (!this.configurationManager.getAdapter(configuration.type)) {
								return configuration.type ? TPromise.wrapError(new Error(nls.localize('debugTypeNotSupported', "Configured debug type '{0}' is not supported.", configuration.type)))
									: TPromise.wrapError(errors.create(nls.localize('debugTypeMissing', "Missing property 'type' for the chosen launch configuration."),
										{ actions: [this.instantiationService.createInstance(debugactions.ConfigureAction, debugactions.ConfigureAction.ID, debugactions.ConfigureAction.LABEL), CloseAction] }));
							}

							return this.runPreLaunchTask(configuration.preLaunchTask).then((taskSummary: ITaskSummary) => {
								const errorCount = configuration.preLaunchTask ? this.markerService.getStatistics().errors : 0;
								const successExitCode = taskSummary && taskSummary.exitCode === 0;
								const failureExitCode = taskSummary && taskSummary.exitCode !== undefined && taskSummary.exitCode !== 0;
								if (successExitCode || (errorCount === 0 && !failureExitCode)) {
									return this.doCreateProcess(sessionId, configuration);
								}

								this.messageService.show(severity.Error, {
									message: errorCount > 1 ? nls.localize('preLaunchTaskErrors', "Build errors have been detected during preLaunchTask '{0}'.", configuration.preLaunchTask) :
										errorCount === 1 ? nls.localize('preLaunchTaskError', "Build error has been detected during preLaunchTask '{0}'.", configuration.preLaunchTask) :
											nls.localize('preLaunchTaskExitCode', "The preLaunchTask '{0}' terminated with exit code {1}.", configuration.preLaunchTask, taskSummary.exitCode),
									actions: [new Action('debug.continue', nls.localize('debugAnyway', "Debug Anyway"), null, true, () => {
										this.messageService.hideAll();
										return this.doCreateProcess(sessionId, configuration);
									}), CloseAction]
								});
							}, (err: TaskError) => {
								if (err.code !== TaskErrors.NotConfigured) {
									throw err;
								}

								this.messageService.show(err.severity, {
									message: err.message,
									actions: [this.taskService.configureAction(), CloseAction]
								});
							});
						}))));
	}

	private doCreateProcess(sessionId: string, configuration: debug.IConfig): TPromise<any> {

		return this.telemetryService.getTelemetryInfo().then(info => {
			const telemetryInfo: { [key: string]: string } = Object.create(null);
			telemetryInfo['common.vscodemachineid'] = info.machineId;
			telemetryInfo['common.vscodesessionid'] = info.sessionId;
			return telemetryInfo;
		}).then(data => {
			const adapter = this.configurationManager.getAdapter(configuration.type);
			const { aiKey, type } = adapter;
			const publisher = adapter.extensionDescription.publisher;
			this.customTelemetryService = null;
			let client: TelemetryClient;

			if (aiKey) {
				client = new TelemetryClient(
					uri.parse(require.toUrl('bootstrap')).fsPath,
					{
						serverName: 'Debug Telemetry',
						timeout: 1000 * 60 * 5,
						args: [`${publisher}.${type}`, JSON.stringify(data), aiKey],
						env: {
							ELECTRON_RUN_AS_NODE: 1,
							PIPE_LOGGING: 'true',
							AMD_ENTRYPOINT: 'vs/workbench/parts/debug/node/telemetryApp'
						}
					}
				);

				const channel = client.getChannel('telemetryAppender');
				const appender = new TelemetryAppenderClient(channel);

				this.customTelemetryService = new TelemetryService({ appender }, this.configurationService);
			}

			const session = this.instantiationService.createInstance(RawDebugSession, sessionId, configuration.debugServer, adapter, this.customTelemetryService);
			const process = this.model.addProcess(configuration.name, session);

			if (!this.viewModel.focusedProcess) {
				this.viewModel.setFocusedStackFrame(null, process);
				this._onDidChangeState.fire();
			}
			this.toDisposeOnSessionEnd[session.getId()] = [];
			if (client) {
				this.toDisposeOnSessionEnd[session.getId()].push(client);
			}
			this.registerSessionListeners(session);

			return session.initialize({
				adapterID: configuration.type,
				pathFormat: 'path',
				linesStartAt1: true,
				columnsStartAt1: true,
				supportsVariableType: true, // #8858
				supportsVariablePaging: true, // #9537
				supportsRunInTerminalRequest: true // #10574
			}).then((result: DebugProtocol.InitializeResponse) => {
				if (session.disconnected) {
					return TPromise.wrapError(new Error(nls.localize('debugAdapterCrash', "Debug adapter process has terminated unexpectedly")));
				}

				this.model.setExceptionBreakpoints(session.configuration.capabilities.exceptionBreakpointFilters);
				return configuration.request === 'attach' ? session.attach(configuration) : session.launch(configuration);
			}).then((result: DebugProtocol.Response) => {
				if (session.disconnected) {
					return TPromise.as(null);
				}

				if (configuration.internalConsoleOptions === 'openOnSessionStart' || (!this.viewModel.changedWorkbenchViewState && configuration.internalConsoleOptions !== 'neverOpen')) {
					this.panelService.openPanel(debug.REPL_ID, false).done(undefined, errors.onUnexpectedError);
				}

				if (!this.viewModel.changedWorkbenchViewState && !this.partService.isSideBarHidden()) {
					// We only want to change the workbench view state on the first debug session #5738 and if the side bar is not hidden
					this.viewModel.changedWorkbenchViewState = true;
					this.viewletService.openViewlet(debug.VIEWLET_ID);
				}

				// Do not change status bar to orange if we are just running without debug.
				if (!configuration.noDebug) {
					this.partService.addClass('debugging');
				}
				this.extensionService.activateByEvent(`onDebug:${configuration.type}`).done(null, errors.onUnexpectedError);
				this.inDebugMode.set(true);
				this.transitionToRunningState(session);

				this.telemetryService.publicLog('debugSessionStart', {
					type: configuration.type,
					breakpointCount: this.model.getBreakpoints().length,
					exceptionBreakpoints: this.model.getExceptionBreakpoints(),
					watchExpressionsCount: this.model.getWatchExpressions().length,
					extensionName: `${adapter.extensionDescription.publisher}.${adapter.extensionDescription.name}`,
					isBuiltin: adapter.extensionDescription.isBuiltin
				});
			}).then(undefined, (error: any) => {
				if (error instanceof Error && error.message === 'Canceled') {
					// Do not show 'canceled' error messages to the user #7906
					return TPromise.as(null);
				}

				this.telemetryService.publicLog('debugMisconfiguration', { type: configuration ? configuration.type : undefined });
				this.setStateAndEmit(session.getId(), debug.State.Inactive);
				if (!session.disconnected) {
					session.disconnect().done(null, errors.onUnexpectedError);
				}
				// Show the repl if some error got logged there #5870
				if (this.model.getReplElements().length > 0) {
					this.panelService.openPanel(debug.REPL_ID, false).done(undefined, errors.onUnexpectedError);
				}

				const configureAction = this.instantiationService.createInstance(debugactions.ConfigureAction, debugactions.ConfigureAction.ID, debugactions.ConfigureAction.LABEL);
				const actions = (error.actions && error.actions.length) ? error.actions.concat([configureAction]) : [CloseAction, configureAction];
				return TPromise.wrapError(errors.create(error.message, { actions }));
			});
		});
	}

	private runPreLaunchTask(taskName: string): TPromise<ITaskSummary> {
		if (!taskName) {
			return TPromise.as(null);
		}

		// run a task before starting a debug session
		return this.taskService.tasks().then(descriptions => {
			const filteredTasks = descriptions.filter(task => task.name === taskName);
			if (filteredTasks.length !== 1) {
				return TPromise.wrapError(errors.create(nls.localize('DebugTaskNotFound', "Could not find the preLaunchTask \'{0}\'.", taskName), {
					actions: [
						this.instantiationService.createInstance(debugactions.ConfigureAction, debugactions.ConfigureAction.ID, debugactions.ConfigureAction.LABEL),
						this.taskService.configureAction(),
						CloseAction
					]
				}));
			}

			// task is already running - nothing to do.
			if (this.lastTaskEvent && this.lastTaskEvent.taskName === taskName) {
				return TPromise.as(null);
			}

			if (this.lastTaskEvent) {
				// there is a different task running currently.
				return TPromise.wrapError(errors.create(nls.localize('differentTaskRunning', "There is a task {0} running. Can not run pre launch task {1}.", this.lastTaskEvent.taskName, taskName)));
			}

			// no task running, execute the preLaunchTask.
			const taskPromise = this.taskService.run(filteredTasks[0].id).then(result => {
				this.lastTaskEvent = null;
				return result;
			}, err => {
				this.lastTaskEvent = null;
			});

			if (filteredTasks[0].isWatching) {
				return new TPromise((c, e) => this.taskService.addOneTimeDisposableListener(TaskServiceEvents.Inactive, () => c(null)));
			}

			return taskPromise;
		});
	}

	private rawAttach(session: RawDebugSession, port: number): TPromise<any> {
		if (session) {
			return session.attach({ port });
		}

		const sessionId = generateUuid();
		this.setStateAndEmit(sessionId, debug.State.Initializing);
		return this.configurationManager.getConfiguration(this.viewModel.selectedConfigurationName).then(config =>
			this.doCreateProcess(sessionId, config)
		);
	}

	public restartProcess(process: debug.IProcess): TPromise<any> {
		return process ? process.session.disconnect(true).then(() =>
			new TPromise<void>((c, e) => {
				setTimeout(() => {
					this.createProcess(process.name).then(() => c(null), err => e(err));
				}, 300);
			})
		) : this.createProcess(this.viewModel.selectedConfigurationName);
	}

	private onSessionEnd(session: RawDebugSession): void {
		if (session) {
			const bpsExist = this.model.getBreakpoints().length > 0;
			this.telemetryService.publicLog('debugSessionStop', {
				type: session.configuration.type,
				success: session.emittedStopped || !bpsExist,
				sessionLengthInSeconds: session.getLengthInSeconds(),
				breakpointCount: this.model.getBreakpoints().length,
				watchExpressionsCount: this.model.getWatchExpressions().length
			});
		}

		try {
			this.toDisposeOnSessionEnd[session.getId()] = lifecycle.dispose(this.toDisposeOnSessionEnd[session.getId()]);
		} catch (e) {
			// an internal module might be open so the dispose can throw -> ignore and continue with stop session.
		}

		this.model.removeProcess(session.getId());
		this.setFocusedStackFrameAndEvaluate(null).done(null, errors.onUnexpectedError);
		this.setStateAndEmit(session.getId(), debug.State.Inactive);

		if (this.model.getProcesses().length === 0) {
			this.partService.removeClass('debugging');
			// set breakpoints back to unverified since the session ended.
			const data: { [id: string]: { line: number, verified: boolean } } = {};
			this.model.getBreakpoints().forEach(bp => {
				data[bp.getId()] = { line: bp.lineNumber, verified: false };
			});
			this.model.updateBreakpoints(data);

			this.inDebugMode.reset();

			if (!this.partService.isSideBarHidden() && this.configurationService.getConfiguration<debug.IDebugConfiguration>('debug').openExplorerOnEnd) {
				this.viewletService.openViewlet(EXPLORER_VIEWLET_ID).done(null, errors.onUnexpectedError);
			}
		}
	}

	public getModel(): debug.IModel {
		return this.model;
	}

	public getViewModel(): debug.IViewModel {
		return this.viewModel;
	}

	public openOrRevealSource(sourceOrUri: Source | uri, lineNumber: number, preserveFocus: boolean, sideBySide: boolean): TPromise<any> {
		const visibleEditors = this.editorService.getVisibleEditors();
		const uri = sourceOrUri instanceof Source ? sourceOrUri.uri : sourceOrUri;
		const source = sourceOrUri instanceof Source ? sourceOrUri : null;
		for (let i = 0; i < visibleEditors.length; i++) {
			const fileInput = asFileEditorInput(visibleEditors[i].input);
			if ((fileInput && fileInput.getResource().toString() === uri.toString()) ||
				(visibleEditors[i].input instanceof DebugStringEditorInput && (<DebugStringEditorInput>visibleEditors[i].input).getResource().toString() === uri.toString())) {

				const control = <ICodeEditor>visibleEditors[i].getControl();
				if (control) {
					control.revealLineInCenterIfOutsideViewport(lineNumber);
					control.setSelection({ startLineNumber: lineNumber, startColumn: 1, endLineNumber: lineNumber, endColumn: 1 });
					this.editorGroupService.activateGroup(i);
					if (!preserveFocus) {
						this.editorGroupService.focusGroup(i);
					}
				}

				return TPromise.as(null);
			}
		}

		const process = this.viewModel.focusedProcess;
		if (process && source && source.inMemory) {
			// internal module
			if (source.reference !== 0 && source.available) {
				return process.session.source({ sourceReference: source.reference }).then(response => {
					const mime = response && response.body && response.body.mimeType ? response.body.mimeType : guessMimeTypes(source.name)[0];
					const inputValue = response && response.body ? response.body.content : '';
					return this.getDebugStringEditorInput(process, source, inputValue, mime);
				}, (err: DebugProtocol.ErrorResponse) => {
					// Display the error from debug adapter using a temporary editor #8836
					return this.getDebugErrorEditorInput(process, source, err.message);
				}).then(editorInput => {
					return this.editorService.openEditor(editorInput, { preserveFocus, selection: { startLineNumber: lineNumber, startColumn: 1, endLineNumber: lineNumber, endColumn: 1 } }, sideBySide);
				});
			}

			return this.sourceIsUnavailable(process, source, sideBySide);
		}
		if (Source.isInMemory(uri)) {
			return TPromise.as(null);
		}

		return this.fileService.resolveFile(uri).then(() =>
			this.editorService.openEditor({
				resource: uri,
				options: {
					selection: {
						startLineNumber: lineNumber,
						startColumn: 1,
						endLineNumber: lineNumber,
						endColumn: 1
					},
					preserveFocus: preserveFocus
				}
			}, sideBySide), err => this.sourceIsUnavailable(process, source, sideBySide)
		);
	}

	private sourceIsUnavailable(process: debug.IProcess, source: Source, sideBySide: boolean): TPromise<any> {
		this.model.sourceIsUnavailable(source);
		const editorInput = this.getDebugErrorEditorInput(process, source, nls.localize('debugSourceNotAvailable', "Source {0} is not available.", source.name));

		return this.editorService.openEditor(editorInput, { preserveFocus: true }, sideBySide);
	}

	public getConfigurationManager(): debug.IConfigurationManager {
		return this.configurationManager;
	}

	private transitionToRunningState(session: RawDebugSession, threadId?: number): void {
		this.model.clearThreads(session.getId(), false, threadId);
		this.setStateAndEmit(session.getId(), session.requestType === debug.SessionRequestType.LAUNCH_NO_DEBUG ? debug.State.RunningNoDebug : debug.State.Running);
		this.setFocusedStackFrameAndEvaluate(null).done(null, errors.onUnexpectedError);
	}

	private getDebugStringEditorInput(process: debug.IProcess, source: Source, value: string, mtype: string): DebugStringEditorInput {
		const result = this.instantiationService.createInstance(DebugStringEditorInput, source.name, source.uri, source.origin, value, mtype, void 0);
		this.toDisposeOnSessionEnd[process.getId()].push(result);

		return result;
	}

	private getDebugErrorEditorInput(process: debug.IProcess, source: Source, value: string): DebugErrorEditorInput {
		const result = this.instantiationService.createInstance(DebugErrorEditorInput, source.name, value);
		this.toDisposeOnSessionEnd[process.getId()].push(result);

		return result;
	}

	private sendAllBreakpoints(process?: debug.IProcess): TPromise<any> {
		return TPromise.join(distinct(this.model.getBreakpoints(), bp => bp.uri.toString()).map(bp => this.sendBreakpoints(bp.uri, false, process)))
			.then(() => this.sendFunctionBreakpoints(process))
			// send exception breakpoints at the end since some debug adapters rely on the order
			.then(() => this.sendExceptionBreakpoints(process));
	}

	private sendBreakpoints(modelUri: uri, sourceModified = false, targetProcess?: debug.IProcess): TPromise<void> {

		const sendBreakpointsToProcess = (process: debug.IProcess): TPromise<void> => {
			const session = <RawDebugSession>process.session;
			if (!session.readyForBreakpoints) {
				return TPromise.as(null);
			}
			if (this.textFileService.isDirty(modelUri)) {
				// Only send breakpoints for a file once it is not dirty #8077
				this.breakpointsToSendOnResourceSaved[modelUri.toString()] = true;
				return TPromise.as(null);
			}

			const breakpointsToSend = distinct(
				this.model.getBreakpoints().filter(bp => this.model.areBreakpointsActivated() && bp.enabled && bp.uri.toString() === modelUri.toString()),
				bp => `${bp.desiredLineNumber}`
			);

			let rawSource: DebugProtocol.Source;
			for (let t of process.getAllThreads()) {
				for (let sf of t.getCachedCallStack()) {
					if (sf.source.uri.toString() === modelUri.toString()) {
						rawSource = sf.source.raw;
						break;
					}
				}
			}
			rawSource = rawSource || { path: paths.normalize(modelUri.fsPath, true), name: paths.basename(modelUri.fsPath) };

			return session.setBreakpoints({
				source: rawSource,
				lines: breakpointsToSend.map(bp => bp.desiredLineNumber),
				breakpoints: breakpointsToSend.map(bp => ({ line: bp.desiredLineNumber, condition: bp.condition, hitCondition: bp.hitCondition })),
				sourceModified
			}).then(response => {
				if (!response || !response.body) {
					return;
				}

				const data: { [id: string]: { line?: number, verified: boolean } } = {};
				for (let i = 0; i < breakpointsToSend.length; i++) {
					data[breakpointsToSend[i].getId()] = response.body.breakpoints[i];
				}

				this.model.updateBreakpoints(data);
			});
		};

		return this.sendToOneOrAllProcesses(targetProcess, sendBreakpointsToProcess);
	}

	private sendFunctionBreakpoints(targetProcess?: debug.IProcess): TPromise<void> {
		const sendFunctionBreakpointsToProcess = (process: debug.IProcess): TPromise<void> => {
			const session = <RawDebugSession>process.session;
			if (!session.readyForBreakpoints || !session.configuration.capabilities.supportsFunctionBreakpoints) {
				return TPromise.as(null);
			}

			const breakpointsToSend = this.model.getFunctionBreakpoints().filter(fbp => fbp.enabled && this.model.areBreakpointsActivated());
			return session.setFunctionBreakpoints({ breakpoints: breakpointsToSend }).then(response => {
				if (!response || !response.body) {
					return;
				}

				const data: { [id: string]: { name?: string, verified?: boolean } } = {};
				for (let i = 0; i < breakpointsToSend.length; i++) {
					data[breakpointsToSend[i].getId()] = response.body.breakpoints[i];
				}

				this.model.updateFunctionBreakpoints(data);
			});
		};

		return this.sendToOneOrAllProcesses(targetProcess, sendFunctionBreakpointsToProcess);
	}

	private sendExceptionBreakpoints(targetProcess?: debug.IProcess): TPromise<void> {
		const sendExceptionBreakpointsToProcess = (process: debug.IProcess): TPromise<any> => {
			const session = <RawDebugSession>process.session;
			if (!session.readyForBreakpoints || this.model.getExceptionBreakpoints().length === 0) {
				return TPromise.as(null);
			}

			const enabledExceptionBps = this.model.getExceptionBreakpoints().filter(exb => exb.enabled);
			return session.setExceptionBreakpoints({ filters: enabledExceptionBps.map(exb => exb.filter) });
		};

		return this.sendToOneOrAllProcesses(targetProcess, sendExceptionBreakpointsToProcess);
	}

	private sendToOneOrAllProcesses(process: debug.IProcess, send: (process: debug.IProcess) => TPromise<void>): TPromise<void> {
		if (process) {
			return send(process);
		}

		return TPromise.join(this.model.getProcesses().map(p => send(p))).then(() => void 0);
	}

	private onFileChanges(fileChangesEvent: FileChangesEvent): void {
		this.model.removeBreakpoints(this.model.getBreakpoints().filter(bp =>
			fileChangesEvent.contains(bp.uri, FileChangeType.DELETED)));

		fileChangesEvent.getUpdated().forEach(event => {
			if (this.breakpointsToSendOnResourceSaved[event.resource.toString()]) {
				this.breakpointsToSendOnResourceSaved[event.resource.toString()] = false;
				this.sendBreakpoints(event.resource, true).done(null, errors.onUnexpectedError);
			}
		});

	}

	private store(): void {
		this.storageService.store(DEBUG_BREAKPOINTS_KEY, JSON.stringify(this.model.getBreakpoints()), StorageScope.WORKSPACE);
		this.storageService.store(DEBUG_BREAKPOINTS_ACTIVATED_KEY, this.model.areBreakpointsActivated() ? 'true' : 'false', StorageScope.WORKSPACE);
		this.storageService.store(DEBUG_FUNCTION_BREAKPOINTS_KEY, JSON.stringify(this.model.getFunctionBreakpoints()), StorageScope.WORKSPACE);
		this.storageService.store(DEBUG_EXCEPTION_BREAKPOINTS_KEY, JSON.stringify(this.model.getExceptionBreakpoints()), StorageScope.WORKSPACE);
		this.storageService.store(DEBUG_SELECTED_CONFIG_NAME_KEY, this.viewModel.selectedConfigurationName, StorageScope.WORKSPACE);
		this.storageService.store(DEBUG_WATCH_EXPRESSIONS_KEY, JSON.stringify(this.model.getWatchExpressions().map(we => ({ name: we.name, id: we.getId() }))), StorageScope.WORKSPACE);
	}

	public dispose(): void {
		Object.keys(this.toDisposeOnSessionEnd).forEach(key => lifecycle.dispose(this.toDisposeOnSessionEnd[key]));
		this.toDispose = lifecycle.dispose(this.toDispose);
	}
}
