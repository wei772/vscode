/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { localize } from 'vs/nls';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { IMenu, MenuItemAction } from 'vs/platform/actions/common/actions';
import { IMessageService } from 'vs/platform/message/common/message';
import Severity from 'vs/base/common/severity';
import { IAction } from 'vs/base/common/actions';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { ActionItem, Separator } from 'vs/base/browser/ui/actionbar/actionbar';
import { domEvent } from 'vs/base/browser/event';
import { Emitter } from 'vs/base/common/event';


export function fillInActions(menu: IMenu, target: IAction[] | { primary: IAction[]; secondary: IAction[]; }): void {
	const groups = menu.getActions();
	if (groups.length === 0) {
		return;
	}

	for (let tuple of groups) {
		let [group, actions] = tuple;
		if (group === 'navigation') {

			const head = Array.isArray<IAction>(target) ? target : target.primary;

			// split contributed actions at the point where order
			// changes form lt zero to gte
			let pivot = 0;
			for (; pivot < actions.length; pivot++) {
				if ((<MenuItemAction>actions[pivot]).order >= 0) {
					break;
				}
			}
			// prepend contributed actions with order lte zero
			head.unshift(...actions.slice(0, pivot));

			// find the first separator which marks the end of the
			// navigation group - might be the whole array length
			let sep = 0;
			while (sep < head.length) {
				if (head[sep] instanceof Separator) {
					break;
				}
				sep++;
			}
			// append contributed actions with order gt zero
			head.splice(sep, 0, ...actions.slice(pivot));

		} else {
			if (Array.isArray<IAction>(target)) {
				target.push(new Separator(), ...actions);
			} else {
				target.secondary.push(new Separator(), ...actions);
			}
		}
	}
}


export function createActionItem(action: IAction, keybindingService: IKeybindingService, messageService: IMessageService): ActionItem {
	if (action instanceof MenuItemAction) {
		return new MenuItemActionItem(action, keybindingService, messageService);
	}
}


const _altKey = new class extends Emitter<boolean> {

	private _subscriptions: IDisposable[] = [];

	constructor() {
		super();

		this._subscriptions.push(domEvent(document.body, 'keydown')(e => this.fire(e.altKey)));
		this._subscriptions.push(domEvent(document.body, 'keyup')(e => this.fire(false)));
		this._subscriptions.push(domEvent(document.body, 'mouseleave')(e => this.fire(false)));
		this._subscriptions.push(domEvent(document.body, 'blur')(e => this.fire(false)));
	}

	dispose() {
		super.dispose();
		this._subscriptions = dispose(this._subscriptions);
	}
};

class MenuItemActionItem extends ActionItem {

	private _wantsAltCommand: boolean = false;

	constructor(
		action: MenuItemAction,
		@IKeybindingService private _keybindingService: IKeybindingService,
		@IMessageService private _messageService: IMessageService
	) {
		super(undefined, action, { icon: !!action.command.iconClass, label: !action.command.iconClass });
	}

	private get _command() {
		const {command, altCommand} = <MenuItemAction>this._action;
		return this._wantsAltCommand && altCommand || command;
	}

	onClick(event: MouseEvent): void {
		event.preventDefault();
		event.stopPropagation();

		(<MenuItemAction>this._action).run(this._wantsAltCommand).done(undefined, err => {
			this._messageService.show(Severity.Error, err);
		});
	}

	render(container: HTMLElement): void {
		super.render(container);

		let mouseOver = false;
		let altDown = false;

		const updateAltState = () => {
			const wantsAltCommand = mouseOver && altDown;
			if (wantsAltCommand !== this._wantsAltCommand) {
				this._wantsAltCommand = wantsAltCommand;
				this._updateLabel();
				this._updateTooltip();
				this._updateClass();
			}
		};

		this._callOnDispose.push(_altKey.event(value => {
			altDown = value;
			updateAltState();
		}));

		this._callOnDispose.push(domEvent(container, 'mouseleave')(_ => {
			mouseOver = false;
			updateAltState();
		}));

		this._callOnDispose.push(domEvent(container, 'mouseenter')(e => {
			mouseOver = true;
			updateAltState();
		}));
	}

	_updateLabel(): void {
		if (this.options.label) {
			this.$e.text(this._command.title);
		}
	}

	_updateTooltip(): void {
		const element = this.$e.getHTMLElement();
		const keybinding = this._keybindingService.lookupKeybindings(this._command.id)[0];
		const keybindingLabel = keybinding && this._keybindingService.getLabelFor(keybinding);

		element.title = keybindingLabel
			? localize('titleAndKb', "{0} ({1})", this._command.title, keybindingLabel)
			: this._command.title;
	}

	_updateClass(): void {
		if (this.options.icon) {
			const element = this.$e.getHTMLElement();
			const {command, altCommand} = (<MenuItemAction>this._action);
			if (this._command !== command) {
				element.classList.remove(command.iconClass);
			} else if (altCommand) {
				element.classList.remove(altCommand.iconClass);
			}
			element.classList.add('icon', this._command.iconClass);
		}
	}
}
