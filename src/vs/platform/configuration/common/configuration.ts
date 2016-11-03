/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { TPromise } from 'vs/base/common/winjs.base';
import { createDecorator } from 'vs/platform/instantiation/common/instantiation';
import Event from 'vs/base/common/event';

export const IConfigurationService = createDecorator<IConfigurationService>('configurationService');

export interface IConfigurationService {
	_serviceBrand: any;

	/**
	 * Fetches the appropriate section of the configuration JSON file.
	 * This will be an object keyed off the section name.
	 */
	getConfiguration<T>(section?: string): T;

	/**
	 * Resolves a configuration key to its values in the different scopes
	 * the setting is defined.
	 */
	lookup<T>(key: string): IConfigurationValue<T>;

	/**
	 * Similar to #getConfiguration() but ensures that the latest configuration
	 * from disk is fetched.
	 */
	reloadConfiguration<T>(section?: string): TPromise<T>;

	/**
	 * Event that fires when the configuration changes.
	 */
	onDidUpdateConfiguration: Event<IConfigurationServiceEvent>;
}

export interface IConfigurationServiceEvent {
	config: any;
}

export interface IConfigurationValue<T> {
	value: T;
	default: T;
	user: T;
}

/**
 * A helper function to get the configuration value with a specific settings path (e.g. config.some.setting)
 */
export function getConfigurationValue<T>(config: any, settingPath: string, defaultValue?: T): T {
	function accessSetting(config: any, path: string[]): any {
		let current = config;
		for (let i = 0; i < path.length; i++) {
			current = current[path[i]];
			if (!current) {
				return undefined;
			}
		}
		return <T>current;
	}

	const path = settingPath.split('.');
	const result = accessSetting(config, path);

	return typeof result === 'undefined' ? defaultValue : result;
}