/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { IDisposable } from 'vs/base/common/lifecycle';
import { TPromise } from 'vs/base/common/winjs.base';
import { EditorModel, IEncodingSupport } from 'vs/workbench/common/editor';
import { StringEditorModel } from 'vs/workbench/common/editor/stringEditorModel';
import URI from 'vs/base/common/uri';
import { PLAINTEXT_MODE_ID } from 'vs/editor/common/modes/modesRegistry';
import { EndOfLinePreference } from 'vs/editor/common/editorCommon';
import { IFilesConfiguration } from 'vs/platform/files/common/files';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IModeService } from 'vs/editor/common/services/modeService';
import { IModelService } from 'vs/editor/common/services/modelService';
import { IMode } from 'vs/editor/common/modes';
import Event, { Emitter } from 'vs/base/common/event';

export class UntitledEditorModel extends StringEditorModel implements IEncodingSupport {
	private textModelChangeListener: IDisposable;
	private configurationChangeListener: IDisposable;

	private dirty: boolean;
	private _onDidChangeDirty: Emitter<void>;
	private _onDidChangeEncoding: Emitter<void>;

	private configuredEncoding: string;
	private preferredEncoding: string;

	private hasAssociatedFilePath: boolean;

	constructor(
		value: string,
		modeId: string,
		resource: URI,
		hasAssociatedFilePath: boolean,
		@IModeService modeService: IModeService,
		@IModelService modelService: IModelService,
		@IConfigurationService private configurationService: IConfigurationService
	) {
		super(value, modeId, resource, modeService, modelService);

		this.hasAssociatedFilePath = hasAssociatedFilePath;
		this.dirty = hasAssociatedFilePath; // untitled associated to file path are dirty right away

		this._onDidChangeDirty = new Emitter<void>();
		this._onDidChangeEncoding = new Emitter<void>();

		this.registerListeners();
	}

	public get onDidChangeDirty(): Event<void> {
		return this._onDidChangeDirty.event;
	}

	public get onDidChangeEncoding(): Event<void> {
		return this._onDidChangeEncoding.event;
	}

	protected getOrCreateMode(modeService: IModeService, modeId: string, firstLineText?: string): TPromise<IMode> {
		if (!modeId || modeId === PLAINTEXT_MODE_ID) {
			return modeService.getOrCreateModeByFilenameOrFirstLine(this.resource.fsPath, firstLineText); // lookup mode via resource path if the provided modeId is unspecific
		}

		return super.getOrCreateMode(modeService, modeId, firstLineText);
	}

	private registerListeners(): void {

		// Config Changes
		this.configurationChangeListener = this.configurationService.onDidUpdateConfiguration(e => this.onConfigurationChange(e.config));
	}

	private onConfigurationChange(configuration: IFilesConfiguration): void {
		this.configuredEncoding = configuration && configuration.files && configuration.files.encoding;
	}

	public getValue(): string {
		if (this.textEditorModel) {
			return this.textEditorModel.getValue(EndOfLinePreference.TextDefined, true /* Preserve BOM */);
		}

		return null;
	}

	public getModeId(): string {
		if (this.textEditorModel) {
			return this.textEditorModel.getModeId();
		}

		return null;
	}

	public getEncoding(): string {
		return this.preferredEncoding || this.configuredEncoding;
	}

	public setEncoding(encoding: string): void {
		const oldEncoding = this.getEncoding();
		this.preferredEncoding = encoding;

		// Emit if it changed
		if (oldEncoding !== this.preferredEncoding) {
			this._onDidChangeEncoding.fire();
		}
	}

	public isDirty(): boolean {
		return this.dirty;
	}

	public revert(): void {
		this.dirty = false;

		this._onDidChangeDirty.fire();
	}

	public load(): TPromise<EditorModel> {
		return super.load().then((model) => {
			const configuration = this.configurationService.getConfiguration<IFilesConfiguration>();

			// Encoding
			this.configuredEncoding = configuration && configuration.files && configuration.files.encoding;

			// Listen to content changes
			this.textModelChangeListener = this.textEditorModel.onDidChangeContent(e => this.onModelContentChanged());

			return model;
		});
	}

	private onModelContentChanged(): void {

		// mark the untitled editor as non-dirty once its content becomes empty and we do
		// not have an associated path set. we never want dirty indicator in that case.
		if (!this.hasAssociatedFilePath && this.textEditorModel.getLineCount() === 1 && this.textEditorModel.getLineContent(1) === '') {
			if (this.dirty) {
				this.dirty = false;
				this._onDidChangeDirty.fire();
			}
		}

		// turn dirty if we were not
		else if (!this.dirty) {
			this.dirty = true;
			this._onDidChangeDirty.fire();
		}
	}

	public dispose(): void {
		super.dispose();

		if (this.textModelChangeListener) {
			this.textModelChangeListener.dispose();
			this.textModelChangeListener = null;
		}

		if (this.configurationChangeListener) {
			this.configurationChangeListener.dispose();
			this.configurationChangeListener = null;
		}

		this._onDidChangeDirty.dispose();
		this._onDidChangeEncoding.dispose();
	}
}