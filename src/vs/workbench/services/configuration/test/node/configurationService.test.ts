/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import assert = require('assert');
import os = require('os');
import path = require('path');
import fs = require('fs');
import { TPromise } from 'vs/base/common/winjs.base';
import { Registry } from 'vs/platform/platform';
import { ParsedArgs } from 'vs/platform/environment/node/argv';
import { WorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { EnvironmentService } from 'vs/platform/environment/node/environmentService';
import { parseArgs } from 'vs/platform/environment/node/argv';
import extfs = require('vs/base/node/extfs');
import { TestEventService } from 'vs/test/utils/servicesTestUtils';
import uuid = require('vs/base/common/uuid');
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from 'vs/platform/configuration/common/configurationRegistry';
import { WorkspaceConfigurationService } from 'vs/workbench/services/configuration/node/configurationService';
import URI from 'vs/base/common/uri';
import { EventType as FileEventType, FileChangeType, FileChangesEvent } from 'vs/platform/files/common/files';

class SettingsTestEnvironmentService extends EnvironmentService {

	constructor(args: ParsedArgs, _execPath: string, private customAppSettingsHome) {
		super(args, _execPath);
	}

	get appSettingsPath(): string { return this.customAppSettingsHome; }
}

suite('WorkspaceConfigurationService - Node', () => {

	function createWorkspace(callback: (workspaceDir: string, globalSettingsFile: string, cleanUp: (callback: () => void) => void) => void): void {
		const id = uuid.generateUuid();
		const parentDir = path.join(os.tmpdir(), 'vsctests', id);
		const workspaceDir = path.join(parentDir, 'workspaceconfig', id);
		const workspaceSettingsDir = path.join(workspaceDir, '.vscode');
		const globalSettingsFile = path.join(workspaceDir, 'config.json');

		extfs.mkdirp(workspaceSettingsDir, 493, (error) => {
			callback(workspaceDir, globalSettingsFile, (callback) => extfs.del(parentDir, os.tmpdir(), () => { }, callback));
		});
	}

	function createService(workspaceDir: string, globalSettingsFile: string): TPromise<WorkspaceConfigurationService> {
		const workspaceContextService = new WorkspaceContextService({ resource: URI.file(workspaceDir) });
		const environmentService = new SettingsTestEnvironmentService(parseArgs(process.argv), process.execPath, globalSettingsFile);
		const service = new WorkspaceConfigurationService(workspaceContextService, new TestEventService(), environmentService);

		return service.initialize().then(() => service);
	}

	test('defaults', (done: () => void) => {
		interface ITestSetting {
			workspace: {
				service: {
					testSetting: string;
				}
			};
		}

		const configurationRegistry = <IConfigurationRegistry>Registry.as(ConfigurationExtensions.Configuration);
		configurationRegistry.registerConfiguration({
			'id': '_test_workspace',
			'type': 'object',
			'properties': {
				'workspace.service.testSetting': {
					'type': 'string',
					'default': 'isSet'
				}
			}
		});

		createWorkspace((workspaceDir, globalSettingsFile, cleanUp) => {
			return createService(workspaceDir, globalSettingsFile).then(service => {
				assert.ok(!service.hasWorkspaceConfiguration());

				const config = service.getConfiguration<ITestSetting>();
				assert.equal(config.workspace.service.testSetting, 'isSet');

				service.dispose();

				cleanUp(done);
			});
		});
	});

	test('globals', (done: () => void) => {
		createWorkspace((workspaceDir, globalSettingsFile, cleanUp) => {
			return createService(workspaceDir, globalSettingsFile).then(service => {
				fs.writeFileSync(globalSettingsFile, '{ "testworkbench.editor.tabs": true }');

				service.reloadConfiguration().then(() => {
					assert.ok(!service.hasWorkspaceConfiguration());

					const config = service.getConfiguration<{ testworkbench: { editor: { tabs: boolean } } }>();
					assert.equal(config.testworkbench.editor.tabs, true);

					service.dispose();

					cleanUp(done);
				});
			});
		});
	});

	test('reload configuration emits events', (done: () => void) => {
		createWorkspace((workspaceDir, globalSettingsFile, cleanUp) => {
			return createService(workspaceDir, globalSettingsFile).then(service => {
				fs.writeFileSync(globalSettingsFile, '{ "testworkbench.editor.tabs": true }');

				return service.initialize().then(() => {
					service.onDidUpdateConfiguration(event => {
						const config = service.getConfiguration<{ testworkbench: { editor: { tabs: boolean } } }>();
						assert.equal(config.testworkbench.editor.tabs, false);

						service.dispose();

						cleanUp(done);
					});

					fs.writeFileSync(globalSettingsFile, '{ "testworkbench.editor.tabs": false }');

					// this has to trigger the event since the config changes
					service.reloadConfiguration().done();
				});

			});
		});
	});

	test('globals override defaults', (done: () => void) => {
		interface ITestSetting {
			workspace: {
				service: {
					testSetting: string;
				}
			};
		}

		const configurationRegistry = <IConfigurationRegistry>Registry.as(ConfigurationExtensions.Configuration);
		configurationRegistry.registerConfiguration({
			'id': '_test_workspace',
			'type': 'object',
			'properties': {
				'workspace.service.testSetting': {
					'type': 'string',
					'default': 'isSet'
				}
			}
		});

		createWorkspace((workspaceDir, globalSettingsFile, cleanUp) => {
			return createService(workspaceDir, globalSettingsFile).then(service => {
				fs.writeFileSync(globalSettingsFile, '{ "workspace.service.testSetting": "isChanged" }');

				service.reloadConfiguration().then(() => {
					assert.ok(!service.hasWorkspaceConfiguration());

					const config = service.getConfiguration<ITestSetting>();
					assert.equal(config.workspace.service.testSetting, 'isChanged');

					service.dispose();

					cleanUp(done);
				});
			});
		});
	});

	test('workspace settings', (done: () => void) => {
		createWorkspace((workspaceDir, globalSettingsFile, cleanUp) => {
			return createService(workspaceDir, globalSettingsFile).then(service => {
				fs.writeFileSync(path.join(workspaceDir, '.vscode', 'settings.json'), '{ "testworkbench.editor.icons": true }');

				service.reloadConfiguration().then(() => {
					assert.ok(service.hasWorkspaceConfiguration());

					const config = service.getConfiguration<{ testworkbench: { editor: { icons: boolean } } }>();
					assert.equal(config.testworkbench.editor.icons, true);

					service.dispose();

					cleanUp(done);
				});
			});
		});
	});

	test('workspace settings override user settings', (done: () => void) => {
		createWorkspace((workspaceDir, globalSettingsFile, cleanUp) => {
			return createService(workspaceDir, globalSettingsFile).then(service => {
				fs.writeFileSync(globalSettingsFile, '{ "testworkbench.editor.icons": false, "testworkbench.other.setting": true }');
				fs.writeFileSync(path.join(workspaceDir, '.vscode', 'settings.json'), '{ "testworkbench.editor.icons": true }');

				service.reloadConfiguration().then(() => {
					const config = service.getConfiguration<{ testworkbench: { editor: { icons: boolean }, other: { setting: string } } }>();
					assert.equal(config.testworkbench.editor.icons, true);
					assert.equal(config.testworkbench.other.setting, true);

					service.dispose();

					cleanUp(done);
				});
			});
		});
	});

	test('workspace change triggers event', (done: () => void) => {
		createWorkspace((workspaceDir, globalSettingsFile, cleanUp) => {
			const workspaceContextService = new WorkspaceContextService({ resource: URI.file(workspaceDir) });
			const environmentService = new SettingsTestEnvironmentService(parseArgs(process.argv), process.execPath, globalSettingsFile);
			const eventService = new TestEventService();
			const service = new WorkspaceConfigurationService(workspaceContextService, eventService, environmentService);

			return service.initialize().then(() => {
				service.onDidUpdateConfiguration(event => {
					const config = service.getConfiguration<{ testworkbench: { editor: { icons: boolean } } }>();
					assert.equal(config.testworkbench.editor.icons, true);
					assert.equal(event.config.testworkbench.editor.icons, true);

					service.dispose();

					cleanUp(done);
				});

				const settingsFile = path.join(workspaceDir, '.vscode', 'settings.json');
				fs.writeFileSync(settingsFile, '{ "testworkbench.editor.icons": true }');

				const event = new FileChangesEvent([{ resource: URI.file(settingsFile), type: FileChangeType.ADDED }]);
				eventService.emit(FileEventType.FILE_CHANGES, event);
			});
		});
	});

	test('lookup', (done: () => void) => {
		const configurationRegistry = <IConfigurationRegistry>Registry.as(ConfigurationExtensions.Configuration);
		configurationRegistry.registerConfiguration({
			'id': '_test',
			'type': 'object',
			'properties': {
				'workspaceLookup.service.testSetting': {
					'type': 'string',
					'default': 'isSet'
				}
			}
		});

		createWorkspace((workspaceDir, globalSettingsFile, cleanUp) => {
			return createService(workspaceDir, globalSettingsFile).then(service => {
				let res = service.lookup('something.missing');
				assert.ok(!res.default);
				assert.ok(!res.user);
				assert.ok(!res.workspace);
				assert.ok(!res.value);

				res = service.lookup('workspaceLookup.service.testSetting');
				assert.equal(res.default, 'isSet');
				assert.equal(res.value, 'isSet');
				assert.ok(!res.user);
				assert.ok(!res.workspace);

				fs.writeFileSync(globalSettingsFile, '{ "workspaceLookup.service.testSetting": true }');

				return service.reloadConfiguration().then(() => {
					res = service.lookup('workspaceLookup.service.testSetting');
					assert.equal(res.default, 'isSet');
					assert.equal(res.user, true);
					assert.equal(res.value, true);
					assert.ok(!res.workspace);

					const settingsFile = path.join(workspaceDir, '.vscode', 'settings.json');
					fs.writeFileSync(settingsFile, '{ "workspaceLookup.service.testSetting": 55 }');

					return service.reloadConfiguration().then(() => {
						res = service.lookup('workspaceLookup.service.testSetting');
						assert.equal(res.default, 'isSet');
						assert.equal(res.user, true);
						assert.equal(res.workspace, 55);
						assert.equal(res.value, 55);

						service.dispose();

						cleanUp(done);
					});

				});

			});
		});
	});
});