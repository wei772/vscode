/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import nls = require('vs/nls');
import { TPromise } from 'vs/base/common/winjs.base';
import strings = require('vs/base/common/strings');
import types = require('vs/base/common/types');
import { isLinux, isMacintosh, isWindows } from 'vs/base/common/platform';
import objects = require('vs/base/common/objects');
import uri from 'vs/base/common/uri';
import { Schemas } from 'vs/base/common/network';
import paths = require('vs/base/common/paths');
import { IJSONSchema } from 'vs/base/common/jsonSchema';
import editor = require('vs/editor/common/editorCommon');
import extensionsRegistry = require('vs/platform/extensions/common/extensionsRegistry');
import platform = require('vs/platform/platform');
import jsonContributionRegistry = require('vs/platform/jsonschemas/common/jsonContributionRegistry');
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IFileService } from 'vs/platform/files/common/files';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import * as debug from 'vs/workbench/parts/debug/common/debug';
import { Adapter } from 'vs/workbench/parts/debug/node/debugAdapter';
import { IWorkbenchEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IQuickOpenService } from 'vs/workbench/services/quickopen/common/quickOpenService';
import { IConfigurationResolverService } from 'vs/workbench/services/configurationResolver/common/configurationResolver';

// debuggers extension point
export const debuggersExtPoint = extensionsRegistry.ExtensionsRegistry.registerExtensionPoint<debug.IRawAdapter[]>('debuggers', [], {
	description: nls.localize('vscode.extension.contributes.debuggers', 'Contributes debug adapters.'),
	type: 'array',
	defaultSnippets: [{ body: [{ type: '', extensions: [] }] }],
	items: {
		type: 'object',
		defaultSnippets: [{ body: { type: '', program: '', runtime: '', enableBreakpointsFor: { languageIds: [''] } } }],
		properties: {
			type: {
				description: nls.localize('vscode.extension.contributes.debuggers.type', "Unique identifier for this debug adapter."),
				type: 'string'
			},
			label: {
				description: nls.localize('vscode.extension.contributes.debuggers.label', "Display name for this debug adapter."),
				type: 'string'
			},
			enableBreakpointsFor: {
				description: nls.localize('vscode.extension.contributes.debuggers.enableBreakpointsFor', "Allow breakpoints for these languages."),
				type: 'object',
				properties: {
					languageIds: {
						description: nls.localize('vscode.extension.contributes.debuggers.enableBreakpointsFor.languageIds', "List of languages."),
						type: 'array',
						items: {
							type: 'string'
						}
					}
				}
			},
			program: {
				description: nls.localize('vscode.extension.contributes.debuggers.program', "Path to the debug adapter program. Path is either absolute or relative to the extension folder."),
				type: 'string'
			},
			args: {
				description: nls.localize('vscode.extension.contributes.debuggers.args', "Optional arguments to pass to the adapter."),
				type: 'array'
			},
			runtime: {
				description: nls.localize('vscode.extension.contributes.debuggers.runtime', "Optional runtime in case the program attribute is not an executable but requires a runtime."),
				type: 'string'
			},
			runtimeArgs: {
				description: nls.localize('vscode.extension.contributes.debuggers.runtimeArgs', "Optional runtime arguments."),
				type: 'array'
			},
			variables: {
				description: nls.localize('vscode.extension.contributes.debuggers.variables', "Mapping from interactive variables (e.g ${action.pickProcess}) in `launch.json` to a command."),
				type: 'object'
			},
			initialConfigurations: {
				description: nls.localize('vscode.extension.contributes.debuggers.initialConfigurations', "Configurations for generating the initial \'launch.json\'."),
				type: ['array', 'string'],
			},
			configurationAttributes: {
				description: nls.localize('vscode.extension.contributes.debuggers.configurationAttributes', "JSON schema configurations for validating \'launch.json\'."),
				type: 'object'
			},
			windows: {
				description: nls.localize('vscode.extension.contributes.debuggers.windows', "Windows specific settings."),
				type: 'object',
				properties: {
					runtime: {
						description: nls.localize('vscode.extension.contributes.debuggers.windows.runtime', "Runtime used for Windows."),
						type: 'string'
					}
				}
			},
			osx: {
				description: nls.localize('vscode.extension.contributes.debuggers.osx', "OS X specific settings."),
				type: 'object',
				properties: {
					runtime: {
						description: nls.localize('vscode.extension.contributes.debuggers.osx.runtime', "Runtime used for OSX."),
						type: 'string'
					}
				}
			},
			linux: {
				description: nls.localize('vscode.extension.contributes.debuggers.linux', "Linux specific settings."),
				type: 'object',
				properties: {
					runtime: {
						description: nls.localize('vscode.extension.contributes.debuggers.linux.runtime', "Runtime used for Linux."),
						type: 'string'
					}
				}
			}
		}
	}
});

