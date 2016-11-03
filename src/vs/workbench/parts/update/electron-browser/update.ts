/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import nls = require('vs/nls');
import severity from 'vs/base/common/severity';
import { TPromise } from 'vs/base/common/winjs.base';
import { Action } from 'vs/base/common/actions';
import { ipcRenderer as ipc } from 'electron';
import { IMessageService, CloseAction, Severity } from 'vs/platform/message/common/message';
import pkg from 'vs/platform/package';
import product from 'vs/platform/product';
import URI from 'vs/base/common/uri';
import { IWorkbenchEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { ReleaseNotesInput } from 'vs/workbench/parts/update/electron-browser/releaseNotesInput';
import { IRequestService } from 'vs/platform/request/common/request';
import { asText } from 'vs/base/node/request';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { Keybinding } from 'vs/base/common/keybinding';
import { ServicesAccessor } from 'vs/platform/instantiation/common/instantiation';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { IWorkbenchContribution } from 'vs/workbench/common/contributions';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';
import * as semver from 'semver';

interface IUpdate {
	releaseNotes: string;
	version: string;
	date: string;
}

const ApplyUpdateAction = new Action(
	'update.applyUpdate',
	nls.localize('updateNow', "Update Now"),
	null,
	true,
	() => { ipc.send('vscode:update-apply'); return TPromise.as(true); }
);

const NotNowAction = new Action(
	'update.later',
	nls.localize('later', "Later"),
	null,
	true,
	() => TPromise.as(true)
);

export function loadReleaseNotes(accessor: ServicesAccessor, version: string): TPromise<string> {
	const requestService = accessor.get(IRequestService);
	const keybindingService = accessor.get(IKeybindingService);
	const match = /^(\d+\.\d)\./.exec(version);

	if (!match) {
		return TPromise.as(null);
	}

	const versionLabel = match[1].replace(/\./g, '_');
	const baseUrl = 'https://code.visualstudio.com/raw';
	const url = `${baseUrl}/v${versionLabel}.md`;

	const patchKeybindings = (text: string): string => {
		const kb = (match: string, kb: string) => {
			const keybinding = keybindingService.lookupKeybindings(kb)[0];

			if (!keybinding) {
				return match;
			}

			return keybindingService.getLabelFor(keybinding);
		};

		const kbstyle = (match: string, kb: string) => {
			const code = Keybinding.fromUserSettingsLabel(kb);

			if (!code) {
				return match;
			}

			const keybinding = new Keybinding(code);

			if (!keybinding) {
				return match;
			}

			return keybindingService.getLabelFor(keybinding);
		};

		return text
			.replace(/kb\(([a-z.\d\-]+)\)/gi, kb)
			.replace(/kbstyle\(([^\)]+)\)/gi, kbstyle);
	};

	return requestService.request({ url })
		.then(asText)
		.then(text => patchKeybindings(text));
}

export class OpenLatestReleaseNotesInBrowserAction extends Action {

	constructor(
		@IOpenerService private openerService: IOpenerService
	) {
		super('update.openLatestReleaseNotes', nls.localize('releaseNotes', "Release Notes"), null, true);
	}

	run(): TPromise<any> {
		const uri = URI.parse(product.releaseNotesUrl);
		return this.openerService.open(uri);
	}
}

export abstract class AbstractShowReleaseNotesAction extends Action {

	constructor(
		id,
		label,
		private returnValue: boolean,
		private version: string,
		@IWorkbenchEditorService private editorService: IWorkbenchEditorService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IOpenerService private openerService: IOpenerService
	) {
		super(id, label, null, true);
	}

	run(): TPromise<boolean> {
		if (!this.enabled) {
			return TPromise.as(false);
		}

		this.enabled = false;

		return this.instantiationService.invokeFunction(loadReleaseNotes, this.version)
			.then(text => this.editorService.openEditor(this.instantiationService.createInstance(ReleaseNotesInput, this.version, text)))
			.then(() => true)
			.then(null, () => {
				const action = this.instantiationService.createInstance(OpenLatestReleaseNotesInBrowserAction);
				return action.run().then(() => false);
			});
	}
}

export class ShowReleaseNotesAction extends AbstractShowReleaseNotesAction {

	constructor(
		returnValue: boolean,
		version: string,
		@IWorkbenchEditorService editorService: IWorkbenchEditorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService
	) {
		super('update.showReleaseNotes', nls.localize('releaseNotes', "Release Notes"), returnValue, version, editorService, instantiationService, openerService);
	}
}

export class ShowCurrentReleaseNotesAction extends AbstractShowReleaseNotesAction {

