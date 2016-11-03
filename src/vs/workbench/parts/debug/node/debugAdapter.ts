/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import nls = require('vs/nls');
import { TPromise } from 'vs/base/common/winjs.base';
import strings = require('vs/base/common/strings');
import objects = require('vs/base/common/objects');
import paths = require('vs/base/common/paths');
import platform = require('vs/base/common/platform');
import debug = require('vs/workbench/parts/debug/common/debug');
import { IExtensionDescription } from 'vs/platform/extensions/common/extensions';
import { IConfigurationResolverService } from 'vs/workbench/services/configurationResolver/common/configurationResolver';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { ICommandService } from 'vs/platform/commands/common/commands';

export class Adapter {

	public runtime: string;
	public program: string;
	public runtimeArgs: string[];
	public args: string[];
	public type: string;
	private _label: string;
	private configurationAttributes: any;
	public initialConfigurations: any[] | string;
	public variables: { [key: string]: string };
	public enableBreakpointsFor: { languageIds: string[] };
	public aiKey: string;

	constructor(public rawAdapter: debug.IRawAdapter, public extensionDescription: IExtensionDescription,
		@IConfigurationResolverService configurationResolverService: IConfigurationResolverService,
		@IConfigurationService private configurationService: IConfigurationService,
		@ICommandService private commandService: ICommandService
	) {
		if (rawAdapter.windows) {
			rawAdapter.win = rawAdapter.windows;
		}

		if (platform.isWindows && !process.env.hasOwnProperty('PROCESSOR_ARCHITEW6432') && rawAdapter.winx86) {
			this.runtime = rawAdapter.winx86.runtime;
			this.runtimeArgs = rawAdapter.winx86.runtimeArgs;
			this.program = rawAdapter.winx86.program;
			this.args = rawAdapter.winx86.args;
		} else if (platform.isWindows && rawAdapter.win) {
			this.runtime = rawAdapter.win.runtime;
			this.runtimeArgs = rawAdapter.win.runtimeArgs;
			this.program = rawAdapter.win.program;
			this.args = rawAdapter.win.args;
		} else if (platform.isMacintosh && rawAdapter.osx) {
			this.runtime = rawAdapter.osx.runtime;
			this.runtimeArgs = rawAdapter.osx.runtimeArgs;
			this.program = rawAdapter.osx.program;
			this.args = rawAdapter.osx.args;
		} else if (platform.isLinux && rawAdapter.linux) {
			this.runtime = rawAdapter.linux.runtime;
			this.runtimeArgs = rawAdapter.linux.runtimeArgs;
			this.program = rawAdapter.linux.program;
			this.args = rawAdapter.linux.args;
		}

		this.runtime = this.runtime || rawAdapter.runtime;
		this.runtimeArgs = this.runtimeArgs || rawAdapter.runtimeArgs;
		this.program = this.program || rawAdapter.program;
		this.args = this.args || rawAdapter.args;

		if (this.program) {
			this.program = configurationResolverService ? configurationResolverService.resolve(this.program) : this.program;
			this.program = paths.join(extensionDescription.extensionFolderPath, this.program);
		}
		if (this.runtime && this.runtime.indexOf('./') === 0) {
			this.runtime = configurationResolverService ? configurationResolverService.resolve(this.runtime) : this.runtime;
			this.runtime = paths.join(extensionDescription.extensionFolderPath, this.runtime);
		}

		this.type = rawAdapter.type;
		this.variables = rawAdapter.variables;
		this.configurationAttributes = rawAdapter.configurationAttributes;
		this.initialConfigurations = rawAdapter.initialConfigurations;
		this._label = rawAdapter.label;
		this.enableBreakpointsFor = rawAdapter.enableBreakpointsFor;
		this.aiKey = rawAdapter.aiKey;
	}