// breakpoints extension point #9037
export const breakpointsExtPoint = extensionsRegistry.ExtensionsRegistry.registerExtensionPoint<debug.IRawBreakpointContribution[]>('breakpoints', [], {
	description: nls.localize('vscode.extension.contributes.breakpoints', 'Contributes breakpoints.'),
	type: 'array',
	defaultSnippets: [{ body: [{ language: '' }] }],
	items: {
		type: 'object',
		defaultSnippets: [{ body: { language: '' } }],
		properties: {
			language: {
				description: nls.localize('vscode.extension.contributes.breakpoints.language', "Allow breakpoints for this language."),
				type: 'string'
			},
		}
	}
});

// debug general schema

export const schemaId = 'vscode://schemas/launch';
const schema: IJSONSchema = {
	id: schemaId,
	type: 'object',
	title: nls.localize('app.launch.json.title', "Launch"),
	required: ['version', 'configurations'],
	properties: {
		version: {
			type: 'string',
			description: nls.localize('app.launch.json.version', "Version of this file format."),
			default: '0.2.0'
		},
		configurations: {
			type: 'array',
			description: nls.localize('app.launch.json.configurations', "List of configurations. Add new configurations or edit existing ones by using IntelliSense."),
			items: {
				'type': 'object',
				oneOf: []
			}
		},
		// TODO@Isidor remove support for this in December
		debugServer: {
			type: 'number',
			description: nls.localize('app.launch.json.debugServer', "DEPRECATED: please move debugServer inside a configuration.")
		},
	}
};

const jsonRegistry = <jsonContributionRegistry.IJSONContributionRegistry>platform.Registry.as(jsonContributionRegistry.Extensions.JSONContribution);
jsonRegistry.registerSchema(schemaId, schema);

export class ConfigurationManager implements debug.IConfigurationManager {
	private adapters: Adapter[];
	private allModeIdsForBreakpoints: { [key: string]: boolean };

	constructor(
		@IWorkspaceContextService private contextService: IWorkspaceContextService,
		@IFileService private fileService: IFileService,
		@ITelemetryService private telemetryService: ITelemetryService,
		@IWorkbenchEditorService private editorService: IWorkbenchEditorService,
		@IConfigurationService private configurationService: IConfigurationService,
		@IQuickOpenService private quickOpenService: IQuickOpenService,
		@IConfigurationResolverService private configurationResolverService: IConfigurationResolverService,
		@IInstantiationService private instantiationService: IInstantiationService
	) {
		this.adapters = [];
		this.registerListeners();
		this.allModeIdsForBreakpoints = {};
	}

	private registerListeners(): void {
		debuggersExtPoint.setHandler((extensions) => {

			extensions.forEach(extension => {
				extension.value.forEach(rawAdapter => {
					const adapter = this.instantiationService.createInstance(Adapter, rawAdapter, extension.description);
					const duplicate = this.adapters.filter(a => a.type === adapter.type)[0];
					if (!rawAdapter.type || (typeof rawAdapter.type !== 'string')) {
						extension.collector.error(nls.localize('debugNoType', "Debug adapter 'type' can not be omitted and must be of type 'string'."));
					}

					if (duplicate) {
						Object.keys(rawAdapter).forEach(attribute => {
							if (rawAdapter[attribute]) {
								if (attribute === 'enableBreakpointsFor' && duplicate[attribute]) {
									Object.keys(adapter.enableBreakpointsFor).forEach(languageId => duplicate.enableBreakpointsFor[languageId] = true);
								} else if (duplicate[attribute] && attribute !== 'type' && attribute !== 'label') {
									// give priority to the later registered extension.
									duplicate[attribute] = adapter[attribute];
									extension.collector.error(nls.localize('duplicateDebuggerType', "Debug type '{0}' is already registered and has attribute '{1}', ignoring attribute '{1}'.", adapter.type, attribute));
								} else {
									duplicate[attribute] = adapter[attribute];
								}
							}
						});
					} else {
						this.adapters.push(adapter);
					}

					if (adapter.enableBreakpointsFor) {
						adapter.enableBreakpointsFor.languageIds.forEach(modeId => {
							this.allModeIdsForBreakpoints[modeId] = true;
						});
					}
				});
			});

			// update the schema to include all attributes and types from extensions.
			// debug.schema.properties['configurations'].items.properties.type.enum = this.adapters.map(adapter => adapter.type);
			this.adapters.forEach(adapter => {
				const schemaAttributes = adapter.getSchemaAttributes();
				if (schemaAttributes) {
					(<IJSONSchema>schema.properties['configurations'].items).oneOf.push(...schemaAttributes);
				}
			});
		});

		breakpointsExtPoint.setHandler(extensions => {
			extensions.forEach(ext => {
				ext.value.forEach(breakpoints => {
					this.allModeIdsForBreakpoints[breakpoints.language] = true;
				});
			});
		});
	}

