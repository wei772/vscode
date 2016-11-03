/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import Event, { Emitter } from 'vs/base/common/event';
import platform = require('vs/base/common/platform');
import { Builder } from 'vs/base/browser/builder';
import { IContextKeyService, IContextKey } from 'vs/platform/contextkey/common/contextkey';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IPanelService } from 'vs/workbench/services/panel/common/panelService';
import { IPartService } from 'vs/workbench/services/part/common/partService';
import { ITerminalInstance, ITerminalService, KEYBINDING_CONTEXT_TERMINAL_FOCUS, TERMINAL_PANEL_ID } from 'vs/workbench/parts/terminal/electron-browser/terminal';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { TPromise } from 'vs/base/common/winjs.base';
import { TerminalConfigHelper, IShell } from 'vs/workbench/parts/terminal/electron-browser/terminalConfigHelper';
import { TerminalInstance } from 'vs/workbench/parts/terminal/electron-browser/terminalInstance';

export class TerminalService implements ITerminalService {
	public _serviceBrand: any;

	private _activeTerminalInstanceIndex: number;
	private _configHelper: TerminalConfigHelper;
	private _onActiveInstanceChanged: Emitter<string>;
	private _onInstanceDisposed: Emitter<ITerminalInstance>;
	private _onInstanceProcessIdReady: Emitter<ITerminalInstance>;
	private _onInstanceTitleChanged: Emitter<string>;
	private _onInstancesChanged: Emitter<string>;
	private _terminalContainer: HTMLElement;
	private _terminalFocusContextKey: IContextKey<boolean>;
	private _terminalInstances: ITerminalInstance[];

	public get activeTerminalInstanceIndex(): number { return this._activeTerminalInstanceIndex; }
	public get configHelper(): TerminalConfigHelper { return this._configHelper; }
	public get onActiveInstanceChanged(): Event<string> { return this._onActiveInstanceChanged.event; }
	public get onInstanceDisposed(): Event<ITerminalInstance> { return this._onInstanceDisposed.event; }
	public get onInstanceProcessIdReady(): Event<ITerminalInstance> { return this._onInstanceProcessIdReady.event; }
	public get onInstanceTitleChanged(): Event<string> { return this._onInstanceTitleChanged.event; }
	public get onInstancesChanged(): Event<string> { return this._onInstancesChanged.event; }
	public get terminalInstances(): ITerminalInstance[] { return this._terminalInstances; }

	constructor(
		@IContextKeyService private _contextKeyService: IContextKeyService,
		@IInstantiationService private _instantiationService: IInstantiationService,
		@IPanelService private _panelService: IPanelService,
		@IPartService private _partService: IPartService,
		@IWorkspaceContextService private _workspaceContextService: IWorkspaceContextService
	) {
		this._terminalInstances = [];
		this._activeTerminalInstanceIndex = 0;

		this._onActiveInstanceChanged = new Emitter<string>();
		this._onInstanceDisposed = new Emitter<ITerminalInstance>();
		this._onInstanceProcessIdReady = new Emitter<ITerminalInstance>();
		this._onInstanceTitleChanged = new Emitter<string>();
		this._onInstancesChanged = new Emitter<string>();

		this._terminalFocusContextKey = KEYBINDING_CONTEXT_TERMINAL_FOCUS.bindTo(this._contextKeyService);
		this._configHelper = <TerminalConfigHelper>this._instantiationService.createInstance(TerminalConfigHelper, platform.platform);
		this.onInstanceDisposed((terminalInstance) => { this._removeInstance(terminalInstance); });
	}

	public createInstance(name?: string, shellPath?: string, shellArgs?: string[]): ITerminalInstance {
		let shell: IShell = {
			executable: shellPath,
			args: shellArgs
		};
		let terminalInstance = <TerminalInstance>this._instantiationService.createInstance(TerminalInstance,
			this._terminalFocusContextKey,
			this._configHelper,
			this._terminalContainer,
			this._workspaceContextService.getWorkspace(),
			name,
			shell);
		terminalInstance.addDisposable(terminalInstance.onTitleChanged(this._onInstanceTitleChanged.fire, this._onInstanceTitleChanged));
		terminalInstance.addDisposable(terminalInstance.onClosed(this._onInstanceDisposed.fire, this._onInstanceDisposed));
		terminalInstance.addDisposable(terminalInstance.onProcessIdReady(this._onInstanceProcessIdReady.fire, this._onInstanceProcessIdReady));
		this.terminalInstances.push(terminalInstance);
		if (this.terminalInstances.length === 1) {
			// It's the first instance so it should be made active automatically
			this.setActiveInstanceByIndex(0);
		}
		this._onInstancesChanged.fire();
		return terminalInstance;
	}

