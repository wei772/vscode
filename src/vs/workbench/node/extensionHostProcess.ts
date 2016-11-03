/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { onUnexpectedError } from 'vs/base/common/errors';
import { TPromise } from 'vs/base/common/winjs.base';
import { ExtensionHostMain, exit } from 'vs/workbench/node/extensionHostMain';
import { create as createIPC, IMainProcessExtHostIPC } from 'vs/platform/extensions/common/ipcRemoteCom';
import marshalling = require('vs/base/common/marshalling');
import { createQueuedSender } from 'vs/base/node/processes';
import { IInitData } from 'vs/workbench/api/node/extHost.protocol';

interface IRendererConnection {
	remoteCom: IMainProcessExtHostIPC;
	initData: IInitData;
}

/**
 * Flag set when in shutdown phase to avoid communicating to the main process.
 */
let isTerminating = false;

// This calls exit directly in case the initialization is not finished and we need to exit
// Otherwise, if initialization completed we go to extensionHostMain.terminate()
let onTerminate = function () {
	exit();
};

// Utility to not flood the process.send() with messages if it is busy catching up
const queuedSender = createQueuedSender(process);

function connectToRenderer(): TPromise<IRendererConnection> {
	return new TPromise<IRendererConnection>((c, e) => {
		const stats: number[] = [];

		// Listen init data message
		process.once('message', raw => {

			let msg = marshalling.parse(raw);

			const remoteCom = createIPC(data => {
				// Needed to avoid EPIPE errors in process.send below when a channel is closed
				if (isTerminating === true) {
					return;
				}
				queuedSender.send(data);
				stats.push(data.length);
			});

			// Listen to all other messages
			process.on('message', (msg) => {
				if (msg.type === '__$terminate') {
					isTerminating = true;
					onTerminate();
					return;
				}
				remoteCom.handle(msg);
			});

			// Print a console message when rejection isn't handled within N seconds. For details:
			// see https://nodejs.org/api/process.html#process_event_unhandledrejection
			// and https://nodejs.org/api/process.html#process_event_rejectionhandled
			const unhandledPromises: TPromise<any>[] = [];
			process.on('unhandledRejection', (reason, promise) => {
				unhandledPromises.push(promise);
				setTimeout(() => {
					const idx = unhandledPromises.indexOf(promise);
					if (idx >= 0) {
						unhandledPromises.splice(idx, 1);
						console.warn('rejected promise not handled within 1 second');
						onUnexpectedError(reason);
					}
				}, 1000);
			});
			process.on('rejectionHandled', promise => {
				const idx = unhandledPromises.indexOf(promise);
				if (idx >= 0) {
					unhandledPromises.splice(idx, 1);
				}
			});

			// Print a console message when an exception isn't handled.
			process.on('uncaughtException', function (err) {
				onUnexpectedError(err);
			});

			// Kill oneself if one's parent dies. Much drama.
			setInterval(function () {
				try {
					process.kill(msg.parentPid, 0); // throws an exception if the main process doesn't exist anymore.
				} catch (e) {
					onTerminate();
				}
			}, 5000);

			// Check stats
			setInterval(function () {
				if (stats.length >= 250) {
					let total = stats.reduce((prev, current) => prev + current, 0);
					console.warn(`MANY messages are being SEND FROM the extension host!`);
					console.warn(`SEND during 1sec: message_count=${stats.length}, total_len=${total}`);
				}
				stats.length = 0;
			}, 1000);


			// Send heartbeat
			setInterval(function () {
				queuedSender.send('__$heartbeat');
			}, 250);

			// Tell the outside that we are initialized
			queuedSender.send('initialized');

			c({ remoteCom, initData: msg });
		});

		// Tell the outside that we are ready to receive messages
		queuedSender.send('ready');
	});
}

connectToRenderer().then(renderer => {
	const extensionHostMain = new ExtensionHostMain(renderer.remoteCom, renderer.initData);
	onTerminate = () => extensionHostMain.terminate();
	return extensionHostMain.start();
}).done(null, err => console.error(err));