	public getAdapter(type: string): Adapter {
		return this.adapters.filter(adapter => strings.equalsIgnoreCase(adapter.type, type)).pop();
	}

	public getConfiguration(nameOrConfig: string | debug.IConfig): TPromise<debug.IConfig> {
		const config = this.configurationService.getConfiguration<debug.IGlobalConfig>('launch');

		let result: debug.IConfig = null;
		if (types.isObject(nameOrConfig)) {
			result = objects.deepClone(nameOrConfig) as debug.IConfig;
		} else {
			if (!config || !config.configurations) {
				return TPromise.as(null);
			}
			// if the configuration name is not set yet, take the first launch config (can happen if debug viewlet has not been opened yet).
			const filtered = config.configurations.filter(cfg => cfg.name === nameOrConfig);

			result = filtered.length === 1 ? filtered[0] : config.configurations[0];
			result = objects.deepClone(result);
			if (config && result && config.debugServer) {
				result.debugServer = config.debugServer;
			}
		}

		if (result) {
			// Set operating system specific properties #1873
			if (isWindows && result.windows) {
				Object.keys(result.windows).forEach(key => {
					result[key] = result.windows[key];
				});
			}
			if (isMacintosh && result.osx) {
				Object.keys(result.osx).forEach(key => {
					result[key] = result.osx[key];
				});
			}
			if (isLinux && result.linux) {
				Object.keys(result.linux).forEach(key => {
					result[key] = result.linux[key];
				});
			}

			// massage configuration attributes - append workspace path to relatvie paths, substitute variables in paths.
			Object.keys(result).forEach(key => {
				result[key] = this.configurationResolverService.resolveAny(result[key]);
			});

			const adapter = this.getAdapter(result.type);
			return this.configurationResolverService.resolveInteractiveVariables(result, adapter ? adapter.variables : null);
		}
	}

	public openConfigFile(sideBySide: boolean): TPromise<boolean> {
		const resource = uri.file(paths.join(this.contextService.getWorkspace().resource.fsPath, '/.vscode/launch.json'));
		let configFileCreated = false;

		return this.fileService.resolveContent(resource).then(content => true, err =>
			this.quickOpenService.pick(this.adapters, { placeHolder: nls.localize('selectDebug', "Select Environment") })
				.then(adapter => adapter ? adapter.getInitialConfigFileContent() : null)
				.then(content => {
					if (!content) {
						return false;
					}

					configFileCreated = true;
					return this.fileService.updateContent(resource, content).then(() => true);
				}))
			.then(errorFree => {
				if (!errorFree) {
					return false;
				}
				this.telemetryService.publicLog('debugConfigure');

				return this.editorService.openEditor({
					resource: resource,
					options: {
						forceOpen: true,
						pinned: configFileCreated // pin only if config file is created #8727
					},
				}, sideBySide).then(() => true);
			}, (error) => {
				throw new Error(nls.localize('DebugConfig.failed', "Unable to create 'launch.json' file inside the '.vscode' folder ({0}).", error));
			});
	}

	public canSetBreakpointsIn(model: editor.IModel): boolean {
		if (model.uri.scheme === Schemas.inMemory) {
			return false;
		}
		if (this.configurationService.getConfiguration<debug.IDebugConfiguration>('debug').allowBreakpointsEverywhere) {
			return true;
		}

		const mode = model ? model.getMode() : null;
		const modeId = mode ? mode.getId() : null;

		return !!this.allModeIdsForBreakpoints[modeId];
	}
}
