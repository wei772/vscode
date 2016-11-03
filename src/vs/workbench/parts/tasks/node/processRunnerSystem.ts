/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as nls from 'vs/nls';
import * as Objects from 'vs/base/common/objects';
import * as Types from 'vs/base/common/types';
import * as Platform from 'vs/base/common/platform';
import { TPromise, Promise } from 'vs/base/common/winjs.base';
import * as Async from 'vs/base/common/async';
import Severity from 'vs/base/common/severity';
import * as Strings from 'vs/base/common/strings';
import { EventEmitter } from 'vs/base/common/eventEmitter';

import { TerminateResponse, SuccessData, ErrorData } from 'vs/base/common/processes';
import { LineProcess, LineData } from 'vs/base/node/processes';

import { IOutputService, IOutputChannel } from 'vs/workbench/parts/output/common/output';
import { IConfigurationResolverService } from 'vs/workbench/services/configurationResolver/common/configurationResolver';

import { IMarkerService } from 'vs/platform/markers/common/markers';
import { ValidationStatus } from 'vs/base/common/parsers';
import { IModelService } from 'vs/editor/common/services/modelService';
import { ProblemMatcher } from 'vs/platform/markers/common/problemMatcher';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';

import { StartStopProblemCollector, WatchingProblemCollector, ProblemCollectorEvents } from 'vs/workbench/parts/tasks/common/problemCollectors';
import { ITaskSystem, ITaskSummary, ITaskExecuteResult, TaskExecuteKind, TaskError, TaskErrors, TaskRunnerConfiguration, TaskDescription, CommandOptions, ShowOutput, TelemetryEvent, Triggers, TaskSystemEvents, TaskEvent, TaskType } from 'vs/workbench/parts/tasks/common/taskSystem';
import * as FileConfig from './processRunnerConfiguration';

import { IDisposable, dispose } from 'vs/base/common/lifecycle';

export class ProcessRunnerSystem extends EventEmitter implements ITaskSystem {

	public static TelemetryEventName: string = 'taskService';

	private fileConfig: FileConfig.ExternalTaskRunnerConfiguration;
	private markerService: IMarkerService;
	private modelService: IModelService;
	private outputService: IOutputService;
	private telemetryService: ITelemetryService;
	private configurationResolverService: IConfigurationResolverService;

	private validationStatus: ValidationStatus;
	private defaultBuildTaskIdentifier: string;
	private defaultTestTaskIdentifier: string;
	private configuration: TaskRunnerConfiguration;
	private outputChannel: IOutputChannel;

	private errorsShown: boolean;
	private childProcess: LineProcess;
	private activeTaskIdentifier: string;
	private activeTaskPromise: TPromise<ITaskSummary>;

	constructor(fileConfig: FileConfig.ExternalTaskRunnerConfiguration, markerService: IMarkerService, modelService: IModelService, telemetryService: ITelemetryService,
		outputService: IOutputService, configurationResolverService: IConfigurationResolverService, outputChannelId: string, clearOutput: boolean = true) {
		super();
		this.fileConfig = fileConfig;
		this.markerService = markerService;
		this.modelService = modelService;
		this.outputService = outputService;
		this.telemetryService = telemetryService;
		this.configurationResolverService = configurationResolverService;

		this.defaultBuildTaskIdentifier = null;
		this.defaultTestTaskIdentifier = null;
		this.childProcess = null;
		this.activeTaskIdentifier = null;
		this.activeTaskPromise = null;
		this.outputChannel = this.outputService.getChannel(outputChannelId);

		if (clearOutput) {
			this.clearOutput();
		}
		this.errorsShown = false;
		let parseResult = FileConfig.parse(fileConfig, this);
		this.validationStatus = parseResult.validationStatus;
		this.configuration = parseResult.configuration;
		this.defaultBuildTaskIdentifier = parseResult.defaultBuildTaskIdentifier;
		this.defaultTestTaskIdentifier = parseResult.defaultTestTaskIdentifier;

		if (!this.validationStatus.isOK()) {
			this.showOutput();
		}
	}


