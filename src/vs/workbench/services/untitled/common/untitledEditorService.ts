/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import URI from 'vs/base/common/uri';
import { createDecorator, IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import arrays = require('vs/base/common/arrays');
import { UntitledEditorInput } from 'vs/workbench/common/editor/untitledEditorInput';
import Event, { Emitter, once } from 'vs/base/common/event';

export const IUntitledEditorService = createDecorator<IUntitledEditorService>('untitledEditorService');

export interface IUntitledEditorService {

	_serviceBrand: any;

	/**
	 * Events for when untitled editors change (e.g. getting dirty, saved or reverted).
	 */
	onDidChangeDirty: Event<URI>;

	/**
	 * Events for when untitled editor encodings change.
	 */
	onDidChangeEncoding: Event<URI>;

	/**
	 * Returns the untitled editor input matching the provided resource.
	 */
	get(resource: URI): UntitledEditorInput;

	/**
	 * Returns all untitled editor inputs.
	 */
	getAll(resources?: URI[]): UntitledEditorInput[];

	/**
	 * Returns dirty untitled editors as resource URIs.
	 */
	getDirty(): URI[];

	/**
	 * Returns true iff the provided resource is dirty.
	 */
	isDirty(resource: URI): boolean;

	/**
	 * Reverts the untitled resources if found.
	 */
	revertAll(resources?: URI[]): URI[];

	/**
	 * Creates a new untitled input with the optional resource URI or returns an existing one
	 * if the provided resource exists already as untitled input.
	 *
	 * It is valid to pass in a file resource. In that case the path will be used as identifier.
	 * The use case is to be able to create a new file with a specific path with VSCode.
	 */
	createOrGet(resource?: URI, modeId?: string): UntitledEditorInput;

	/**
	 * A check to find out if a untitled resource has a file path associated or not.
	 */
	hasAssociatedFilePath(resource: URI): boolean;
}

export class UntitledEditorService implements IUntitledEditorService {

	public _serviceBrand: any;

	private static CACHE: { [resource: string]: UntitledEditorInput } = Object.create(null);
	private static KNOWN_ASSOCIATED_FILE_PATHS: { [resource: string]: boolean } = Object.create(null);

	private _onDidChangeDirty: Emitter<URI>;
	private _onDidChangeEncoding: Emitter<URI>;

	constructor( @IInstantiationService private instantiationService: IInstantiationService) {
		this._onDidChangeDirty = new Emitter<URI>();
		this._onDidChangeEncoding = new Emitter<URI>();
	}

	public get onDidChangeDirty(): Event<URI> {
		return this._onDidChangeDirty.event;
	}

	public get onDidChangeEncoding(): Event<URI> {
		return this._onDidChangeEncoding.event;
	}

	public get(resource: URI): UntitledEditorInput {
		return UntitledEditorService.CACHE[resource.toString()];
	}

	public getAll(resources?: URI[]): UntitledEditorInput[] {
		if (resources) {
			return arrays.coalesce(resources.map((r) => this.get(r)));
		}

		return Object.keys(UntitledEditorService.CACHE).map((key) => UntitledEditorService.CACHE[key]);
	}

	public revertAll(resources?: URI[], force?: boolean): URI[] {
		const reverted: URI[] = [];

		const untitledInputs = this.getAll(resources);
		untitledInputs.forEach(input => {
			if (input) {
				input.revert();
				input.dispose();

				reverted.push(input.getResource());
			}
		});

		return reverted;
	}

	public isDirty(resource: URI): boolean {
		const input = this.get(resource);

		return input && input.isDirty();
	}

	public getDirty(): URI[] {
		return Object.keys(UntitledEditorService.CACHE)
			.map((key) => UntitledEditorService.CACHE[key])
			.filter((i) => i.isDirty())
			.map((i) => i.getResource());
	}

	public createOrGet(resource?: URI, modeId?: string): UntitledEditorInput {
		let hasAssociatedFilePath = false;
		if (resource) {
			hasAssociatedFilePath = (resource.scheme === 'file');
			resource = this.resourceToUntitled(resource); // ensure we have the right scheme

			if (hasAssociatedFilePath) {
				UntitledEditorService.KNOWN_ASSOCIATED_FILE_PATHS[resource.toString()] = true; // remember for future lookups
			}
		}

		// Return existing instance if asked for it
		if (resource && UntitledEditorService.CACHE[resource.toString()]) {
			return UntitledEditorService.CACHE[resource.toString()];
		}

		// Create new otherwise
		return this.doCreate(resource, hasAssociatedFilePath, modeId);
	}

	private doCreate(resource?: URI, hasAssociatedFilePath?: boolean, modeId?: string): UntitledEditorInput {
		if (!resource) {

			// Create new taking a resource URI that is not already taken
			let counter = Object.keys(UntitledEditorService.CACHE).length + 1;
			do {
				resource = URI.from({ scheme: UntitledEditorInput.SCHEMA, path: 'Untitled-' + counter });
				counter++;
			} while (Object.keys(UntitledEditorService.CACHE).indexOf(resource.toString()) >= 0);
		}

		const input = this.instantiationService.createInstance(UntitledEditorInput, resource, hasAssociatedFilePath, modeId);
		if (input.isDirty()) {
			setTimeout(() => {
				this._onDidChangeDirty.fire(resource);
			}, 0 /* prevent race condition between creating input and emitting dirty event */);
		}

		const dirtyListener = input.onDidChangeDirty(() => {
			this._onDidChangeDirty.fire(resource);
		});

		const encodingListener = input.onDidModelChangeEncoding(() => {
			this._onDidChangeEncoding.fire(resource);
		});

		// Remove from cache on dispose
		const onceDispose = once(input.onDispose);
		onceDispose(() => {
			delete UntitledEditorService.CACHE[input.getResource().toString()];
			delete UntitledEditorService.KNOWN_ASSOCIATED_FILE_PATHS[input.getResource().toString()];
			dirtyListener.dispose();
			encodingListener.dispose();
		});

		// Add to cache
		UntitledEditorService.CACHE[resource.toString()] = input;

		return input;
	}

	private resourceToUntitled(resource: URI): URI {
		if (resource.scheme === UntitledEditorInput.SCHEMA) {
			return resource;
		}

		return URI.from({ scheme: UntitledEditorInput.SCHEMA, path: resource.fsPath });
	}

	public hasAssociatedFilePath(resource: URI): boolean {
		return !!UntitledEditorService.KNOWN_ASSOCIATED_FILE_PATHS[resource.toString()];
	}

	public dispose(): void {
		this._onDidChangeDirty.dispose();
		this._onDidChangeEncoding.dispose();
	}
}