	public getInitialConfigFileContent(): TPromise<string> {
		const editorConfig = this.configurationService.getConfiguration<any>();
		if (typeof this.initialConfigurations === 'string') {
			// Contributed initialConfigurations is a command that needs to be invoked
			// Debug adapter will dynamically provide the full launch.json
			return this.commandService.executeCommand<string>(<string>this.initialConfigurations).then(content => {
				// Debug adapter returned the full content of the launch.json - return it after format
				if (editorConfig.editor.insertSpaces) {
					content = content.replace(new RegExp('\t', 'g'), strings.repeat(' ', editorConfig.editor.tabSize));
				}

				return content;
			});
		}

		return TPromise.as(JSON.stringify(
			{
				version: '0.2.0',
				configurations: this.initialConfigurations || []
			},
			null,
			editorConfig.editor.insertSpaces ? strings.repeat(' ', editorConfig.editor.tabSize) : '\t'
		));
	};

	public get label() {
		return this._label || this.type;
	}

	public set label(value: string) {
		this._label = value;
	}

	public getSchemaAttributes(): any[] {
		// fill in the default configuration attributes shared by all adapters.
		if (this.configurationAttributes) {
			return Object.keys(this.configurationAttributes).map(request => {
				const attributes = this.configurationAttributes[request];
				const defaultRequired = ['name', 'type', 'request'];
				attributes.required = attributes.required && attributes.required.length ? defaultRequired.concat(attributes.required) : defaultRequired;
				attributes.additionalProperties = false;
				attributes.type = 'object';
				if (!attributes.properties) {
					attributes.properties = {};
				}
				const properties = attributes.properties;
				properties.type = {
					enum: [this.type, 'composite'],
					description: nls.localize('debugType', "Type of configuration.")
				};
				properties.name = {
					type: 'string',
					description: nls.localize('debugName', "Name of configuration; appears in the launch configuration drop down menu."),
					default: 'Launch'
				};
				properties.request = {
					enum: [request],
					description: nls.localize('debugRequest', "Request type of configuration. Can be \"launch\" or \"attach\"."),
				};
				properties.debugServer = {
					type: 'number',
					description: nls.localize('debugServer', "For debug extension development only: if a port is specified VS Code tries to connect to a debug adapter running in server mode")
				};
				properties.configurationNames = {
					type: 'array',
					default: [],
					description: nls.localize('debugConfigurationNames', "Configurations that will be launched as part of this \"composite\" configuration. Only respected if type of this configuration is \"composite\".")
				};
				properties.preLaunchTask = {
					type: ['string', 'null'],
					default: null,
					description: nls.localize('debugPrelaunchTask', "Task to run before debug session starts.")
				};
				properties.internalConsoleOptions = {
					enum: ['neverOpen', 'openOnSessionStart', 'openOnFirstSessionStart'],
					default: 'openOnFirstSessionStart',
					description: nls.localize('internalConsoleOptions', "Controls behavior of the internal debug console.")
				};
				this.warnRelativePaths(properties.outDir);
				this.warnRelativePaths(properties.program);
				this.warnRelativePaths(properties.cwd);
				const osProperties = objects.deepClone(properties);
				properties.windows = {
					type: 'object',
					description: nls.localize('debugWindowsConfiguration', "Windows specific launch configuration attributes."),
					properties: osProperties
				};
				properties.osx = {
					type: 'object',
					description: nls.localize('debugOSXConfiguration', "OS X specific launch configuration attributes."),
					properties: osProperties
				};
				properties.linux = {
					type: 'object',
					description: nls.localize('debugLinuxConfiguration', "Linux specific launch configuration attributes."),
					properties: osProperties
				};

				return attributes;
			});
		}

		return null;
	}

	private warnRelativePaths(attribute: any): void {
		if (attribute) {
			attribute.pattern = '^\\${.*}.*|' + paths.isAbsoluteRegex.source;
			attribute.errorMessage = nls.localize('relativePathsNotConverted', "Relative paths will no longer be automatically converted to absolute ones. Consider using ${workspaceRoot} as a prefix.");
		}
	}
}