	public build(): ITaskExecuteResult {
		if (this.activeTaskIdentifier) {
			let task = this.configuration.tasks[this.activeTaskIdentifier];
			return { kind: TaskExecuteKind.Active, active: { same: this.activeTaskIdentifier === this.defaultBuildTaskIdentifier, watching: task.isWatching }, promise: this.activeTaskPromise };
		}
		if (!this.defaultBuildTaskIdentifier) {
			throw new TaskError(Severity.Info, nls.localize('TaskRunnerSystem.noBuildTask', 'No task is marked as a build task in the tasks.json. Mark a task with \'isBuildCommand\'.'), TaskErrors.NoBuildTask);
		}
		return this.executeTask(this.defaultBuildTaskIdentifier, Triggers.shortcut);
	}

	public rebuild(): ITaskExecuteResult {
		throw new Error('Task - Rebuild: not implemented yet');
	}

	public clean(): ITaskExecuteResult {
		throw new Error('Task - Clean: not implemented yet');
	}

	public runTest(): ITaskExecuteResult {
		if (this.activeTaskIdentifier) {
			let task = this.configuration.tasks[this.activeTaskIdentifier];
			return { kind: TaskExecuteKind.Active, active: { same: this.activeTaskIdentifier === this.defaultTestTaskIdentifier, watching: task.isWatching }, promise: this.activeTaskPromise };
		}
		if (!this.defaultTestTaskIdentifier) {
			throw new TaskError(Severity.Info, nls.localize('TaskRunnerSystem.noTestTask', 'No test task configured.'), TaskErrors.NoTestTask);
		}
		return this.executeTask(this.defaultTestTaskIdentifier, Triggers.shortcut);
	}

	public run(taskIdentifier: string): ITaskExecuteResult {
		if (this.activeTaskIdentifier) {
			let task = this.configuration.tasks[this.activeTaskIdentifier];
			return { kind: TaskExecuteKind.Active, active: { same: this.activeTaskIdentifier === taskIdentifier, watching: task.isWatching }, promise: this.activeTaskPromise };
		}
		return this.executeTask(taskIdentifier);
	}

	public isActive(): TPromise<boolean> {
		return TPromise.as(!!this.childProcess);
	}

	public isActiveSync(): boolean {
		return !!this.childProcess;
	}

	public canAutoTerminate(): boolean {
		if (this.childProcess) {
			if (this.activeTaskIdentifier) {
				let task = this.configuration.tasks[this.activeTaskIdentifier];
				if (task) {
					return !task.promptOnClose;
				}
			}
			return false;
		}
		return true;
	}

	public terminate(): TPromise<TerminateResponse> {
		if (this.childProcess) {
			return this.childProcess.terminate();
		}
		return TPromise.as({ success: true });
	}

	public tasks(): TPromise<TaskDescription[]> {
		let result: TaskDescription[];
		if (!this.configuration || !this.configuration.tasks) {
			result = [];
		} else {
			result = Object.keys(this.configuration.tasks).map(key => this.configuration.tasks[key]);
		}
		return TPromise.as(result);
	}

	private executeTask(taskIdentifier: string, trigger: string = Triggers.command): ITaskExecuteResult {
		if (this.validationStatus.isFatal()) {
			throw new TaskError(Severity.Error, nls.localize('TaskRunnerSystem.fatalError', 'The provided task configuration has validation errors. See tasks output log for details.'), TaskErrors.ConfigValidationError);
		}
		let task = this.configuration.tasks[taskIdentifier];
		if (!task) {
			throw new TaskError(Severity.Info, nls.localize('TaskRunnerSystem.norebuild', 'No task to execute found.'), TaskErrors.TaskNotFound);
		}
		let telemetryEvent: TelemetryEvent = {
			trigger: trigger,
			command: 'other',
			success: true
		};
		try {
			let result = this.doExecuteTask(task, telemetryEvent);
			result.promise = result.promise.then((success) => {
				this.telemetryService.publicLog(ProcessRunnerSystem.TelemetryEventName, telemetryEvent);
				return success;
			}, (err: any) => {
				telemetryEvent.success = false;
				this.telemetryService.publicLog(ProcessRunnerSystem.TelemetryEventName, telemetryEvent);
				return TPromise.wrapError<ITaskSummary>(err);
			});
			return result;
		} catch (err) {
			telemetryEvent.success = false;
			this.telemetryService.publicLog(ProcessRunnerSystem.TelemetryEventName, telemetryEvent);
			if (err instanceof TaskError) {
				throw err;
			} else if (err instanceof Error) {
				let error = <Error>err;
				this.outputChannel.append(error.message);
				throw new TaskError(Severity.Error, error.message, TaskErrors.UnknownError);
			} else {
				this.outputChannel.append(err.toString());
				throw new TaskError(Severity.Error, nls.localize('TaskRunnerSystem.unknownError', 'A unknown error has occurred while executing a task. See task output log for details.'), TaskErrors.UnknownError);
			}
		}
	}

