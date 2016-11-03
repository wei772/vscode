/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { mixin } from 'vs/base/common/objects';
import Event, { Emitter } from 'vs/base/common/event';
import { WorkspaceConfiguration } from 'vscode';
import { ExtHostConfigurationShape, MainThreadConfigurationShape } from './extHost.protocol';
import { ConfigurationTarget } from 'vs/workbench/services/configuration/common/configurationEditing';

export class ExtHostConfiguration extends ExtHostConfigurationShape {

	private _proxy: MainThreadConfigurationShape;
	private _config: any;
	private _onDidChangeConfiguration = new Emitter<void>();

	constructor(proxy: MainThreadConfigurationShape, configuration: any) {
		super();
		this._proxy = proxy;
		this._config = configuration;
	}

	get onDidChangeConfiguration(): Event<void> {
		return this._onDidChangeConfiguration && this._onDidChangeConfiguration.event;
	}

	public $acceptConfigurationChanged(config: any) {
		this._config = config;
		this._onDidChangeConfiguration.fire(undefined);
	}

	public getConfiguration(section?: string): WorkspaceConfiguration {

		const config = section
			? ExtHostConfiguration._lookUp(section, this._config)
			: this._config;

		const result: WorkspaceConfiguration = {
			has(key: string): boolean {
				return typeof ExtHostConfiguration._lookUp(key, config) !== 'undefined';
			},
			get<T>(key: string, defaultValue?: T): T {
				let result = ExtHostConfiguration._lookUp(key, config);
				if (typeof result === 'undefined') {
					result = defaultValue;
				}
				return result;
			},
			update: (key: string, value: any, global: boolean = false) => {
				key = section ? `${section}.${key}` : key;
				const target = global ? ConfigurationTarget.USER : ConfigurationTarget.WORKSPACE;
				if (value !== void 0) {
					return this._proxy.$updateConfigurationOption(target, key, value);
				} else {
					return this._proxy.$removeConfigurationOption(target, key);
				}
			}
		};

		if (typeof config === 'object') {
			mixin(result, config, false);
		}

		return Object.freeze(result);
	}

	private static _lookUp(section: string, config: any) {
		if (!section) {
			return;
		}
		let parts = section.split('.');
		let node = config;
		while (node && parts.length) {
			node = node[parts.shift()];
		}

		return node;
	}
}
