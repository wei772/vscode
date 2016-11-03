/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { localize } from 'vs/nls';
import { IThreadService } from 'vs/workbench/services/thread/common/threadService';
import { IMarkerData } from 'vs/platform/markers/common/markers';
import URI from 'vs/base/common/uri';
import { compare } from 'vs/base/common/strings';
import Severity from 'vs/base/common/severity';
import * as vscode from 'vscode';
import { MainContext, MainThreadDiagnosticsShape, ExtHostDiagnosticsShape } from './extHost.protocol';
import { DiagnosticSeverity } from './extHostTypes';

export class DiagnosticCollection implements vscode.DiagnosticCollection {

	private static _maxDiagnosticsPerFile: number = 250;

	private _name: string;
	private _proxy: MainThreadDiagnosticsShape;

	private _isDisposed = false;
	private _data: { [uri: string]: vscode.Diagnostic[] } = Object.create(null);

	constructor(name: string, proxy: MainThreadDiagnosticsShape) {
		this._name = name;
		this._proxy = proxy;
	}

	dispose(): void {
		if (!this._isDisposed) {
			this._proxy.$clear(this.name);
			this._proxy = undefined;
			this._data = undefined;
			this._isDisposed = true;
		}
	}

	get name(): string {
		this._checkDisposed();
		return this._name;
	}

	set(uri: vscode.Uri, diagnostics: vscode.Diagnostic[]): void;
	set(entries: [vscode.Uri, vscode.Diagnostic[]][]): void;
	set(first: vscode.Uri | [vscode.Uri, vscode.Diagnostic[]][], diagnostics?: vscode.Diagnostic[]) {

		if (!first) {
			// this set-call is a clear-call
			this.clear();
			return;
		}

		// the actual implementation for #set

		this._checkDisposed();
		let toSync: vscode.Uri[];

		if (first instanceof URI) {

			if (!diagnostics) {
				// remove this entry
				this.delete(first);
				return;
			}

			// update single row
			this._data[first.toString()] = diagnostics;
			toSync = [first];

		} else if (Array.isArray(first)) {
			// update many rows
			toSync = [];
			let lastUri: vscode.Uri;
			for (const entry of first.slice(0).sort(DiagnosticCollection._compareTuplesByUri)) {
				const [uri, diagnostics] = entry;
				if (!lastUri || uri.toString() !== lastUri.toString()) {
					if (lastUri && this._data[lastUri.toString()].length === 0) {
						delete this._data[lastUri.toString()];
					}
					lastUri = uri;
					toSync.push(uri);
					this._data[uri.toString()] = [];
				}

				if (!diagnostics) {
					// [Uri, undefined] means clear this
					this._data[uri.toString()].length = 0;
				} else {
					this._data[uri.toString()].push(...diagnostics);
				}
			}
		}

		// compute change and send to main side
		const entries: [URI, IMarkerData[]][] = [];
		for (let uri of toSync) {
			let marker: IMarkerData[];
			let diagnostics = this._data[uri.toString()];
			if (diagnostics) {

				// no more than 250 diagnostics per file
				if (diagnostics.length > DiagnosticCollection._maxDiagnosticsPerFile) {
					marker = [];
					const order = [DiagnosticSeverity.Error, DiagnosticSeverity.Warning, DiagnosticSeverity.Information, DiagnosticSeverity.Hint];
					orderLoop: for (let i = 0; i < 4; i++) {
						for (let diagnostic of diagnostics) {
							if (diagnostic.severity === order[i]) {
								const len = marker.push(DiagnosticCollection._toMarkerData(diagnostic));
								if (len === DiagnosticCollection._maxDiagnosticsPerFile) {
									break orderLoop;
								}
							}
						}
					}

					// add 'signal' marker for showing omitted errors/warnings
					marker.push({
						severity: Severity.Error,
						message: localize({ key: 'limitHit', comment: ['amount of errors/warning skipped due to limits'] }, "Not showing {0} further errors and warnings.", diagnostics.length - DiagnosticCollection._maxDiagnosticsPerFile),
						startLineNumber: marker[marker.length - 1].startLineNumber,
						startColumn: marker[marker.length - 1].startColumn,
						endLineNumber: marker[marker.length - 1].endLineNumber,
						endColumn: marker[marker.length - 1].endColumn
					});
				} else {
					marker = diagnostics.map(DiagnosticCollection._toMarkerData);
				}
			}

			entries.push([<URI>uri, marker]);
		}

		this._proxy.$changeMany(this.name, entries);
	}