	private doExecuteTask(task: TaskDescription, telemetryEvent: TelemetryEvent): ITaskExecuteResult {
		let taskSummary: ITaskSummary = {};
		let configuration = this.configuration;
		if (!this.validationStatus.isOK() && !this.errorsShown) {
			this.showOutput();
			this.errorsShown = true;
		} else {
			this.clearOutput();
		}

		let args: string[] = this.configuration.args ? this.configuration.args.slice() : [];
		// We need to first pass the task name
		if (!task.suppressTaskName) {
			if (this.fileConfig.taskSelector) {
				args.push(this.fileConfig.taskSelector + task.name);
			} else {
				args.push(task.name);
			}
		}
		// And then additional arguments
		if (task.args) {
			args = args.concat(task.args);
		}
		args = this.resolveVariables(args);
		let command: string = this.resolveVariable(configuration.command);
		this.childProcess = new LineProcess(command, args, configuration.isShellCommand, this.resolveOptions(configuration.options));
		telemetryEvent.command = this.childProcess.getSanitizedCommand();
		// we have no problem matchers defined. So show the output log
		if (task.showOutput === ShowOutput.Always || (task.showOutput === ShowOutput.Silent && task.problemMatchers.length === 0)) {
			this.showOutput();
		}

		if (task.echoCommand) {
			let prompt: string = Platform.isWindows ? '>' : '$';
			this.log(`running command${prompt} ${command} ${args.join(' ')}`);
		}
		if (task.isWatching) {
			let watchingProblemMatcher = new WatchingProblemCollector(this.resolveMatchers(task.problemMatchers), this.markerService, this.modelService);
			let toUnbind: IDisposable[] = [];
			let event: TaskEvent = { taskId: task.id, taskName: task.name, type: TaskType.Watching };
			let eventCounter: number = 0;
			toUnbind.push(watchingProblemMatcher.addListener2(ProblemCollectorEvents.WatchingBeginDetected, () => {
				eventCounter++;
				this.emit(TaskSystemEvents.Active, event);
			}));
			toUnbind.push(watchingProblemMatcher.addListener2(ProblemCollectorEvents.WatchingEndDetected, () => {
				eventCounter--;
				this.emit(TaskSystemEvents.Inactive, event);
			}));
			watchingProblemMatcher.aboutToStart();
			let delayer: Async.Delayer<any> = null;
			this.activeTaskIdentifier = task.id;
			this.activeTaskPromise = this.childProcess.start().then((success): ITaskSummary => {
				this.childProcessEnded();
				watchingProblemMatcher.dispose();
				toUnbind = dispose(toUnbind);
				toUnbind = null;
				for (let i = 0; i < eventCounter; i++) {
					this.emit(TaskSystemEvents.Inactive, event);
				}
				eventCounter = 0;
				if (!this.checkTerminated(task, success)) {
					this.log(nls.localize('TaskRunnerSystem.watchingBuildTaskFinished', '\nWatching build tasks has finished.'));
				}
				if (success.cmdCode && success.cmdCode === 1 && watchingProblemMatcher.numberOfMatches === 0 && task.showOutput !== ShowOutput.Never) {
					this.showOutput();
				}
				taskSummary.exitCode = success.cmdCode;
				return taskSummary;
			}, (error: ErrorData) => {
				this.childProcessEnded();
				watchingProblemMatcher.dispose();
				toUnbind = dispose(toUnbind);
				toUnbind = null;
				for (let i = 0; i < eventCounter; i++) {
					this.emit(TaskSystemEvents.Inactive, event);
				}
				eventCounter = 0;
				return this.handleError(task, error);
			}, (progress: LineData) => {
				let line = Strings.removeAnsiEscapeCodes(progress.line);
				this.outputChannel.append(line + '\n');
				watchingProblemMatcher.processLine(line);
				if (delayer === null) {
					delayer = new Async.Delayer(3000);
				}
				delayer.trigger(() => {
					watchingProblemMatcher.forceDelivery();
					return null;
				}).then(() => {
					delayer = null;
				});
			});
			let result: ITaskExecuteResult = (<any>task).tscWatch
				? { kind: TaskExecuteKind.Started, started: { restartOnFileChanges: '**/*.ts' }, promise: this.activeTaskPromise }
				: { kind: TaskExecuteKind.Started, started: {}, promise: this.activeTaskPromise };
			return result;
		} else {
			let event: TaskEvent = { taskId: task.id, taskName: task.name, type: TaskType.SingleRun };
			this.emit(TaskSystemEvents.Active, event);
			let startStopProblemMatcher = new StartStopProblemCollector(this.resolveMatchers(task.problemMatchers), this.markerService, this.modelService);
			this.activeTaskIdentifier = task.id;
			this.activeTaskPromise = this.childProcess.start().then((success): ITaskSummary => {
				this.childProcessEnded();
				startStopProblemMatcher.done();
				startStopProblemMatcher.dispose();
				this.checkTerminated(task, success);
				this.emit(TaskSystemEvents.Inactive, event);
				if (success.cmdCode && success.cmdCode === 1 && startStopProblemMatcher.numberOfMatches === 0 && task.showOutput !== ShowOutput.Never) {
					this.showOutput();
				}
				taskSummary.exitCode = success.cmdCode;
				return taskSummary;
			}, (error: ErrorData) => {
				this.childProcessEnded();
				startStopProblemMatcher.dispose();
				this.emit(TaskSystemEvents.Inactive, event);
				return this.handleError(task, error);
			}, (progress) => {
				let line = Strings.removeAnsiEscapeCodes(progress.line);
				this.outputChannel.append(line + '\n');
				startStopProblemMatcher.processLine(line);
			});
			return { kind: TaskExecuteKind.Started, started: {}, promise: this.activeTaskPromise };
		}
	}

