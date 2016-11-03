/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import nls = require('vs/nls');
import errors = require('vs/base/common/errors');
import { IAction } from 'vs/base/common/actions';
import { SelectActionItem } from 'vs/base/browser/ui/actionbar/actionbar';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IDebugService, State, IGlobalConfig } from 'vs/workbench/parts/debug/common/debug';

export class DebugSelectActionItem extends SelectActionItem {

	constructor(
		action: IAction,
		@IDebugService private debugService: IDebugService,
		@IConfigurationService private configurationService: IConfigurationService
	) {
		super(null, action, [], -1);

		this.toDispose.push(configurationService.onDidUpdateConfiguration(e => {
			this.updateOptions(true);
		}));
		this.toDispose.push(this.debugService.getViewModel().onDidSelectConfigurationName(name => {
			this.updateOptions(false);
		}));
		this.toDispose.push(this.debugService.onDidChangeState(() => {
			this.enabled = this.debugService.state === State.Inactive;
		}));
	}

	public render(container: HTMLElement): void {
		super.render(container);
		this.updateOptions(true);
		this.enabled = this.debugService.state === State.Inactive;
	}

	private updateOptions(changeDebugConfiguration: boolean): void {
		const config = this.configurationService.getConfiguration<IGlobalConfig>('launch');
		if (!config || !config.configurations || config.configurations.length === 0) {
			this.setOptions([nls.localize('noConfigurations', "No Configurations")], 0);
		} else {
			const configurationNames = config.configurations.filter(cfg => !!cfg.name).map(cfg => cfg.name);
			const selected = configurationNames.indexOf(this.debugService.getViewModel().selectedConfigurationName);
			this.setOptions(configurationNames, selected);
		}

		if (changeDebugConfiguration) {
			this.actionRunner.run(this._action, this.getSelected()).done(null, errors.onUnexpectedError);
		}
	}
}