	delete(uri: vscode.Uri): void {
		this._checkDisposed();
		delete this._data[uri.toString()];
		this._proxy.$changeMany(this.name, [[<URI>uri, undefined]]);
	}

	clear(): void {
		this._checkDisposed();
		this._data = Object.create(null);
		this._proxy.$clear(this.name);
	}

	forEach(callback: (uri: URI, diagnostics: vscode.Diagnostic[], collection: DiagnosticCollection) => any, thisArg?: any): void {
		this._checkDisposed();
		for (let key in this._data) {
			let uri = URI.parse(key);
			callback.apply(thisArg, [uri, this.get(uri), this]);
		}
	}

	get(uri: URI): vscode.Diagnostic[] {
		this._checkDisposed();
		let result = this._data[uri.toString()];
		if (Array.isArray(result)) {
			return Object.freeze(result.slice(0));
		}
	}

	has(uri: URI): boolean {
		this._checkDisposed();
		return Array.isArray(this._data[uri.toString()]);
	}

	private _checkDisposed() {
		if (this._isDisposed) {
			throw new Error('illegal state - object is disposed');
		}
	}

	private static _toMarkerData(diagnostic: vscode.Diagnostic): IMarkerData {

		let range = diagnostic.range;

		return <IMarkerData>{
			startLineNumber: range.start.line + 1,
			startColumn: range.start.character + 1,
			endLineNumber: range.end.line + 1,
			endColumn: range.end.character + 1,
			message: diagnostic.message,
			source: diagnostic.source,
			severity: DiagnosticCollection._convertDiagnosticsSeverity(diagnostic.severity),
			code: String(diagnostic.code)
		};
	}

	private static _convertDiagnosticsSeverity(severity: number): Severity {
		switch (severity) {
			case 0: return Severity.Error;
			case 1: return Severity.Warning;
			case 2: return Severity.Info;
			case 3: return Severity.Ignore;
			default: return Severity.Error;
		}
	}

	private static _compareTuplesByUri(a: [vscode.Uri, vscode.Diagnostic[]], b: [vscode.Uri, vscode.Diagnostic[]]): number {
		return compare(a[0].toString(), b[0].toString());
	}
}

export class ExtHostDiagnostics extends ExtHostDiagnosticsShape {

	private static _idPool: number = 0;

	private _proxy: MainThreadDiagnosticsShape;
	private _collections: DiagnosticCollection[];

	constructor(threadService: IThreadService) {
		super();
		this._proxy = threadService.get(MainContext.MainThreadDiagnostics);
		this._collections = [];
	}

	createDiagnosticCollection(name: string): vscode.DiagnosticCollection {
		if (!name) {
			name = '_generated_diagnostic_collection_name_#' + ExtHostDiagnostics._idPool++;
		}

		const {_collections, _proxy} = this;
		const result = new class extends DiagnosticCollection {
			constructor() {
				super(name, _proxy);
				_collections.push(this);
			}
			dispose() {
				super.dispose();
				let idx = _collections.indexOf(this);
				if (idx !== -1) {
					_collections.splice(idx, 1);
				}
			}
		};

		return result;
	}

	forEach(callback: (collection: DiagnosticCollection) => any): void {
		this._collections.forEach(callback);
	}
}