	private childProcessEnded(): void {
		this.childProcess = null;
		this.activeTaskIdentifier = null;
		this.activeTaskPromise = null;
	}

	private handleError(task: TaskDescription, error: ErrorData): Promise {
		let makeVisible = false;
		if (error.error && !error.terminated) {
			let args: string = this.configuration.args ? this.configuration.args.join(' ') : '';
			this.log(nls.localize('TaskRunnerSystem.childProcessError', 'Failed to launch external program {0} {1}.', this.configuration.command, args));
			this.outputChannel.append(error.error.message);
			makeVisible = true;
		}

		if (error.stdout) {
			this.outputChannel.append(error.stdout);
			makeVisible = true;
		}
		if (error.stderr) {
			this.outputChannel.append(error.stderr);
			makeVisible = true;
		}
		makeVisible = this.checkTerminated(task, error) || makeVisible;
		if (makeVisible) {
			this.showOutput();
		}
		return Promise.wrapError(error);
	}

	private checkTerminated(task: TaskDescription, data: SuccessData | ErrorData): boolean {
		if (data.terminated) {
			this.log(nls.localize('TaskRunnerSystem.cancelRequested', '\nThe task \'{0}\' was terminated per user request.', task.name));
			return true;
		}
		return false;
	}

	private resolveOptions(options: CommandOptions): CommandOptions {
		let result: CommandOptions = { cwd: this.resolveVariable(options.cwd) };
		if (options.env) {
			result.env = Object.create(null);
			Object.keys(options.env).forEach((key) => {
				let value: any = options.env[key];
				if (Types.isString(value)) {
					result.env[key] = this.resolveVariable(value);
				} else {
					result.env[key] = value.toString();
				}
			});
		}
		return result;
	}

	private resolveVariables(value: string[]): string[] {
		return value.map(s => this.resolveVariable(s));
	}

	private resolveMatchers<T extends ProblemMatcher>(values: T[]): T[] {
		if (values.length === 0) {
			return values;
		}
		let result: T[] = [];
		values.forEach((matcher) => {
			if (!matcher.filePrefix) {
				result.push(matcher);
			} else {
				let copy = Objects.clone(matcher);
				copy.filePrefix = this.resolveVariable(copy.filePrefix);
				result.push(copy);
			}
		});
		return result;
	}

	private resolveVariable(value: string): string {
		return this.configurationResolverService.resolve(value);
	}

	public log(value: string): void {
		this.outputChannel.append(value + '\n');
	}

	private showOutput(): void {
		this.outputChannel.show(true);
	}

	private clearOutput(): void {
		this.outputChannel.clear();
	}
}