	static ID = 'update.showCurrentReleaseNotes';
	static LABEL = nls.localize('showReleaseNotes', "Show Release Notes");

	constructor(
		id = ShowCurrentReleaseNotesAction.ID,
		label = ShowCurrentReleaseNotesAction.LABEL,
		@IWorkbenchEditorService editorService: IWorkbenchEditorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService
	) {
		super(id, label, true, pkg.version, editorService, instantiationService, openerService);
	}
}

export const DownloadAction = (url: string) => new Action(
	'update.download',
	nls.localize('downloadNow', "Download Now"),
	null,
	true,
	() => { window.open(url); return TPromise.as(true); }
);

const LinkAction = (id: string, message: string, licenseUrl: string) => new Action(
	id, message, null, true,
	() => { window.open(licenseUrl); return TPromise.as(null); }
);

export class UpdateContribution implements IWorkbenchContribution {

	private static KEY = 'releaseNotes/lastVersion';
	private static INSIDER_KEY = 'releaseNotes/shouldShowInsiderDisclaimer';
	getId() { return 'vs.update'; }

	constructor(
		@IStorageService storageService: IStorageService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IMessageService messageService: IMessageService,
		@IWorkbenchEditorService editorService: IWorkbenchEditorService
	) {
		const lastVersion = storageService.get(UpdateContribution.KEY, StorageScope.GLOBAL, '');

		// was there an update?
		if (product.releaseNotesUrl && lastVersion && pkg.version !== lastVersion) {
			instantiationService.invokeFunction(loadReleaseNotes, pkg.version)
				.then(
				text => editorService.openEditor(instantiationService.createInstance(ReleaseNotesInput, pkg.version, text)),
				() => {
					messageService.show(Severity.Info, {
						message: nls.localize('read the release notes', "Welcome to {0} v{1}! Would you like to read the Release Notes?", product.nameLong, pkg.version),
						actions: [
							instantiationService.createInstance(OpenLatestReleaseNotesInBrowserAction),
							CloseAction
						]
					});
				});
		}

		// should we show the new license?
		if (product.licenseUrl && lastVersion && semver.satisfies(lastVersion, '<1.0.0') && semver.satisfies(pkg.version, '>=1.0.0')) {
			messageService.show(Severity.Info, {
				message: nls.localize('licenseChanged', "Our license terms have changed, please go through them.", product.nameLong, pkg.version),
				actions: [
					LinkAction('update.showLicense', nls.localize('license', "Read License"), product.licenseUrl),
					CloseAction
				]
			});
		}

		const shouldShowInsiderDisclaimer = storageService.getBoolean(UpdateContribution.INSIDER_KEY, StorageScope.GLOBAL, true);

		// is this a build which releases often?
		if (shouldShowInsiderDisclaimer && /-alpha$|-insider$/.test(pkg.version)) {
			messageService.show(Severity.Info, {
				message: nls.localize('insiderBuilds', "Insider builds and releases everyday!", product.nameLong, pkg.version),
				actions: [
					new Action('update.insiderBuilds', nls.localize('readmore', "Read More"), '', true, () => {
						window.open('http://go.microsoft.com/fwlink/?LinkID=798816');
						storageService.store(UpdateContribution.INSIDER_KEY, false, StorageScope.GLOBAL);
						return TPromise.as(null);
					}),
					new Action('update.neverAgain', nls.localize('neverShowAgain', "Don't Show Again"), '', true, () => {
						storageService.store(UpdateContribution.INSIDER_KEY, false, StorageScope.GLOBAL);
						return TPromise.as(null);
					}),
					CloseAction
				]
			});
		}

		storageService.store(UpdateContribution.KEY, pkg.version, StorageScope.GLOBAL);

		ipc.on('vscode:update-downloaded', (event, data: string) => {
			const update = JSON.parse(data) as IUpdate;
			const releaseNotesAction = instantiationService.createInstance(ShowReleaseNotesAction, false, update.version);

			messageService.show(severity.Info, {
				message: nls.localize('updateAvailable', "{0} will be updated after it restarts.", product.nameLong),
				actions: [ApplyUpdateAction, NotNowAction, releaseNotesAction]
			});
		});

		ipc.on('vscode:update-available', (event, url: string, version: string) => {
			const releaseNotesAction = instantiationService.createInstance(ShowReleaseNotesAction, false, version);

			messageService.show(severity.Info, {
				message: nls.localize('thereIsUpdateAvailable', "There is an available update."),
				actions: [DownloadAction(url), NotNowAction, releaseNotesAction]
			});
		});

		ipc.on('vscode:update-not-available', () => {
			messageService.show(severity.Info, nls.localize('noUpdatesAvailable', "There are no updates currently available."));
		});
	}
}