/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as platform from 'vs/base/common/platform';
import product from 'vs/platform/product';
import pkg from 'vs/platform/package';
import { serve, Server, connect } from 'vs/base/parts/ipc/node/ipc.net';
import { TPromise } from 'vs/base/common/winjs.base';
import { ServiceCollection } from 'vs/platform/instantiation/common/serviceCollection';
import { SyncDescriptor } from 'vs/platform/instantiation/common/descriptors';
import { InstantiationService } from 'vs/platform/instantiation/common/instantiationService';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { EnvironmentService } from 'vs/platform/environment/node/environmentService';
import { IEventService } from 'vs/platform/event/common/event';
import { EventService } from 'vs/platform/event/common/eventService';
import { ExtensionManagementChannel } from 'vs/platform/extensionManagement/common/extensionManagementIpc';
import { IExtensionManagementService, IExtensionGalleryService } from 'vs/platform/extensionManagement/common/extensionManagement';
import { ExtensionManagementService } from 'vs/platform/extensionManagement/node/extensionManagementService';
import { ExtensionGalleryService } from 'vs/platform/extensionManagement/node/extensionGalleryService';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { ConfigurationService } from 'vs/platform/configuration/node/configurationService';
import { IRequestService } from 'vs/platform/request/common/request';
import { RequestService } from 'vs/platform/request/node/requestService';
import { ITelemetryService, combinedAppender, NullTelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { resolveCommonProperties } from 'vs/platform/telemetry/node/commonProperties';
import { TelemetryAppenderChannel } from 'vs/platform/telemetry/common/telemetryIpc';
import { TelemetryService, ITelemetryServiceConfig } from 'vs/platform/telemetry/common/telemetryService';
import { AppInsightsAppender } from 'vs/platform/telemetry/node/appInsightsAppender';
import { ISharedProcessInitData } from './sharedProcess';
import { IChoiceService } from 'vs/platform/message/common/message';
import { ChoiceChannelClient } from 'vs/platform/message/common/messageIpc';
import { WindowEventChannelClient } from 'vs/code/common/windowsIpc';
import { IWindowEventService, ActiveWindowManager } from 'vs/code/common/windows';

function quit(err?: Error) {
	if (err) {
		console.error(err.stack || err);
	}

	process.exit(err ? 1 : 0);
}

/**
 * Plan B is to kill oneself if one's parent dies. Much drama.
 */
function setupPlanB(parentPid: number): void {
	setInterval(function () {
		try {
			process.kill(parentPid, 0); // throws an exception if the main process doesn't exist anymore.
		} catch (e) {
			process.exit();
		}
	}, 5000);
}

const eventPrefix = 'monacoworkbench';

function main(server: Server, initData: ISharedProcessInitData): void {
	const services = new ServiceCollection();

	services.set(IEventService, new SyncDescriptor(EventService));
	services.set(IEnvironmentService, new SyncDescriptor(EnvironmentService, initData.args, process.execPath));
	services.set(IConfigurationService, new SyncDescriptor(ConfigurationService));
	services.set(IRequestService, new SyncDescriptor(RequestService));

	const windowEventChannel = server.getChannel('windowEvent', { route: () => 'main' });
	const windowEventService: IWindowEventService = new WindowEventChannelClient(windowEventChannel);
	services.set(IWindowEventService, windowEventService);

	const activeWindowManager = new ActiveWindowManager(windowEventService);

	const choiceChannel = server.getChannel('choice', { route: () => activeWindowManager.activeClientId });
	services.set(IChoiceService, new ChoiceChannelClient(choiceChannel));

	const instantiationService = new InstantiationService(services);

	instantiationService.invokeFunction(accessor => {
		const appenders: AppInsightsAppender[] = [];

		if (product.aiConfig && product.aiConfig.key) {
			appenders.push(new AppInsightsAppender(eventPrefix, null, product.aiConfig.key));
		}

		if (product.aiConfig && product.aiConfig.asimovKey) {
			appenders.push(new AppInsightsAppender(eventPrefix, null, product.aiConfig.asimovKey));
		}

		// It is important to dispose the AI adapter properly because
		// only then they flush remaining data.
		process.once('exit', () => appenders.forEach(a => a.dispose()));

		const appender = combinedAppender(...appenders);
		server.registerChannel('telemetryAppender', new TelemetryAppenderChannel(appender));

		const services = new ServiceCollection();
		const { appRoot, extensionsPath, extensionDevelopmentPath, isBuilt } = accessor.get(IEnvironmentService);

		if (isBuilt && !extensionDevelopmentPath && product.enableTelemetry) {
			const config: ITelemetryServiceConfig = {
				appender,
				commonProperties: resolveCommonProperties(product.commit, pkg.version),
				piiPaths: [appRoot, extensionsPath]
			};

			services.set(ITelemetryService, new SyncDescriptor(TelemetryService, config));
		} else {
			services.set(ITelemetryService, NullTelemetryService);
		}

		services.set(IExtensionManagementService, new SyncDescriptor(ExtensionManagementService));
		services.set(IExtensionGalleryService, new SyncDescriptor(ExtensionGalleryService));

		const instantiationService2 = instantiationService.createChild(services);

		instantiationService2.invokeFunction(accessor => {
			const extensionManagementService = accessor.get(IExtensionManagementService);
			const channel = new ExtensionManagementChannel(extensionManagementService);
			server.registerChannel('extensions', channel);

			// clean up deprecated extensions
			(extensionManagementService as ExtensionManagementService).removeDeprecatedExtensions();
		});
	});
}

function setupIPC(hook: string): TPromise<Server> {
	function setup(retry: boolean): TPromise<Server> {
		return serve(hook).then(null, err => {
			if (!retry || platform.isWindows || err.code !== 'EADDRINUSE') {
				return TPromise.wrapError(err);
			}

			// should retry, not windows and eaddrinuse

			return connect(hook, '').then(
				client => {
					// we could connect to a running instance. this is not good, abort
					client.dispose();
					return TPromise.wrapError(new Error('There is an instance already running.'));
				},
				err => {
					// it happens on Linux and OS X that the pipe is left behind
					// let's delete it, since we can't connect to it
					// and the retry the whole thing
					try {
						fs.unlinkSync(hook);
					} catch (e) {
						return TPromise.wrapError(new Error('Error deleting the shared ipc hook.'));
					}

					return setup(false);
				}
			);
		});
	}

	return setup(true);
}

function handshake(): TPromise<ISharedProcessInitData> {
	return new TPromise<ISharedProcessInitData>((c, e) => {
		process.once('message', c);
		process.once('error', e);
		process.send('hello');
	});
}

setupIPC(process.env['VSCODE_SHARED_IPC_HOOK'])
	.then(server => handshake()
		.then(data => main(server, data))
		.then(() => setupPlanB(process.env['VSCODE_PID']))
		.done(null, quit));