	public getInstanceLabels(): string[] {
		return this._terminalInstances.map((instance, index) => `${index + 1}: ${instance.title}`);
	}

	private _removeInstance(terminalInstance: ITerminalInstance): void {
		let index = this.terminalInstances.indexOf(terminalInstance);
		let wasActiveInstance = terminalInstance === this.getActiveInstance();
		if (index !== -1) {
			this.terminalInstances.splice(index, 1);
		}
		if (wasActiveInstance && this.terminalInstances.length > 0) {
			let newIndex = index < this.terminalInstances.length ? index : this.terminalInstances.length - 1;
			this.setActiveInstanceByIndex(newIndex);
		}
		if (this.terminalInstances.length === 0) {
			this.hidePanel();
		}
		this._onInstancesChanged.fire();
		if (wasActiveInstance) {
			this._onActiveInstanceChanged.fire();
		}
	}

	public getActiveInstance(): ITerminalInstance {
		if (this.activeTerminalInstanceIndex < 0 || this.activeTerminalInstanceIndex >= this.terminalInstances.length) {
			return null;
		}
		return this.terminalInstances[this.activeTerminalInstanceIndex];
	}

	public getInstanceFromId(terminalId: number): ITerminalInstance {
		return this.terminalInstances[this._getIndexFromId(terminalId)];
	}

	public setActiveInstance(terminalInstance: ITerminalInstance): void {
		this.setActiveInstanceByIndex(this._getIndexFromId(terminalInstance.id));
	}

	public setActiveInstanceByIndex(terminalIndex: number): void {
		this._activeTerminalInstanceIndex = terminalIndex;
		this._terminalInstances.forEach((terminalInstance, i) => {
			terminalInstance.setVisible(i === terminalIndex);
		});
		this._onActiveInstanceChanged.fire();
	}

	public setActiveInstanceToNext(): void {
		if (this.terminalInstances.length <= 1) {
			return;
		}
		let newIndex = this._activeTerminalInstanceIndex + 1;
		if (newIndex >= this.terminalInstances.length) {
			newIndex = 0;
		}
		this.setActiveInstanceByIndex(newIndex);
	}

	public setActiveInstanceToPrevious(): void {
		if (this.terminalInstances.length <= 1) {
			return;
		}
		let newIndex = this._activeTerminalInstanceIndex - 1;
		if (newIndex < 0) {
			newIndex = this.terminalInstances.length - 1;
		}
		this.setActiveInstanceByIndex(newIndex);
	}

	public setContainers(panelContainer: Builder, terminalContainer: HTMLElement): void {
		this._configHelper.panelContainer = panelContainer;
		this._terminalContainer = terminalContainer;
		this._terminalInstances.forEach(terminalInstance => {
			terminalInstance.attachToElement(this._terminalContainer);
		});
	}

	public showPanel(focus?: boolean): TPromise<void> {
		return new TPromise<void>((complete) => {
			let panel = this._panelService.getActivePanel();
			if (!panel || panel.getId() !== TERMINAL_PANEL_ID) {
				return this._panelService.openPanel(TERMINAL_PANEL_ID, focus).then(() => {
					if (focus) {
						this.getActiveInstance().focus(true);
					}
					complete(void 0);
				});
			} else {
				if (focus) {
					this.getActiveInstance().focus(true);
				}
				complete(void 0);
			}
		});
	}

	public hidePanel(): void {
		const panel = this._panelService.getActivePanel();
		if (panel && panel.getId() === TERMINAL_PANEL_ID) {
			this._partService.setPanelHidden(true);
		}
	}

	private _getIndexFromId(terminalId: number): number {
		let terminalIndex = -1;
		this.terminalInstances.forEach((terminalInstance, i) => {
			if (terminalInstance.id === terminalId) {
				terminalIndex = i;
			}
		});
		if (terminalIndex === -1) {
			throw new Error(`Terminal with ID ${terminalId} does not exist (has it already been disposed?)`);
		}
		return terminalIndex;
	}
}
