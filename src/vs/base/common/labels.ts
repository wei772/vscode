/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import URI from 'vs/base/common/uri';
import platform = require('vs/base/common/platform');
import types = require('vs/base/common/types');
import strings = require('vs/base/common/strings');
import paths = require('vs/base/common/paths');

export interface ILabelProvider {

	/**
	 * Given an element returns a label for it to display in the UI.
	 */
	getLabel(element: any): string;
}

export interface IWorkspaceProvider {
	getWorkspace(): {
		resource: URI;
	};
}

export class PathLabelProvider implements ILabelProvider {
	private root: string;

	constructor(arg1?: URI | string | IWorkspaceProvider) {
		this.root = arg1 && getPath(arg1);
	}

	public getLabel(arg1: URI | string | IWorkspaceProvider): string {
		return getPathLabel(getPath(arg1), this.root);
	}
}

export function getPathLabel(resource: URI | string, basePathProvider?: URI | string | IWorkspaceProvider): string {
	const absolutePath = getPath(resource);
	if (!absolutePath) {
		return null;
	}

	const basepath = basePathProvider && getPath(basePathProvider);

	if (basepath && paths.isEqualOrParent(absolutePath, basepath)) {
		if (basepath === absolutePath) {
			return ''; // no label if pathes are identical
		}

		return paths.normalize(strings.ltrim(absolutePath.substr(basepath.length), paths.nativeSep), true);
	}

	if (platform.isWindows && absolutePath && absolutePath[1] === ':') {
		return paths.normalize(absolutePath.charAt(0).toUpperCase() + absolutePath.slice(1), true); // convert c:\something => C:\something
	}

	return paths.normalize(absolutePath, true);
}

function getPath(arg1: URI | string | IWorkspaceProvider): string {
	if (!arg1) {
		return null;
	}

	if (typeof arg1 === 'string') {
		return arg1;
	}

	if (types.isFunction((<IWorkspaceProvider>arg1).getWorkspace)) {
		const ws = (<IWorkspaceProvider>arg1).getWorkspace();
		return ws ? ws.resource.fsPath : void 0;
	}

	return (<URI>arg1).fsPath;
}