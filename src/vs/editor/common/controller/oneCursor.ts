/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { onUnexpectedError, illegalArgument } from 'vs/base/common/errors';
import * as strings from 'vs/base/common/strings';
import { ReplaceCommand, ReplaceCommandWithOffsetCursorState, ReplaceCommandWithoutChangingPosition } from 'vs/editor/common/commands/replaceCommand';
import { ShiftCommand } from 'vs/editor/common/commands/shiftCommand';
import { SurroundSelectionCommand } from 'vs/editor/common/commands/surroundSelectionCommand';
import { CursorMoveHelper, CursorMove, CursorMoveConfiguration, ICursorMoveHelperModel, IColumnSelectResult, IViewColumnSelectResult } from 'vs/editor/common/controller/cursorMoveHelper';
import { Position } from 'vs/editor/common/core/position';
import { Range } from 'vs/editor/common/core/range';
import { Selection, SelectionDirection } from 'vs/editor/common/core/selection';
import * as editorCommon from 'vs/editor/common/editorCommon';
import { IndentAction } from 'vs/editor/common/modes/languageConfiguration';
import { LanguageConfigurationRegistry } from 'vs/editor/common/modes/languageConfigurationRegistry';
import { CharCode } from 'vs/base/common/charCode';
import { CharacterClassifier } from 'vs/editor/common/core/characterClassifier';
import { IElectricAction } from 'vs/editor/common/modes/supports/electricCharacter';
import { IDisposable } from 'vs/base/common/lifecycle';

export interface IPostOperationRunnable {
	(ctx: IOneCursorOperationContext): void;
}

export interface IOneCursorOperationContext {
	cursorPositionChangeReason: editorCommon.CursorChangeReason;
	shouldReveal: boolean;
	shouldRevealVerticalInCenter: boolean;
	shouldRevealHorizontal: boolean;
	shouldPushStackElementBefore: boolean;
	shouldPushStackElementAfter: boolean;
	executeCommand: editorCommon.ICommand;
	isAutoWhitespaceCommand: boolean;
	postOperationRunnable: IPostOperationRunnable;
}

export interface IModeConfiguration {

	electricChars: {
		[key: string]: boolean;
	};

	autoClosingPairsOpen: {
		[key: string]: string;
	};

	autoClosingPairsClose: {
		[key: string]: string;
	};

	surroundingPairs: {
		[key: string]: string;
	};
}

export interface CursorMoveArguments extends editorCommon.CursorMoveArguments {
	pageSize?: number;
	isPaged?: boolean;
}

export interface IViewModelHelper {

	viewModel: ICursorMoveHelperModel;

	getCurrentCompletelyVisibleViewLinesRangeInViewport(): Range;
	getCurrentCompletelyVisibleModelLinesRangeInViewport(): Range;

	convertModelPositionToViewPosition(lineNumber: number, column: number): Position;
	convertModelRangeToViewRange(modelRange: Range): Range;

	convertViewToModelPosition(lineNumber: number, column: number): Position;
	convertViewSelectionToModelSelection(viewSelection: Selection): Selection;
	convertViewRangeToModelRange(viewRange: Range): Range;

	validateViewPosition(viewLineNumber: number, viewColumn: number, modelPosition: Position): Position;
	validateViewRange(viewStartLineNumber: number, viewStartColumn: number, viewEndLineNumber: number, viewEndColumn: number, modelRange: Range): Range;
}

export interface IOneCursorState {
	selectionStart: Range;
	viewSelectionStart: Range;
	position: Position;
	viewPosition: Position;
	leftoverVisibleColumns: number;
	selectionStartLeftoverVisibleColumns: number;
}

export interface IFindWordResult {
	/**
	 * The index where the word starts.
	 */
	start: number;
	/**
	 * The index where the word ends.
	 */
	end: number;
	/**
	 * The word type.
	 */
	wordType: WordType;
}

export const enum WordType {
	None = 0,
	Regular = 1,
	Separator = 2
};

const enum CharacterClass {
	Regular = 0,
	Whitespace = 1,
	WordSeparator = 2
};

export const enum WordNavigationType {
	WordStart = 0,
	WordEnd = 1
}

/**
 * Represents the cursor state on either the model or on the view model.
 */
export class CursorModelState {
	_cursorModelStateBrand: void;

	// --- selection can start as a range (think double click and drag)
	public readonly selectionStart: Range;
	public readonly selectionStartLeftoverVisibleColumns: number;
	public readonly position: Position;
	public readonly leftoverVisibleColumns: number;
	public readonly selection: Selection;

	constructor(
		selectionStart: Range,
		selectionStartLeftoverVisibleColumns: number,
		position: Position,
		leftoverVisibleColumns: number,
	) {
		this.selectionStart = selectionStart;
		this.selectionStartLeftoverVisibleColumns = selectionStartLeftoverVisibleColumns;
		this.position = position;
		this.leftoverVisibleColumns = leftoverVisibleColumns;
		this.selection = CursorModelState._computeSelection(this.selectionStart, this.position);
	}

	public withSelectionStartLeftoverVisibleColumns(selectionStartLeftoverVisibleColumns: number): CursorModelState {
		return new CursorModelState(
			this.selectionStart,
			selectionStartLeftoverVisibleColumns,
			this.position,
			this.leftoverVisibleColumns
		);
	}

	public withSelectionStart(selectionStart: Range): CursorModelState {
		return new CursorModelState(
			selectionStart,
			0,
			this.position,
			this.leftoverVisibleColumns
		);
	}

	public collapse(): CursorModelState {
		return new CursorModelState(
			new Range(this.position.lineNumber, this.position.column, this.position.lineNumber, this.position.column),
			0,
			this.position,
			0
		);
	}

	public move(inSelectionMode: boolean, position: Position, leftoverVisibleColumns: number): CursorModelState {
		if (inSelectionMode) {
			// move just position
			return new CursorModelState(
				this.selectionStart,
				this.selectionStartLeftoverVisibleColumns,
				position,
				leftoverVisibleColumns
			);
		} else {
			// move everything
			return new CursorModelState(
				new Range(position.lineNumber, position.column, position.lineNumber, position.column),
				leftoverVisibleColumns,
				position,
				leftoverVisibleColumns
			);
		}
	}

	private static _computeSelection(selectionStart: Range, position: Position): Selection {
		let startLineNumber: number, startColumn: number, endLineNumber: number, endColumn: number;
		if (selectionStart.isEmpty()) {
			startLineNumber = selectionStart.startLineNumber;
			startColumn = selectionStart.startColumn;
			endLineNumber = position.lineNumber;
			endColumn = position.column;
		} else {
			if (position.isBeforeOrEqual(selectionStart.getStartPosition())) {
				startLineNumber = selectionStart.endLineNumber;
				startColumn = selectionStart.endColumn;
				endLineNumber = position.lineNumber;
				endColumn = position.column;
			} else {
				startLineNumber = selectionStart.startLineNumber;
				startColumn = selectionStart.startColumn;
				endLineNumber = position.lineNumber;
				endColumn = position.column;
			}
		}
		return new Selection(
			startLineNumber,
			startColumn,
			endLineNumber,
			endColumn
		);
	}
}

export interface IOneCursor {
	readonly modelState: CursorModelState;
	readonly viewState: CursorModelState;
	readonly config: CursorMoveConfiguration;
}

export class OneCursor implements IOneCursor {

	// --- contextual state
	private readonly editorId: number;
	public readonly model: editorCommon.IModel;
	public readonly viewModel: ICursorMoveHelperModel;
	public readonly configuration: editorCommon.IConfiguration;
	private readonly viewModelHelper: IViewModelHelper;

	private readonly _modelOptionsListener: IDisposable;
	private readonly _configChangeListener: IDisposable;

	public modeConfiguration: IModeConfiguration;
	private helper: CursorHelper;
	public config: CursorMoveConfiguration;

	public modelState: CursorModelState;
	public viewState: CursorModelState;

	// --- bracket match decorations
	private bracketDecorations: string[];

	// --- computed properties
	private _selStartMarker: string;
	private _selEndMarker: string;

	constructor(
		editorId: number,
		model: editorCommon.IModel,
		configuration: editorCommon.IConfiguration,
		modeConfiguration: IModeConfiguration,
		viewModelHelper: IViewModelHelper
	) {
		this.editorId = editorId;
		this.model = model;
		this.configuration = configuration;
		this.modeConfiguration = modeConfiguration;
		this.viewModelHelper = viewModelHelper;
		this.viewModel = viewModelHelper.viewModel;

		this._recreateCursorHelper();

		this._modelOptionsListener = model.onDidChangeOptions(() => this._recreateCursorHelper());

		this._configChangeListener = this.configuration.onDidChange((e) => {
			if (e.layoutInfo) {
				// due to pageSize
				this._recreateCursorHelper();
			}
		});

		this.bracketDecorations = [];

		this._setState(
			new CursorModelState(new Range(1, 1, 1, 1), 0, new Position(1, 1), 0),
			new CursorModelState(new Range(1, 1, 1, 1), 0, new Position(1, 1), 0)
		);
	}

	private _recreateCursorHelper(): void {
		this.config = new CursorMoveConfiguration(
			this.model.getOptions().tabSize,
			this.getPageSize()
		);
		this.helper = new CursorHelper(this.model, this.configuration, this.config);
	}

	private _setState(modelState: CursorModelState, viewState: CursorModelState): void {
		this.modelState = modelState;
		this.viewState = viewState;

		this._selStartMarker = this._ensureMarker(this._selStartMarker, this.modelState.selection.startLineNumber, this.modelState.selection.startColumn, true);
		this._selEndMarker = this._ensureMarker(this._selEndMarker, this.modelState.selection.endLineNumber, this.modelState.selection.endColumn, false);
	}

	private _ensureMarker(markerId: string, lineNumber: number, column: number, stickToPreviousCharacter: boolean): string {
		if (!markerId) {
			return this.model._addMarker(lineNumber, column, stickToPreviousCharacter);
		} else {
			this.model._changeMarker(markerId, lineNumber, column);
			this.model._changeMarkerStickiness(markerId, stickToPreviousCharacter);
			return markerId;
		}
	}

	public saveState(): IOneCursorState {
		return {
			selectionStart: this.modelState.selectionStart,
			viewSelectionStart: this.viewState.selectionStart,
			position: this.modelState.position,
			viewPosition: this.viewState.position,
			leftoverVisibleColumns: this.modelState.leftoverVisibleColumns,
			selectionStartLeftoverVisibleColumns: this.modelState.selectionStartLeftoverVisibleColumns
		};
	}

	public restoreState(state: IOneCursorState): void {
		let position = this.model.validatePosition(state.position);
		let selectionStart: Range;
		if (state.selectionStart) {
			selectionStart = this.model.validateRange(state.selectionStart);
		} else {
			selectionStart = new Range(position.lineNumber, position.column, position.lineNumber, position.column);
		}

		let viewPosition = this.viewModelHelper.validateViewPosition(state.viewPosition.lineNumber, state.viewPosition.column, position);
		let viewSelectionStart: Range;
		if (state.viewSelectionStart) {
			viewSelectionStart = this.viewModelHelper.validateViewRange(state.viewSelectionStart.startLineNumber, state.viewSelectionStart.startColumn, state.viewSelectionStart.endLineNumber, state.viewSelectionStart.endColumn, selectionStart);
		} else {
			viewSelectionStart = this.viewModelHelper.convertModelRangeToViewRange(selectionStart);
		}

		this._setState(
			new CursorModelState(selectionStart, state.selectionStartLeftoverVisibleColumns, position, state.leftoverVisibleColumns),
			new CursorModelState(viewSelectionStart, state.selectionStartLeftoverVisibleColumns, viewPosition, state.leftoverVisibleColumns)
		);
	}

	public updateModeConfiguration(modeConfiguration: IModeConfiguration): void {
		this.modeConfiguration = modeConfiguration;
	}

	public duplicate(): OneCursor {
		let result = new OneCursor(this.editorId, this.model, this.configuration, this.modeConfiguration, this.viewModelHelper);
		result._setState(
			this.modelState,
			this.viewState
		);
		return result;
	}

	public dispose(): void {
		this._modelOptionsListener.dispose();
		this._configChangeListener.dispose();
		this.model._removeMarker(this._selStartMarker);
		this.model._removeMarker(this._selEndMarker);
		this.bracketDecorations = this.model.deltaDecorations(this.bracketDecorations, [], this.editorId);
	}

	public adjustBracketDecorations(): void {
		let bracketMatch: [Range, Range] = null;
		let selection = this.modelState.selection;
		if (selection.isEmpty()) {
			bracketMatch = this.model.matchBracket(this.modelState.position);
		}

		let newDecorations: editorCommon.IModelDeltaDecoration[] = [];
		if (bracketMatch) {
			let options: editorCommon.IModelDecorationOptions = {
				stickiness: editorCommon.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
				className: 'bracket-match'
			};
			newDecorations.push({ range: bracketMatch[0], options: options });
			newDecorations.push({ range: bracketMatch[1], options: options });
		}

		this.bracketDecorations = this.model.deltaDecorations(this.bracketDecorations, newDecorations, this.editorId);
	}



	public setSelection(selection: editorCommon.ISelection, viewSelection: editorCommon.ISelection = null): void {
		let position = this.model.validatePosition({
			lineNumber: selection.positionLineNumber,
			column: selection.positionColumn
		});
		let selectionStart = this.model.validatePosition({
			lineNumber: selection.selectionStartLineNumber,
			column: selection.selectionStartColumn
		});

		let viewPosition: Position;
		let viewSelectionStart: Position;

		if (viewSelection) {
			viewPosition = this.viewModelHelper.validateViewPosition(viewSelection.positionLineNumber, viewSelection.positionColumn, position);
			viewSelectionStart = this.viewModelHelper.validateViewPosition(viewSelection.selectionStartLineNumber, viewSelection.selectionStartColumn, selectionStart);
		} else {
			viewPosition = this.viewModelHelper.convertModelPositionToViewPosition(position.lineNumber, position.column);
			viewSelectionStart = this.viewModelHelper.convertModelPositionToViewPosition(selectionStart.lineNumber, selectionStart.column);
		}

		this._setState(
			new CursorModelState(new Range(selectionStart.lineNumber, selectionStart.column, selectionStart.lineNumber, selectionStart.column), 0, position, 0),
			new CursorModelState(new Range(viewSelectionStart.lineNumber, viewSelectionStart.column, viewSelectionStart.lineNumber, viewSelectionStart.column), 0, viewPosition, 0)
		);
	}

	// -------------------- START modifications

	public setSelectionStart(range: Range): void {
		this._setState(
			this.modelState.withSelectionStart(range),
			this.viewState.withSelectionStart(this.viewModelHelper.convertModelRangeToViewRange(range))
		);
	}

	public collapseSelection(): void {
		this._setState(
			this.modelState.collapse(),
			this.viewState.collapse()
		);
	}

	public moveModelPosition(inSelectionMode: boolean, lineNumber: number, column: number, leftoverVisibleColumns: number, ensureInEditableRange: boolean): void {
		let viewPosition = this.viewModelHelper.convertModelPositionToViewPosition(lineNumber, column);
		this._move(inSelectionMode, lineNumber, column, viewPosition.lineNumber, viewPosition.column, leftoverVisibleColumns, ensureInEditableRange);
	}

	public moveViewPosition(inSelectionMode: boolean, viewLineNumber: number, viewColumn: number, leftoverVisibleColumns: number, ensureInEditableRange: boolean): void {
		let modelPosition = this.viewModelHelper.convertViewToModelPosition(viewLineNumber, viewColumn);
		this._move(inSelectionMode, modelPosition.lineNumber, modelPosition.column, viewLineNumber, viewColumn, leftoverVisibleColumns, ensureInEditableRange);
	}

	private _move(inSelectionMode: boolean, lineNumber: number, column: number, viewLineNumber: number, viewColumn: number, leftoverVisibleColumns: number, ensureInEditableRange: boolean): void {

		if (ensureInEditableRange) {
			let editableRange = this.model.getEditableRange();

			if (lineNumber < editableRange.startLineNumber || (lineNumber === editableRange.startLineNumber && column < editableRange.startColumn)) {
				lineNumber = editableRange.startLineNumber;
				column = editableRange.startColumn;

				let viewPosition = this.viewModelHelper.convertModelPositionToViewPosition(lineNumber, column);
				viewLineNumber = viewPosition.lineNumber;
				viewColumn = viewPosition.column;
			} else if (lineNumber > editableRange.endLineNumber || (lineNumber === editableRange.endLineNumber && column > editableRange.endColumn)) {
				lineNumber = editableRange.endLineNumber;
				column = editableRange.endColumn;

				let viewPosition = this.viewModelHelper.convertModelPositionToViewPosition(lineNumber, column);
				viewLineNumber = viewPosition.lineNumber;
				viewColumn = viewPosition.column;
			}
		}

		this._setState(
			this.modelState.move(inSelectionMode, new Position(lineNumber, column), leftoverVisibleColumns),
			this.viewState.move(inSelectionMode, new Position(viewLineNumber, viewColumn), leftoverVisibleColumns)
		);
	}

	private _recoverSelectionFromMarkers(): Selection {
		let start = this.model._getMarker(this._selStartMarker);
		let end = this.model._getMarker(this._selEndMarker);

		if (this.modelState.selection.getDirection() === SelectionDirection.LTR) {
			return new Selection(start.lineNumber, start.column, end.lineNumber, end.column);
		}

		return new Selection(end.lineNumber, end.column, start.lineNumber, start.column);
	}

	public recoverSelectionFromMarkers(ctx: IOneCursorOperationContext): boolean {
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.RecoverFromMarkers;
		ctx.shouldPushStackElementBefore = true;
		ctx.shouldPushStackElementAfter = true;
		ctx.shouldReveal = false;
		ctx.shouldRevealHorizontal = false;

		let recoveredSelection = this._recoverSelectionFromMarkers();

		let selectionStart = new Range(recoveredSelection.selectionStartLineNumber, recoveredSelection.selectionStartColumn, recoveredSelection.selectionStartLineNumber, recoveredSelection.selectionStartColumn);
		let position = new Position(recoveredSelection.positionLineNumber, recoveredSelection.positionColumn);

		let viewSelectionStart = this.viewModelHelper.convertModelRangeToViewRange(selectionStart);
		let viewPosition = this.viewModelHelper.convertViewToModelPosition(position.lineNumber, position.column);

		this._setState(
			new CursorModelState(selectionStart, 0, position, 0),
			new CursorModelState(viewSelectionStart, 0, viewPosition, 0)
		);

		return true;
	}

	// -------------------- END modifications

	// -------------------- START reading API

	public getPageSize(): number {
		let c = this.configuration.editor;
		return Math.floor(c.layoutInfo.height / c.fontInfo.lineHeight) - 2;
	}

	public getValidViewPosition(): Position {
		return this.viewModelHelper.validateViewPosition(this.viewState.position.lineNumber, this.viewState.position.column, this.modelState.position);
	}

	public hasSelection(): boolean {
		return (!this.modelState.selection.isEmpty() || !this.modelState.selectionStart.isEmpty());
	}
	public getBracketsDecorations(): string[] {
		return this.bracketDecorations;
	}
	public setSelectionStartLeftoverVisibleColumns(value: number): void {
		this._setState(
			this.modelState.withSelectionStartLeftoverVisibleColumns(value),
			this.viewState.withSelectionStartLeftoverVisibleColumns(value)
		);
	}

	// -- utils
	public validatePosition(position: editorCommon.IPosition): Position {
		return this.model.validatePosition(position);
	}
	public validateViewPosition(viewLineNumber: number, viewColumn: number, modelPosition: Position): Position {
		return this.viewModelHelper.validateViewPosition(viewLineNumber, viewColumn, modelPosition);
	}
	public convertViewToModelPosition(lineNumber: number, column: number): editorCommon.IPosition {
		return this.viewModelHelper.convertViewToModelPosition(lineNumber, column);
	}
	public convertViewSelectionToModelSelection(viewSelection: Selection): Selection {
		return this.viewModelHelper.convertViewSelectionToModelSelection(viewSelection);
	}
	public convertModelPositionToViewPosition(lineNumber: number, column: number): editorCommon.IPosition {
		return this.viewModelHelper.convertModelPositionToViewPosition(lineNumber, column);
	}

	// -- model
	public getRangeToRevealModelLinesBeforeViewPortTop(noOfLinesBeforeTop: number): Range {
		let visibleModelRange = this.viewModelHelper.getCurrentCompletelyVisibleModelLinesRangeInViewport();

		let startLineNumber: number;
		if (this.model.getLineMinColumn(visibleModelRange.startLineNumber) !== visibleModelRange.startColumn) {
			// Start line is partially visible by wrapping so reveal start line
			startLineNumber = visibleModelRange.startLineNumber;
		} else {
			// Reveal previous line
			startLineNumber = visibleModelRange.startLineNumber - 1;
		}

		startLineNumber -= (noOfLinesBeforeTop - 1);
		startLineNumber = this.model.validateRange({ startLineNumber, startColumn: 1, endLineNumber: startLineNumber, endColumn: 1 }).startLineNumber;
		let startColumn = this.model.getLineMinColumn(startLineNumber);
		let endColumn = this.model.getLineMaxColumn(visibleModelRange.startLineNumber);

		return new Range(startLineNumber, startColumn, startLineNumber, endColumn);
	}
	public getRangeToRevealModelLinesAfterViewPortBottom(noOfLinesAfterBottom: number): Range {
		let visibleModelRange = this.viewModelHelper.getCurrentCompletelyVisibleModelLinesRangeInViewport();

		// Last line in the view port is not considered revealed because scroll bar would cover it
		// Hence consider last line to reveal in the range
		let startLineNumber = visibleModelRange.endLineNumber + (noOfLinesAfterBottom - 1);
		startLineNumber = this.model.validateRange({ startLineNumber, startColumn: 1, endLineNumber: startLineNumber, endColumn: 1 }).startLineNumber;
		let startColumn = this.model.getLineMinColumn(startLineNumber);
		let endColumn = this.model.getLineMaxColumn(startLineNumber);

		return new Range(startLineNumber, startColumn, startLineNumber, endColumn);
	}
	public getLineFromViewPortTop(lineFromTop: number = 1): number {
		let visibleRange = this.viewModelHelper.getCurrentCompletelyVisibleModelLinesRangeInViewport();
		let startColumn = this.model.getLineMinColumn(visibleRange.startLineNumber);
		// Use next line if the first line is partially visible
		let visibleLineNumber = visibleRange.startColumn === startColumn ? visibleRange.startLineNumber : visibleRange.startLineNumber + 1;
		visibleLineNumber = visibleLineNumber + lineFromTop - 1;
		return visibleLineNumber > visibleRange.endLineNumber ? visibleRange.endLineNumber : visibleLineNumber;
	}
	public getCenterLineInViewPort(): number {
		return Math.round((this.getLineFromViewPortTop() + this.getLineFromViewPortBottom() - 1) / 2);
	}
	public getLineFromViewPortBottom(lineFromBottom: number = 1): number {
		let visibleRange = this.viewModelHelper.getCurrentCompletelyVisibleModelLinesRangeInViewport();
		let visibleLineNumber = visibleRange.endLineNumber - (lineFromBottom - 1);
		return visibleLineNumber > visibleRange.startLineNumber ? visibleLineNumber : this.getLineFromViewPortTop();
	}
	public findPreviousWordOnLine(position: Position): IFindWordResult {
		return this.helper.findPreviousWordOnLine(position);
	}
	public findNextWordOnLine(position: Position): IFindWordResult {
		return this.helper.findNextWordOnLine(position);
	}
	public getColumnAtEndOfLine(lineNumber: number, column: number): number {
		return this.helper.getColumnAtEndOfLine(this.model, lineNumber, column);
	}
	public getVisibleColumnFromColumn(lineNumber: number, column: number): number {
		return this.helper.visibleColumnFromColumn(this.model, lineNumber, column);
	}
	public getViewVisibleColumnFromColumn(viewLineNumber: number, viewColumn: number): number {
		return this.helper.visibleColumnFromColumn(this.viewModelHelper.viewModel, viewLineNumber, viewColumn);
	}

	// -- view
	public isLastLineVisibleInViewPort(): boolean {
		return this.viewModelHelper.viewModel.getLineCount() <= this.getCompletelyVisibleViewLinesRangeInViewport().getEndPosition().lineNumber;
	}
	public getCompletelyVisibleViewLinesRangeInViewport(): Range {
		return this.viewModelHelper.getCurrentCompletelyVisibleViewLinesRangeInViewport();
	}
	public getRevealViewLinesRangeInViewport(): Range {
		let visibleRange = this.getCompletelyVisibleViewLinesRangeInViewport().cloneRange();
		if (!this.isLastLineVisibleInViewPort() && visibleRange.endLineNumber > visibleRange.startLineNumber) {
			visibleRange = new Range(
				visibleRange.startLineNumber,
				visibleRange.startColumn,
				visibleRange.endLineNumber - 1,
				this.viewModelHelper.viewModel.getLineLastNonWhitespaceColumn(visibleRange.endLineNumber - 1)
			);
		}
		return visibleRange;
	}
	public getViewLineCount(): number {
		return this.viewModelHelper.viewModel.getLineCount();
	}
	public getViewLineMaxColumn(lineNumber: number): number {
		return this.viewModelHelper.viewModel.getLineMaxColumn(lineNumber);
	}
	public getViewLineMinColumn(lineNumber: number): number {
		return this.viewModelHelper.viewModel.getLineMinColumn(lineNumber);
	}
	public getViewLineCenterColumn(lineNumber: number): number {
		return Math.round((this.getViewLineMaxColumn(lineNumber) + this.getViewLineMinColumn(lineNumber)) / 2);
	}
	public getViewLineSize(lineNumber: number): number {
		return this.getViewLineMaxColumn(lineNumber) - this.getViewLineMinColumn(lineNumber);
	}
	public getViewHalfLineSize(lineNumber: number): number {
		return Math.round(this.getViewLineSize(lineNumber) / 2);
	}
	public getViewLineFirstNonWhiteSpaceColumn(lineNumber: number): number {
		return this.viewModelHelper.viewModel.getLineFirstNonWhitespaceColumn(lineNumber);
	}
	public getViewLineLastNonWhiteSpaceColumn(lineNumber: number): number {
		return this.viewModelHelper.viewModel.getLineLastNonWhitespaceColumn(lineNumber);
	}
	public getColumnAtBeginningOfViewLine(lineNumber: number, column: number): number {
		return this.helper.getColumnAtBeginningOfLine(this.viewModelHelper.viewModel, lineNumber, column);
	}
	public getColumnAtEndOfViewLine(lineNumber: number, column: number): number {
		return this.helper.getColumnAtEndOfLine(this.viewModelHelper.viewModel, lineNumber, column);
	}
	public columnSelect(fromViewLineNumber: number, fromViewVisibleColumn: number, toViewLineNumber: number, toViewVisibleColumn: number): IColumnSelectResult {
		let r = this.helper.columnSelect(this.viewModelHelper.viewModel, fromViewLineNumber, fromViewVisibleColumn, toViewLineNumber, toViewVisibleColumn);
		return {
			reversed: r.reversed,
			viewSelections: r.viewSelections,
			selections: r.viewSelections.map(sel => this.convertViewSelectionToModelSelection(sel)),
			toLineNumber: toViewLineNumber,
			toVisualColumn: toViewVisibleColumn
		};
	}
	public getNearestRevealViewPositionInViewport(): Position {
		const position = this.viewState.position;
		const revealRange = this.getRevealViewLinesRangeInViewport();

		if (position.lineNumber < revealRange.startLineNumber) {
			return new Position(revealRange.startLineNumber, this.viewModelHelper.viewModel.getLineFirstNonWhitespaceColumn(revealRange.startLineNumber));
		}

		if (position.lineNumber > revealRange.endLineNumber) {
			return new Position(revealRange.endLineNumber, this.viewModelHelper.viewModel.getLineFirstNonWhitespaceColumn(revealRange.endLineNumber));
		}

		return position;
	}
	// -------------------- END reading API
}

export class OneCursorOp {

	// -------------------- START handlers that simply change cursor state
	public static jumpToBracket(cursor: OneCursor, ctx: IOneCursorOperationContext): boolean {
		let bracketDecorations = cursor.getBracketsDecorations();

		if (bracketDecorations.length !== 2) {
			return false;
		}

		let firstBracket = cursor.model.getDecorationRange(bracketDecorations[0]);
		let secondBracket = cursor.model.getDecorationRange(bracketDecorations[1]);

		let position = cursor.modelState.position;

		if (Utils.isPositionAtRangeEdges(position, firstBracket) || Utils.isPositionInsideRange(position, firstBracket)) {
			cursor.moveModelPosition(false, secondBracket.endLineNumber, secondBracket.endColumn, 0, false);
			return true;
		}

		if (Utils.isPositionAtRangeEdges(position, secondBracket) || Utils.isPositionInsideRange(position, secondBracket)) {
			cursor.moveModelPosition(false, firstBracket.endLineNumber, firstBracket.endColumn, 0, false);
			return true;
		}

		return false;
	}

	public static moveTo(cursor: OneCursor, inSelectionMode: boolean, position: editorCommon.IPosition, viewPosition: editorCommon.IPosition, eventSource: string, ctx: IOneCursorOperationContext): boolean {
		let validatedPosition = cursor.model.validatePosition(position);
		let validatedViewPosition: editorCommon.IPosition;
		if (viewPosition) {
			validatedViewPosition = cursor.validateViewPosition(viewPosition.lineNumber, viewPosition.column, validatedPosition);
		} else {
			validatedViewPosition = cursor.convertModelPositionToViewPosition(validatedPosition.lineNumber, validatedPosition.column);
		}

		let reason = (eventSource === 'mouse' ? editorCommon.CursorChangeReason.Explicit : editorCommon.CursorChangeReason.NotSet);
		if (eventSource === 'api') {
			ctx.shouldRevealVerticalInCenter = true;
		}
		if (reason) {
			ctx.cursorPositionChangeReason = reason;
		}
		cursor.moveViewPosition(inSelectionMode, validatedViewPosition.lineNumber, validatedViewPosition.column, 0, false);
		return true;
	}

	public static move(cursor: OneCursor, moveParams: CursorMoveArguments, eventSource: string, ctx: IOneCursorOperationContext): boolean {
		if (!moveParams.to) {
			illegalArgument('to');
		}

		let inSelectionMode = !!moveParams.select;
		let validatedViewPosition = cursor.getValidViewPosition();
		let viewLineNumber = validatedViewPosition.lineNumber;
		let viewColumn;
		switch (moveParams.to) {
			case editorCommon.CursorMovePosition.Left:
				return this.moveLeft(cursor, inSelectionMode, editorCommon.CursorMoveByUnit.HalfLine === moveParams.by ? cursor.getViewHalfLineSize(viewLineNumber) : moveParams.value, ctx);
			case editorCommon.CursorMovePosition.Right:
				return this.moveRight(cursor, inSelectionMode, editorCommon.CursorMoveByUnit.HalfLine === moveParams.by ? cursor.getViewHalfLineSize(viewLineNumber) : moveParams.value, ctx);
			case editorCommon.CursorMovePosition.Up:
				return this.moveUp(cursor, moveParams, ctx);
			case editorCommon.CursorMovePosition.Down:
				return this.moveDown(cursor, moveParams, ctx);
			case editorCommon.CursorMovePosition.WrappedLineStart:
				viewColumn = cursor.getViewLineMinColumn(viewLineNumber);
				break;
			case editorCommon.CursorMovePosition.WrappedLineFirstNonWhitespaceCharacter:
				viewColumn = cursor.getViewLineFirstNonWhiteSpaceColumn(viewLineNumber);
				break;
			case editorCommon.CursorMovePosition.WrappedLineColumnCenter:
				viewColumn = cursor.getViewLineCenterColumn(viewLineNumber);
				break;
			case editorCommon.CursorMovePosition.WrappedLineEnd:
				viewColumn = cursor.getViewLineMaxColumn(viewLineNumber);
				break;
			case editorCommon.CursorMovePosition.WrappedLineLastNonWhitespaceCharacter:
				viewColumn = cursor.getViewLineLastNonWhiteSpaceColumn(viewLineNumber);
				break;
			case editorCommon.CursorMovePosition.ViewPortTop:
				viewLineNumber = cursor.convertModelPositionToViewPosition(cursor.getLineFromViewPortTop(moveParams.value), 1).lineNumber;
				viewColumn = cursor.getViewLineFirstNonWhiteSpaceColumn(viewLineNumber);
				break;
			case editorCommon.CursorMovePosition.ViewPortBottom:
				viewLineNumber = cursor.convertModelPositionToViewPosition(cursor.getLineFromViewPortBottom(moveParams.value), 1).lineNumber;;
				viewColumn = cursor.getViewLineFirstNonWhiteSpaceColumn(viewLineNumber);
				break;
			case editorCommon.CursorMovePosition.ViewPortCenter:
				viewLineNumber = cursor.convertModelPositionToViewPosition(cursor.getCenterLineInViewPort(), 1).lineNumber;;
				viewColumn = cursor.getViewLineFirstNonWhiteSpaceColumn(viewLineNumber);
				break;
			case editorCommon.CursorMovePosition.ViewPortIfOutside:
				const position = cursor.getNearestRevealViewPositionInViewport();
				viewLineNumber = position.lineNumber;
				viewColumn = position.column;
				break;
			default:
				return false;
		}
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		cursor.moveViewPosition(inSelectionMode, viewLineNumber, viewColumn, 0, true);
		return true;
	}

	private static _columnSelectOp(cursor: OneCursor, toViewLineNumber: number, toViewVisualColumn: number): IColumnSelectResult {
		let viewStartSelection = cursor.viewState.selection;
		let fromVisibleColumn = cursor.getViewVisibleColumnFromColumn(viewStartSelection.selectionStartLineNumber, viewStartSelection.selectionStartColumn);

		return cursor.columnSelect(viewStartSelection.selectionStartLineNumber, fromVisibleColumn, toViewLineNumber, toViewVisualColumn);
	}

	public static columnSelectMouse(cursor: OneCursor, position: editorCommon.IPosition, viewPosition: editorCommon.IPosition, toViewVisualColumn: number): IColumnSelectResult {
		let validatedPosition = cursor.model.validatePosition(position);
		let validatedViewPosition: editorCommon.IPosition;
		if (viewPosition) {
			validatedViewPosition = cursor.validateViewPosition(viewPosition.lineNumber, viewPosition.column, validatedPosition);
		} else {
			validatedViewPosition = cursor.convertModelPositionToViewPosition(validatedPosition.lineNumber, validatedPosition.column);
		}

		return this._columnSelectOp(cursor, validatedViewPosition.lineNumber, toViewVisualColumn);
	}

	public static columnSelectLeft(cursor: OneCursor, toViewLineNumber: number, toViewVisualColumn: number): IColumnSelectResult {
		if (toViewVisualColumn > 1) {
			toViewVisualColumn--;
		}

		return this._columnSelectOp(cursor, toViewLineNumber, toViewVisualColumn);
	}

	public static columnSelectRight(cursor: OneCursor, toViewLineNumber: number, toViewVisualColumn: number): IColumnSelectResult {

		let maxVisualViewColumn = 0;
		let minViewLineNumber = Math.min(cursor.viewState.position.lineNumber, toViewLineNumber);
		let maxViewLineNumber = Math.max(cursor.viewState.position.lineNumber, toViewLineNumber);
		for (let lineNumber = minViewLineNumber; lineNumber <= maxViewLineNumber; lineNumber++) {
			let lineMaxViewColumn = cursor.getViewLineMaxColumn(lineNumber);
			let lineMaxVisualViewColumn = cursor.getViewVisibleColumnFromColumn(lineNumber, lineMaxViewColumn);
			maxVisualViewColumn = Math.max(maxVisualViewColumn, lineMaxVisualViewColumn);
		}

		if (toViewVisualColumn < maxVisualViewColumn) {
			toViewVisualColumn++;
		}

		return this._columnSelectOp(cursor, toViewLineNumber, toViewVisualColumn);
	}

	public static columnSelectUp(isPaged: boolean, cursor: OneCursor, toViewLineNumber: number, toViewVisualColumn: number): IColumnSelectResult {
		let linesCount = isPaged ? cursor.getPageSize() : 1;

		toViewLineNumber -= linesCount;
		if (toViewLineNumber < 1) {
			toViewLineNumber = 1;
		}

		return this._columnSelectOp(cursor, toViewLineNumber, toViewVisualColumn);
	}

	public static columnSelectDown(isPaged: boolean, cursor: OneCursor, toViewLineNumber: number, toViewVisualColumn: number): IColumnSelectResult {
		let linesCount = isPaged ? cursor.getPageSize() : 1;

		toViewLineNumber += linesCount;
		if (toViewLineNumber > cursor.getViewLineCount()) {
			toViewLineNumber = cursor.getViewLineCount();
		}

		return this._columnSelectOp(cursor, toViewLineNumber, toViewVisualColumn);
	}

	public static moveLeft(cursor: OneCursor, inSelectionMode: boolean, noOfColumns: number = 1, ctx: IOneCursorOperationContext): boolean {
		let viewLineNumber: number,
			viewColumn: number;

		if (cursor.hasSelection() && !inSelectionMode) {
			// If we are in selection mode, move left without selection cancels selection and puts cursor at the beginning of the selection
			let viewSelection = cursor.viewState.selection;
			let viewSelectionStart = cursor.validateViewPosition(viewSelection.startLineNumber, viewSelection.startColumn, cursor.modelState.selection.getStartPosition());
			viewLineNumber = viewSelectionStart.lineNumber;
			viewColumn = viewSelectionStart.column;
		} else {
			let validatedViewPosition = cursor.getValidViewPosition();
			let r = CursorMove.left(cursor.config, cursor.viewModel, validatedViewPosition.lineNumber, validatedViewPosition.column - (noOfColumns - 1));
			viewLineNumber = r.lineNumber;
			viewColumn = r.column;
		}

		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		cursor.moveViewPosition(inSelectionMode, viewLineNumber, viewColumn, 0, true);
		return true;
	}

	public static moveWordLeft(cursor: OneCursor, inSelectionMode: boolean, wordNavigationType: WordNavigationType, ctx: IOneCursorOperationContext): boolean {
		let position = cursor.modelState.position;
		let lineNumber = position.lineNumber;
		let column = position.column;

		if (column === 1) {
			if (lineNumber > 1) {
				lineNumber = lineNumber - 1;
				column = cursor.model.getLineMaxColumn(lineNumber);
			}
		}

		let prevWordOnLine = cursor.findPreviousWordOnLine(new Position(lineNumber, column));

		if (wordNavigationType === WordNavigationType.WordStart) {
			if (prevWordOnLine) {
				column = prevWordOnLine.start + 1;
			} else {
				column = 1;
			}
		} else {
			if (prevWordOnLine && column <= prevWordOnLine.end + 1) {
				prevWordOnLine = cursor.findPreviousWordOnLine(new Position(lineNumber, prevWordOnLine.start + 1));
			}
			if (prevWordOnLine) {
				column = prevWordOnLine.end + 1;
			} else {
				column = 1;
			}
		}

		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		cursor.moveModelPosition(inSelectionMode, lineNumber, column, 0, true);
		return true;
	}

	public static moveRight(cursor: OneCursor, inSelectionMode: boolean, noOfColumns: number = 1, ctx: IOneCursorOperationContext): boolean {
		let viewLineNumber: number,
			viewColumn: number;

		if (cursor.hasSelection() && !inSelectionMode) {
			// If we are in selection mode, move right without selection cancels selection and puts cursor at the end of the selection
			let viewSelection = cursor.viewState.selection;
			let viewSelectionEnd = cursor.validateViewPosition(viewSelection.endLineNumber, viewSelection.endColumn, cursor.modelState.selection.getEndPosition());
			viewLineNumber = viewSelectionEnd.lineNumber;
			viewColumn = viewSelectionEnd.column;
		} else {
			let validatedViewPosition = cursor.getValidViewPosition();
			let r = CursorMove.right(cursor.config, cursor.viewModel, validatedViewPosition.lineNumber, validatedViewPosition.column + (noOfColumns - 1));
			viewLineNumber = r.lineNumber;
			viewColumn = r.column;
		}

		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		cursor.moveViewPosition(inSelectionMode, viewLineNumber, viewColumn, 0, true);
		return true;
	}

	public static moveWordRight(cursor: OneCursor, inSelectionMode: boolean, wordNavigationType: WordNavigationType, ctx: IOneCursorOperationContext): boolean {
		let position = cursor.modelState.position;
		let lineNumber = position.lineNumber;
		let column = position.column;

		if (column === cursor.model.getLineMaxColumn(lineNumber)) {
			if (lineNumber < cursor.model.getLineCount()) {
				lineNumber = lineNumber + 1;
				column = 1;
			}
		}

		let nextWordOnLine = cursor.findNextWordOnLine(new Position(lineNumber, column));

		if (wordNavigationType === WordNavigationType.WordEnd) {
			if (nextWordOnLine) {
				column = nextWordOnLine.end + 1;
			} else {
				column = cursor.model.getLineMaxColumn(lineNumber);
			}
		} else {
			if (nextWordOnLine && column >= nextWordOnLine.start + 1) {
				nextWordOnLine = cursor.findNextWordOnLine(new Position(lineNumber, nextWordOnLine.end + 1));
			}
			if (nextWordOnLine) {
				column = nextWordOnLine.start + 1;
			} else {
				column = cursor.model.getLineMaxColumn(lineNumber);
			}
		}

		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		cursor.moveModelPosition(inSelectionMode, lineNumber, column, 0, true);
		return true;
	}

	public static moveDown(cursor: OneCursor, moveArguments: CursorMoveArguments, ctx: IOneCursorOperationContext): boolean {
		let linesCount = (moveArguments.isPaged ? (moveArguments.pageSize || cursor.getPageSize()) : moveArguments.value) || 1;
		if (editorCommon.CursorMoveByUnit.WrappedLine === moveArguments.by) {
			return this._moveDownByViewLines(cursor, moveArguments.select, linesCount, ctx);
		}
		return this._moveDownByModelLines(cursor, moveArguments.select, linesCount, ctx);
	}

	private static _moveDownByViewLines(cursor: OneCursor, inSelectionMode: boolean, linesCount: number, ctx: IOneCursorOperationContext): boolean {
		let viewLineNumber: number,
			viewColumn: number;

		if (cursor.hasSelection() && !inSelectionMode) {
			// If we are in selection mode, move down acts relative to the end of selection
			let viewSelection = cursor.viewState.selection;
			let viewSelectionEnd = cursor.validateViewPosition(viewSelection.endLineNumber, viewSelection.endColumn, cursor.modelState.selection.getEndPosition());
			viewLineNumber = viewSelectionEnd.lineNumber;
			viewColumn = viewSelectionEnd.column;
		} else {
			let validatedViewPosition = cursor.getValidViewPosition();
			viewLineNumber = validatedViewPosition.lineNumber;
			viewColumn = validatedViewPosition.column;
		}

		let r = CursorMove.down(cursor.config, cursor.viewModel, viewLineNumber, viewColumn, cursor.viewState.leftoverVisibleColumns, linesCount, true);
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		cursor.moveViewPosition(inSelectionMode, r.lineNumber, r.column, r.leftoverVisibleColumns, true);
		return true;
	}

	private static _moveDownByModelLines(cursor: OneCursor, inSelectionMode: boolean, linesCount: number, ctx: IOneCursorOperationContext): boolean {
		let lineNumber: number,
			column: number;

		if (cursor.hasSelection() && !inSelectionMode) {
			// If we are in selection mode, move down acts relative to the end of selection
			let selection = cursor.modelState.selection;
			lineNumber = selection.endLineNumber;
			column = selection.endColumn;
		} else {
			let position = cursor.modelState.position;
			lineNumber = position.lineNumber;
			column = position.column;
		}

		let r = CursorMove.down(cursor.config, cursor.model, lineNumber, column, cursor.modelState.leftoverVisibleColumns, linesCount, true);
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		cursor.moveModelPosition(inSelectionMode, r.lineNumber, r.column, r.leftoverVisibleColumns, true);
		return true;
	}

	public static translateDown(cursor: OneCursor, ctx: IOneCursorOperationContext): boolean {

		let selection = cursor.viewState.selection;

		let selectionStart = CursorMove.down(cursor.config, cursor.viewModel, selection.selectionStartLineNumber, selection.selectionStartColumn, cursor.viewState.selectionStartLeftoverVisibleColumns, 1, false);
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		cursor.moveViewPosition(false, selectionStart.lineNumber, selectionStart.column, cursor.viewState.leftoverVisibleColumns, true);

		let position = CursorMove.down(cursor.config, cursor.viewModel, selection.positionLineNumber, selection.positionColumn, cursor.viewState.leftoverVisibleColumns, 1, false);
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		cursor.moveViewPosition(true, position.lineNumber, position.column, position.leftoverVisibleColumns, true);

		cursor.setSelectionStartLeftoverVisibleColumns(selectionStart.leftoverVisibleColumns);

		return true;
	}

	public static moveUp(cursor: OneCursor, moveArguments: CursorMoveArguments, ctx: IOneCursorOperationContext): boolean {
		let linesCount = (moveArguments.isPaged ? (moveArguments.pageSize || cursor.getPageSize()) : moveArguments.value) || 1;
		if (editorCommon.CursorMoveByUnit.WrappedLine === moveArguments.by) {
			return this._moveUpByViewLines(cursor, moveArguments.select, linesCount, ctx);
		}
		return this._moveUpByModelLines(cursor, moveArguments.select, linesCount, ctx);
	}

	private static _moveUpByViewLines(cursor: OneCursor, inSelectionMode: boolean, linesCount: number, ctx: IOneCursorOperationContext): boolean {

		let viewLineNumber: number,
			viewColumn: number;

		if (cursor.hasSelection() && !inSelectionMode) {
			// If we are in selection mode, move up acts relative to the beginning of selection
			let viewSelection = cursor.viewState.selection;
			let viewSelectionStart = cursor.validateViewPosition(viewSelection.startLineNumber, viewSelection.startColumn, cursor.modelState.selection.getStartPosition());
			viewLineNumber = viewSelectionStart.lineNumber;
			viewColumn = viewSelectionStart.column;
		} else {
			let validatedViewPosition = cursor.getValidViewPosition();
			viewLineNumber = validatedViewPosition.lineNumber;
			viewColumn = validatedViewPosition.column;
		}

		let r = CursorMove.up(cursor.config, cursor.viewModel, viewLineNumber, viewColumn, cursor.viewState.leftoverVisibleColumns, linesCount, true);
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		cursor.moveViewPosition(inSelectionMode, r.lineNumber, r.column, r.leftoverVisibleColumns, true);

		return true;
	}

	private static _moveUpByModelLines(cursor: OneCursor, inSelectionMode: boolean, linesCount: number, ctx: IOneCursorOperationContext): boolean {
		let lineNumber: number,
			column: number;

		if (cursor.hasSelection() && !inSelectionMode) {
			// If we are in selection mode, move up acts relative to the beginning of selection
			let selection = cursor.modelState.selection;
			lineNumber = selection.startLineNumber;
			column = selection.startColumn;
		} else {
			let position = cursor.modelState.position;
			lineNumber = position.lineNumber;
			column = position.column;
		}

		let r = CursorMove.up(cursor.config, cursor.model, lineNumber, column, cursor.modelState.leftoverVisibleColumns, linesCount, true);
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		cursor.moveModelPosition(inSelectionMode, r.lineNumber, r.column, r.leftoverVisibleColumns, true);

		return true;
	}

	public static translateUp(cursor: OneCursor, ctx: IOneCursorOperationContext): boolean {

		let selection = cursor.viewState.selection;

		let selectionStart = CursorMove.up(cursor.config, cursor.viewModel, selection.selectionStartLineNumber, selection.selectionStartColumn, cursor.viewState.selectionStartLeftoverVisibleColumns, 1, false);
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		cursor.moveViewPosition(false, selectionStart.lineNumber, selectionStart.column, cursor.viewState.leftoverVisibleColumns, true);

		let position = CursorMove.up(cursor.config, cursor.viewModel, selection.positionLineNumber, selection.positionColumn, cursor.viewState.leftoverVisibleColumns, 1, false);
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		cursor.moveViewPosition(true, position.lineNumber, position.column, position.leftoverVisibleColumns, true);

		cursor.setSelectionStartLeftoverVisibleColumns(selectionStart.leftoverVisibleColumns);

		return true;
	}

	public static moveToBeginningOfLine(cursor: OneCursor, inSelectionMode: boolean, ctx: IOneCursorOperationContext): boolean {
		let validatedViewPosition = cursor.getValidViewPosition();
		let viewLineNumber = validatedViewPosition.lineNumber;
		let viewColumn = validatedViewPosition.column;

		viewColumn = cursor.getColumnAtBeginningOfViewLine(viewLineNumber, viewColumn);
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		cursor.moveViewPosition(inSelectionMode, viewLineNumber, viewColumn, 0, true);
		return true;
	}

	public static moveToEndOfLine(cursor: OneCursor, inSelectionMode: boolean, ctx: IOneCursorOperationContext): boolean {
		let validatedViewPosition = cursor.getValidViewPosition();
		let viewLineNumber = validatedViewPosition.lineNumber;
		let viewColumn = validatedViewPosition.column;

		viewColumn = cursor.getColumnAtEndOfViewLine(viewLineNumber, viewColumn);
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		cursor.moveViewPosition(inSelectionMode, viewLineNumber, viewColumn, 0, true);
		return true;
	}

	public static expandLineSelection(cursor: OneCursor, ctx: IOneCursorOperationContext): boolean {
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		let viewSel = cursor.viewState.selection;

		let viewStartLineNumber = viewSel.startLineNumber;
		let viewStartColumn = viewSel.startColumn;
		let viewEndLineNumber = viewSel.endLineNumber;
		let viewEndColumn = viewSel.endColumn;

		let viewEndMaxColumn = cursor.getViewLineMaxColumn(viewEndLineNumber);
		if (viewStartColumn !== 1 || viewEndColumn !== viewEndMaxColumn) {
			viewStartColumn = 1;
			viewEndColumn = viewEndMaxColumn;
		} else {
			// Expand selection with one more line down
			let moveResult = CursorMove.down(cursor.config, cursor.viewModel, viewEndLineNumber, viewEndColumn, 0, 1, true);
			viewEndLineNumber = moveResult.lineNumber;
			viewEndColumn = cursor.getViewLineMaxColumn(viewEndLineNumber);
		}

		cursor.moveViewPosition(false, viewStartLineNumber, viewStartColumn, 0, true);
		cursor.moveViewPosition(true, viewEndLineNumber, viewEndColumn, 0, true);
		return true;
	}

	public static moveToBeginningOfBuffer(cursor: OneCursor, inSelectionMode: boolean, ctx: IOneCursorOperationContext): boolean {
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		cursor.moveModelPosition(inSelectionMode, 1, 1, 0, true);
		return true;
	}

	public static moveToEndOfBuffer(cursor: OneCursor, inSelectionMode: boolean, ctx: IOneCursorOperationContext): boolean {
		let lastLineNumber = cursor.model.getLineCount();
		let lastColumn = cursor.model.getLineMaxColumn(lastLineNumber);

		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		cursor.moveModelPosition(inSelectionMode, lastLineNumber, lastColumn, 0, true);
		return true;
	}

	public static selectAll(cursor: OneCursor, ctx: IOneCursorOperationContext): boolean {

		let selectEntireBuffer = true;
		let newSelectionStartLineNumber: number,
			newSelectionStartColumn: number,
			newPositionLineNumber: number,
			newPositionColumn: number;

		if (cursor.model.hasEditableRange()) {
			// Toggle between selecting editable range and selecting the entire buffer

			let editableRange = cursor.model.getEditableRange();
			let selection = cursor.modelState.selection;

			if (!selection.equalsRange(editableRange)) {
				// Selection is not editable range => select editable range
				selectEntireBuffer = false;
				newSelectionStartLineNumber = editableRange.startLineNumber;
				newSelectionStartColumn = editableRange.startColumn;
				newPositionLineNumber = editableRange.endLineNumber;
				newPositionColumn = editableRange.endColumn;
			}
		}

		if (selectEntireBuffer) {
			newSelectionStartLineNumber = 1;
			newSelectionStartColumn = 1;
			newPositionLineNumber = cursor.model.getLineCount();
			newPositionColumn = cursor.model.getLineMaxColumn(newPositionLineNumber);
		}

		cursor.moveModelPosition(false, newSelectionStartLineNumber, newSelectionStartColumn, 0, false);
		cursor.moveModelPosition(true, newPositionLineNumber, newPositionColumn, 0, false);

		ctx.shouldReveal = false;
		ctx.shouldRevealHorizontal = false;
		return true;
	}

	public static line(cursor: OneCursor, inSelectionMode: boolean, _position: editorCommon.IPosition, _viewPosition: editorCommon.IPosition, ctx: IOneCursorOperationContext): boolean {
		// TODO@Alex -> select in editable range

		let position = cursor.validatePosition(_position);
		let viewPosition = (
			_viewPosition ?
				cursor.validateViewPosition(_viewPosition.lineNumber, _viewPosition.column, position)
				: cursor.convertModelPositionToViewPosition(position.lineNumber, position.column)
		);

		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		ctx.shouldRevealHorizontal = false;

		if (!inSelectionMode || !cursor.hasSelection()) {
			// Entering line selection for the first time

			let selectToLineNumber = position.lineNumber + 1;
			let selectToColumn = 1;
			if (selectToLineNumber > cursor.model.getLineCount()) {
				selectToLineNumber = cursor.model.getLineCount();
				selectToColumn = cursor.model.getLineMaxColumn(selectToLineNumber);
			}

			let selectionStartRange = new Range(position.lineNumber, 1, selectToLineNumber, selectToColumn);
			cursor.setSelectionStart(selectionStartRange);
			cursor.moveModelPosition(cursor.hasSelection(), selectionStartRange.endLineNumber, selectionStartRange.endColumn, 0, false);

			return true;
		} else {
			// Continuing line selection
			let enteringLineNumber = cursor.modelState.selectionStart.getStartPosition().lineNumber;

			if (position.lineNumber < enteringLineNumber) {

				cursor.moveViewPosition(cursor.hasSelection(), viewPosition.lineNumber, 1, 0, false);

			} else if (position.lineNumber > enteringLineNumber) {

				let selectToViewLineNumber = viewPosition.lineNumber + 1;
				let selectToViewColumn = 1;
				if (selectToViewLineNumber > cursor.getViewLineCount()) {
					selectToViewLineNumber = cursor.getViewLineCount();
					selectToViewColumn = cursor.getViewLineMaxColumn(selectToViewLineNumber);
				}
				cursor.moveViewPosition(cursor.hasSelection(), selectToViewLineNumber, selectToViewColumn, 0, false);

			} else {

				let endPositionOfSelectionStart = cursor.modelState.selectionStart.getEndPosition();
				cursor.moveModelPosition(cursor.hasSelection(), endPositionOfSelectionStart.lineNumber, endPositionOfSelectionStart.column, 0, false);

			}


			return true;
		}

	}

	public static word(cursor: OneCursor, inSelectionMode: boolean, position: editorCommon.IPosition, ctx: IOneCursorOperationContext): boolean {
		// TODO@Alex -> select in editable range

		let validatedPosition = cursor.validatePosition(position);
		let prevWord = cursor.findPreviousWordOnLine(validatedPosition);
		let isInPrevWord = (prevWord && prevWord.wordType === WordType.Regular && prevWord.start < validatedPosition.column - 1 && validatedPosition.column - 1 <= prevWord.end);
		let nextWord = cursor.findNextWordOnLine(validatedPosition);
		let isInNextWord = (nextWord && nextWord.wordType === WordType.Regular && nextWord.start < validatedPosition.column - 1 && validatedPosition.column - 1 <= nextWord.end);

		let lineNumber: number;
		let column: number;
		if (!inSelectionMode || !cursor.hasSelection()) {

			let startColumn: number;
			let endColumn: number;

			if (isInPrevWord) {
				startColumn = prevWord.start + 1;
				endColumn = prevWord.end + 1;
			} else if (isInNextWord) {
				startColumn = nextWord.start + 1;
				endColumn = nextWord.end + 1;
			} else {
				if (prevWord) {
					startColumn = prevWord.end + 1;
				} else {
					startColumn = 1;
				}
				if (nextWord) {
					endColumn = nextWord.start + 1;
				} else {
					endColumn = cursor.model.getLineMaxColumn(validatedPosition.lineNumber);
				}
			}

			let selectionStartRange = new Range(validatedPosition.lineNumber, startColumn, validatedPosition.lineNumber, endColumn);
			cursor.setSelectionStart(selectionStartRange);
			lineNumber = selectionStartRange.endLineNumber;
			column = selectionStartRange.endColumn;
		} else {

			let startColumn: number;
			let endColumn: number;

			if (isInPrevWord) {
				startColumn = prevWord.start + 1;
				endColumn = prevWord.end + 1;
			} else if (isInNextWord) {
				startColumn = nextWord.start + 1;
				endColumn = nextWord.end + 1;
			} else {
				startColumn = validatedPosition.column;
				endColumn = validatedPosition.column;
			}

			lineNumber = validatedPosition.lineNumber;
			if (validatedPosition.isBeforeOrEqual(cursor.modelState.selectionStart.getStartPosition())) {
				column = startColumn;
				let possiblePosition = new Position(lineNumber, column);
				if (cursor.modelState.selectionStart.containsPosition(possiblePosition)) {
					column = cursor.modelState.selectionStart.endColumn;
				}
			} else {
				column = endColumn;
				let possiblePosition = new Position(lineNumber, column);
				if (cursor.modelState.selectionStart.containsPosition(possiblePosition)) {
					column = cursor.modelState.selectionStart.startColumn;
				}
			}
		}

		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		cursor.moveModelPosition(cursor.hasSelection(), lineNumber, column, 0, false);
		return true;
	}

	public static cancelSelection(cursor: OneCursor, ctx: IOneCursorOperationContext): boolean {
		if (!cursor.hasSelection()) {
			return false;
		}

		cursor.collapseSelection();
		return true;
	}

	// -------------------- STOP handlers that simply change cursor state



	// -------------------- START type interceptors & co.

	private static _typeInterceptorEnter(cursor: OneCursor, ch: string, ctx: IOneCursorOperationContext): boolean {
		if (ch !== '\n') {
			return false;
		}

		return this._enter(cursor, false, ctx, cursor.modelState.position, cursor.modelState.selection);
	}

	public static lineInsertBefore(cursor: OneCursor, ctx: IOneCursorOperationContext): boolean {
		let lineNumber = cursor.modelState.position.lineNumber;

		if (lineNumber === 1) {
			ctx.executeCommand = new ReplaceCommandWithoutChangingPosition(new Range(1, 1, 1, 1), '\n');
			return true;
		}

		lineNumber--;
		let column = cursor.model.getLineMaxColumn(lineNumber);

		return this._enter(cursor, false, ctx, new Position(lineNumber, column), new Range(lineNumber, column, lineNumber, column));
	}

	public static lineInsertAfter(cursor: OneCursor, ctx: IOneCursorOperationContext): boolean {
		let position = cursor.modelState.position;
		let column = cursor.model.getLineMaxColumn(position.lineNumber);
		return this._enter(cursor, false, ctx, new Position(position.lineNumber, column), new Range(position.lineNumber, column, position.lineNumber, column));
	}

	public static lineBreakInsert(cursor: OneCursor, ctx: IOneCursorOperationContext): boolean {
		return this._enter(cursor, true, ctx, cursor.modelState.position, cursor.modelState.selection);
	}

	private static _enter(cursor: OneCursor, keepPosition: boolean, ctx: IOneCursorOperationContext, position: Position, range: Range): boolean {
		ctx.shouldPushStackElementBefore = true;

		let r = LanguageConfigurationRegistry.getEnterActionAtPosition(cursor.model, range.startLineNumber, range.startColumn);
		let enterAction = r.enterAction;
		let indentation = r.indentation;

		ctx.isAutoWhitespaceCommand = true;
		if (enterAction.indentAction === IndentAction.None) {
			// Nothing special
			this.actualType(cursor, '\n' + cursor.model.normalizeIndentation(indentation + enterAction.appendText), keepPosition, ctx, range);

		} else if (enterAction.indentAction === IndentAction.Indent) {
			// Indent once
			this.actualType(cursor, '\n' + cursor.model.normalizeIndentation(indentation + enterAction.appendText), keepPosition, ctx, range);

		} else if (enterAction.indentAction === IndentAction.IndentOutdent) {
			// Ultra special
			let normalIndent = cursor.model.normalizeIndentation(indentation);
			let increasedIndent = cursor.model.normalizeIndentation(indentation + enterAction.appendText);

			let typeText = '\n' + increasedIndent + '\n' + normalIndent;

			if (keepPosition) {
				ctx.executeCommand = new ReplaceCommandWithoutChangingPosition(range, typeText);
			} else {
				ctx.executeCommand = new ReplaceCommandWithOffsetCursorState(range, typeText, -1, increasedIndent.length - normalIndent.length);
			}
		} else if (enterAction.indentAction === IndentAction.Outdent) {
			let desiredIndentCount = ShiftCommand.unshiftIndentCount(indentation, indentation.length + 1, cursor.model.getOptions().tabSize);
			let actualIndentation = '';
			for (let i = 0; i < desiredIndentCount; i++) {
				actualIndentation += '\t';
			}
			this.actualType(cursor, '\n' + cursor.model.normalizeIndentation(actualIndentation + enterAction.appendText), keepPosition, ctx, range);
		}

		return true;
	}

	private static _typeInterceptorAutoClosingCloseChar(cursor: OneCursor, ch: string, ctx: IOneCursorOperationContext): boolean {
		if (!cursor.configuration.editor.autoClosingBrackets) {
			return false;
		}

		let selection = cursor.modelState.selection;

		if (!selection.isEmpty() || !cursor.modeConfiguration.autoClosingPairsClose.hasOwnProperty(ch)) {
			return false;
		}

		let position = cursor.modelState.position;

		let lineText = cursor.model.getLineContent(position.lineNumber);
		let beforeCharacter = lineText[position.column - 1];

		if (beforeCharacter !== ch) {
			return false;
		}

		let typeSelection = new Range(position.lineNumber, position.column, position.lineNumber, position.column + 1);
		ctx.executeCommand = new ReplaceCommand(typeSelection, ch);
		return true;
	}

	private static _typeInterceptorAutoClosingOpenChar(cursor: OneCursor, ch: string, ctx: IOneCursorOperationContext): boolean {
		if (!cursor.configuration.editor.autoClosingBrackets) {
			return false;
		}

		let selection = cursor.modelState.selection;

		if (!selection.isEmpty() || !cursor.modeConfiguration.autoClosingPairsOpen.hasOwnProperty(ch)) {
			return false;
		}

		let position = cursor.modelState.position;
		let lineText = cursor.model.getLineContent(position.lineNumber);
		let beforeCharacter = lineText[position.column - 1];

		// Only consider auto closing the pair if a space follows or if another autoclosed pair follows
		if (beforeCharacter) {
			let isBeforeCloseBrace = false;
			for (let closeBrace in cursor.modeConfiguration.autoClosingPairsClose) {
				if (beforeCharacter === closeBrace) {
					isBeforeCloseBrace = true;
					break;
				}
			}
			if (!isBeforeCloseBrace && !/\s/.test(beforeCharacter)) {
				return false;
			}
		}

		let lineTokens = cursor.model.getLineTokens(position.lineNumber, false);

		let shouldAutoClosePair = false;
		try {
			shouldAutoClosePair = LanguageConfigurationRegistry.shouldAutoClosePair(ch, lineTokens, position.column - 1);
		} catch (e) {
			onUnexpectedError(e);
		}

		if (!shouldAutoClosePair) {
			return false;
		}

		ctx.shouldPushStackElementBefore = true;
		let closeCharacter = cursor.modeConfiguration.autoClosingPairsOpen[ch];
		ctx.executeCommand = new ReplaceCommandWithOffsetCursorState(selection, ch + closeCharacter, 0, -closeCharacter.length);
		return true;
	}

	private static _typeInterceptorSurroundSelection(cursor: OneCursor, ch: string, ctx: IOneCursorOperationContext): boolean {
		if (!cursor.configuration.editor.autoClosingBrackets) {
			return false;
		}

		let selection = cursor.modelState.selection;

		if (selection.isEmpty() || !cursor.modeConfiguration.surroundingPairs.hasOwnProperty(ch)) {
			return false;
		}

		let selectionContainsOnlyWhitespace = true;

		for (let lineNumber = selection.startLineNumber; lineNumber <= selection.endLineNumber; lineNumber++) {
			let lineText = cursor.model.getLineContent(lineNumber);
			let startIndex = (lineNumber === selection.startLineNumber ? selection.startColumn - 1 : 0);
			let endIndex = (lineNumber === selection.endLineNumber ? selection.endColumn - 1 : lineText.length);
			for (let charIndex = startIndex; charIndex < endIndex; charIndex++) {
				let charCode = lineText.charCodeAt(charIndex);
				if (charCode !== CharCode.Tab && charCode !== CharCode.Space) {
					selectionContainsOnlyWhitespace = false;

					// Break outer loop
					lineNumber = selection.endLineNumber + 1;

					// Break inner loop
					charIndex = endIndex;
				}
			}
		}

		if (selectionContainsOnlyWhitespace) {
			return false;
		}

		let closeCharacter = cursor.modeConfiguration.surroundingPairs[ch];

		ctx.shouldPushStackElementBefore = true;
		ctx.shouldPushStackElementAfter = true;
		ctx.executeCommand = new SurroundSelectionCommand(selection, ch, closeCharacter);
		return true;
	}

	private static _typeInterceptorElectricChar(cursor: OneCursor, ch: string, ctx: IOneCursorOperationContext): boolean {
		if (!cursor.modeConfiguration.electricChars.hasOwnProperty(ch)) {
			return false;
		}

		ctx.postOperationRunnable = (postOperationCtx: IOneCursorOperationContext) => this._typeInterceptorElectricCharRunnable(cursor, postOperationCtx);

		return this.actualType(cursor, ch, false, ctx);
	}

	private static _typeInterceptorElectricCharRunnable(cursor: OneCursor, ctx: IOneCursorOperationContext): void {

		let position = cursor.modelState.position;
		let lineText = cursor.model.getLineContent(position.lineNumber);
		let lineTokens = cursor.model.getLineTokens(position.lineNumber, false);

		let electricAction: IElectricAction;
		try {
			electricAction = LanguageConfigurationRegistry.onElectricCharacter(lineTokens, position.column - 2);
		} catch (e) {
			onUnexpectedError(e);
		}

		if (electricAction) {
			let matchOpenBracket = electricAction.matchOpenBracket;
			let appendText = electricAction.appendText;
			if (matchOpenBracket) {
				let match = cursor.model.findMatchingBracketUp(matchOpenBracket, {
					lineNumber: position.lineNumber,
					column: position.column - matchOpenBracket.length
				});
				if (match) {
					let matchLineNumber = match.startLineNumber;
					let matchLine = cursor.model.getLineContent(matchLineNumber);
					let matchLineIndentation = strings.getLeadingWhitespace(matchLine);
					let newIndentation = cursor.model.normalizeIndentation(matchLineIndentation);

					let lineFirstNonBlankColumn = cursor.model.getLineFirstNonWhitespaceColumn(position.lineNumber) || position.column;
					let oldIndentation = lineText.substring(0, lineFirstNonBlankColumn - 1);

					if (oldIndentation !== newIndentation) {
						let prefix = lineText.substring(lineFirstNonBlankColumn - 1, position.column - 1);
						let typeText = newIndentation + prefix;

						let typeSelection = new Range(position.lineNumber, 1, position.lineNumber, position.column);
						ctx.shouldPushStackElementAfter = true;
						ctx.executeCommand = new ReplaceCommand(typeSelection, typeText);
					}
				}
			} else if (appendText) {
				let columnDeltaOffset = -appendText.length;
				if (electricAction.advanceCount) {
					columnDeltaOffset += electricAction.advanceCount;
				}
				ctx.shouldPushStackElementAfter = true;
				ctx.executeCommand = new ReplaceCommandWithOffsetCursorState(cursor.modelState.selection, appendText, 0, columnDeltaOffset);
			}
		}
	}

	public static actualType(cursor: OneCursor, text: string, keepPosition: boolean, ctx: IOneCursorOperationContext, range?: Range): boolean {
		if (typeof range === 'undefined') {
			range = cursor.modelState.selection;
		}
		if (keepPosition) {
			ctx.executeCommand = new ReplaceCommandWithoutChangingPosition(range, text);
		} else {
			ctx.executeCommand = new ReplaceCommand(range, text);
		}
		return true;
	}

	public static type(cursor: OneCursor, ch: string, ctx: IOneCursorOperationContext): boolean {

		if (this._typeInterceptorEnter(cursor, ch, ctx)) {
			return true;
		}

		if (this._typeInterceptorAutoClosingCloseChar(cursor, ch, ctx)) {
			return true;
		}

		if (this._typeInterceptorAutoClosingOpenChar(cursor, ch, ctx)) {
			return true;
		}

		if (this._typeInterceptorSurroundSelection(cursor, ch, ctx)) {
			return true;
		}

		if (this._typeInterceptorElectricChar(cursor, ch, ctx)) {
			return true;
		}

		return this.actualType(cursor, ch, false, ctx);
	}

	public static replacePreviousChar(cursor: OneCursor, txt: string, replaceCharCnt: number, ctx: IOneCursorOperationContext): boolean {
		let pos = cursor.modelState.position;
		let range: Range;
		let startColumn = Math.max(1, pos.column - replaceCharCnt);
		range = new Range(pos.lineNumber, startColumn, pos.lineNumber, pos.column);
		ctx.executeCommand = new ReplaceCommand(range, txt);
		return true;
	}

	private static _goodIndentForLine(cursor: OneCursor, lineNumber: number): string {
		let lastLineNumber = lineNumber - 1;

		for (lastLineNumber = lineNumber - 1; lastLineNumber >= 1; lastLineNumber--) {
			let lineText = cursor.model.getLineContent(lastLineNumber);
			let nonWhitespaceIdx = strings.lastNonWhitespaceIndex(lineText);
			if (nonWhitespaceIdx >= 0) {
				break;
			}
		}

		if (lastLineNumber < 1) {
			// No previous line with content found
			return '\t';
		}

		let r = LanguageConfigurationRegistry.getEnterActionAtPosition(cursor.model, lastLineNumber, cursor.model.getLineMaxColumn(lastLineNumber));

		let indentation: string;
		if (r.enterAction.indentAction === IndentAction.Outdent) {
			let modelOpts = cursor.model.getOptions();
			let desiredIndentCount = ShiftCommand.unshiftIndentCount(r.indentation, r.indentation.length, modelOpts.tabSize);
			indentation = '';
			for (let i = 0; i < desiredIndentCount; i++) {
				indentation += '\t';
			}
			indentation = cursor.model.normalizeIndentation(indentation);
		} else {
			indentation = r.indentation;
		}

		let result = indentation + r.enterAction.appendText;
		if (result.length === 0) {
			// good position is at column 1, but we gotta do something...
			return '\t';
		}
		return result;
	}

	private static _replaceJumpToNextIndent(cursor: OneCursor, selection: Selection): ReplaceCommand {
		let typeText = '';

		let position = selection.getStartPosition();
		let modelOpts = cursor.model.getOptions();
		if (modelOpts.insertSpaces) {
			let visibleColumnFromColumn = cursor.getVisibleColumnFromColumn(position.lineNumber, position.column);
			let tabSize = modelOpts.tabSize;
			let spacesCnt = tabSize - (visibleColumnFromColumn % tabSize);
			for (let i = 0; i < spacesCnt; i++) {
				typeText += ' ';
			}
		} else {
			typeText = '\t';
		}

		return new ReplaceCommand(selection, typeText);
	}

	public static tab(cursor: OneCursor, ctx: IOneCursorOperationContext): boolean {
		let selection = cursor.modelState.selection;

		if (selection.isEmpty()) {

			ctx.isAutoWhitespaceCommand = true;


			let lineText = cursor.model.getLineContent(selection.startLineNumber);

			if (/^\s*$/.test(lineText)) {
				let possibleTypeText = cursor.model.normalizeIndentation(this._goodIndentForLine(cursor, selection.startLineNumber));
				if (!strings.startsWith(lineText, possibleTypeText)) {
					ctx.executeCommand = new ReplaceCommand(new Range(selection.startLineNumber, 1, selection.startLineNumber, lineText.length + 1), possibleTypeText);
					return true;
				}
			}

			ctx.executeCommand = this._replaceJumpToNextIndent(cursor, selection);
			return true;
		} else {
			if (selection.startLineNumber === selection.endLineNumber) {
				let lineMaxColumn = cursor.model.getLineMaxColumn(selection.startLineNumber);
				if (selection.startColumn !== 1 || selection.endColumn !== lineMaxColumn) {
					// This is a single line selection that is not the entire line
					ctx.executeCommand = this._replaceJumpToNextIndent(cursor, selection);
					return true;
				}
			}
			return this.indent(cursor, ctx);
		}
	}

	public static indent(cursor: OneCursor, ctx: IOneCursorOperationContext): boolean {
		let selection = cursor.modelState.selection;

		ctx.shouldPushStackElementBefore = true;
		ctx.shouldPushStackElementAfter = true;
		ctx.executeCommand = new ShiftCommand(selection, {
			isUnshift: false,
			tabSize: cursor.model.getOptions().tabSize,
			oneIndent: cursor.model.getOneIndent()
		});
		ctx.shouldRevealHorizontal = false;

		return true;
	}

	public static outdent(cursor: OneCursor, ctx: IOneCursorOperationContext): boolean {
		let selection = cursor.modelState.selection;

		ctx.shouldPushStackElementBefore = true;
		ctx.shouldPushStackElementAfter = true;
		ctx.executeCommand = new ShiftCommand(selection, {
			isUnshift: true,
			tabSize: cursor.model.getOptions().tabSize,
			oneIndent: cursor.model.getOneIndent()
		});
		ctx.shouldRevealHorizontal = false;

		return true;
	}

	public static paste(cursor: OneCursor, text: string, pasteOnNewLine: boolean, ctx: IOneCursorOperationContext): boolean {
		let position = cursor.modelState.position;
		let selection = cursor.modelState.selection;

		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Paste;

		if (pasteOnNewLine && text.indexOf('\n') !== text.length - 1) {
			pasteOnNewLine = false;
		}
		if (pasteOnNewLine && selection.startLineNumber !== selection.endLineNumber) {
			pasteOnNewLine = false;
		}
		if (pasteOnNewLine && selection.startColumn === cursor.model.getLineMinColumn(selection.startLineNumber) && selection.endColumn === cursor.model.getLineMaxColumn(selection.startLineNumber)) {
			pasteOnNewLine = false;
		}

		if (pasteOnNewLine) {
			// Paste entire line at the beginning of line

			let typeSelection = new Range(position.lineNumber, 1, position.lineNumber, 1);
			ctx.executeCommand = new ReplaceCommand(typeSelection, text);
			return true;
		}
		ctx.executeCommand = new ReplaceCommand(selection, text);
		return true;
	}

	// -------------------- END type interceptors & co.

	// -------------------- START delete handlers & co.

	private static _autoClosingPairDelete(cursor: OneCursor, ctx: IOneCursorOperationContext): boolean {
		// Returns true if delete was handled.

		if (!cursor.configuration.editor.autoClosingBrackets) {
			return false;
		}

		if (!cursor.modelState.selection.isEmpty()) {
			return false;
		}

		let position = cursor.modelState.position;

		let lineText = cursor.model.getLineContent(position.lineNumber);
		let character = lineText[position.column - 2];

		if (!cursor.modeConfiguration.autoClosingPairsOpen.hasOwnProperty(character)) {
			return false;
		}

		let afterCharacter = lineText[position.column - 1];
		let closeCharacter = cursor.modeConfiguration.autoClosingPairsOpen[character];

		if (afterCharacter !== closeCharacter) {
			return false;
		}

		let deleteSelection = new Range(
			position.lineNumber,
			position.column - 1,
			position.lineNumber,
			position.column + 1
		);
		ctx.executeCommand = new ReplaceCommand(deleteSelection, '');

		return true;
	}

	public static deleteLeft(cursor: OneCursor, ctx: IOneCursorOperationContext): boolean {
		if (this._autoClosingPairDelete(cursor, ctx)) {
			// This was a case for an auto-closing pair delete
			return true;
		}

		let deleteSelection: Range = cursor.modelState.selection;

		if (deleteSelection.isEmpty()) {
			let position = cursor.modelState.position;

			if (cursor.configuration.editor.useTabStops && position.column > 1) {
				let lineContent = cursor.model.getLineContent(position.lineNumber);

				let firstNonWhitespaceIndex = strings.firstNonWhitespaceIndex(lineContent);
				let lastIndentationColumn = (
					firstNonWhitespaceIndex === -1
						? /* entire string is whitespace */lineContent.length + 1
						: firstNonWhitespaceIndex + 1
				);

				if (position.column <= lastIndentationColumn) {
					let fromVisibleColumn = cursor.getVisibleColumnFromColumn(position.lineNumber, position.column);
					let toVisibleColumn = CursorMoveHelper.prevTabColumn(fromVisibleColumn, cursor.model.getOptions().tabSize);
					let toColumn = CursorMove.columnFromVisibleColumn(cursor.config, cursor.model, position.lineNumber, toVisibleColumn);
					deleteSelection = new Range(position.lineNumber, toColumn, position.lineNumber, position.column);
				} else {
					deleteSelection = new Range(position.lineNumber, position.column - 1, position.lineNumber, position.column);
				}
			} else {
				let leftOfPosition = CursorMove.left(cursor.config, cursor.model, position.lineNumber, position.column);
				deleteSelection = new Range(
					leftOfPosition.lineNumber,
					leftOfPosition.column,
					position.lineNumber,
					position.column
				);
			}
		}

		if (deleteSelection.isEmpty()) {
			// Probably at beginning of file => ignore
			return true;
		}

		if (deleteSelection.startLineNumber !== deleteSelection.endLineNumber) {
			ctx.shouldPushStackElementBefore = true;
		}

		ctx.executeCommand = new ReplaceCommand(deleteSelection, '');
		return true;
	}

	private static deleteWordLeftWhitespace(cursor: OneCursor, ctx: IOneCursorOperationContext): boolean {
		let position = cursor.modelState.position;
		let lineContent = cursor.model.getLineContent(position.lineNumber);
		let startIndex = position.column - 2;
		let lastNonWhitespace = strings.lastNonWhitespaceIndex(lineContent, startIndex);
		if (lastNonWhitespace + 1 < startIndex) {
			// bingo
			ctx.executeCommand = new ReplaceCommand(new Range(position.lineNumber, lastNonWhitespace + 2, position.lineNumber, position.column), '');
			return true;
		}
		return false;
	}

	public static deleteWordLeft(cursor: OneCursor, whitespaceHeuristics: boolean, wordNavigationType: WordNavigationType, ctx: IOneCursorOperationContext): boolean {
		if (this._autoClosingPairDelete(cursor, ctx)) {
			// This was a case for an auto-closing pair delete
			return true;
		}

		let selection = cursor.modelState.selection;

		if (selection.isEmpty()) {
			let position = cursor.modelState.position;

			let lineNumber = position.lineNumber;
			let column = position.column;

			if (lineNumber === 1 && column === 1) {
				// Ignore deleting at beginning of file
				return true;
			}

			if (whitespaceHeuristics && this.deleteWordLeftWhitespace(cursor, ctx)) {
				return true;
			}

			let prevWordOnLine = cursor.findPreviousWordOnLine(position);

			if (wordNavigationType === WordNavigationType.WordStart) {
				if (prevWordOnLine) {
					column = prevWordOnLine.start + 1;
				} else {
					column = 1;
				}
			} else {
				if (prevWordOnLine && column <= prevWordOnLine.end + 1) {
					prevWordOnLine = cursor.findPreviousWordOnLine(new Position(lineNumber, prevWordOnLine.start + 1));
				}
				if (prevWordOnLine) {
					column = prevWordOnLine.end + 1;
				} else {
					column = 1;
				}
			}

			let deleteSelection = new Range(lineNumber, column, lineNumber, position.column);
			if (!deleteSelection.isEmpty()) {
				ctx.executeCommand = new ReplaceCommand(deleteSelection, '');
				return true;
			}
		}

		return this.deleteLeft(cursor, ctx);
	}

	public static deleteRight(cursor: OneCursor, ctx: IOneCursorOperationContext): boolean {

		let deleteSelection: Range = cursor.modelState.selection;

		if (deleteSelection.isEmpty()) {
			let position = cursor.modelState.position;
			let rightOfPosition = CursorMove.right(cursor.config, cursor.model, position.lineNumber, position.column);
			deleteSelection = new Range(
				rightOfPosition.lineNumber,
				rightOfPosition.column,
				position.lineNumber,
				position.column
			);
		}

		if (deleteSelection.isEmpty()) {
			// Probably at end of file => ignore
			return true;
		}

		if (deleteSelection.startLineNumber !== deleteSelection.endLineNumber) {
			ctx.shouldPushStackElementBefore = true;
		}

		ctx.executeCommand = new ReplaceCommand(deleteSelection, '');
		return true;
	}

	private static _findFirstNonWhitespaceChar(str: string, startIndex: number): number {
		let len = str.length;
		for (let chIndex = startIndex; chIndex < len; chIndex++) {
			let ch = str.charAt(chIndex);
			if (ch !== ' ' && ch !== '\t') {
				return chIndex;
			}
		}
		return len;
	}

	private static deleteWordRightWhitespace(cursor: OneCursor, ctx: IOneCursorOperationContext): boolean {
		let position = cursor.modelState.position;
		let lineContent = cursor.model.getLineContent(position.lineNumber);
		let startIndex = position.column - 1;
		let firstNonWhitespace = this._findFirstNonWhitespaceChar(lineContent, startIndex);
		if (startIndex + 1 < firstNonWhitespace) {
			// bingo
			ctx.executeCommand = new ReplaceCommand(new Range(position.lineNumber, position.column, position.lineNumber, firstNonWhitespace + 1), '');
			return true;
		}
		return false;
	}

	public static deleteWordRight(cursor: OneCursor, whitespaceHeuristics: boolean, wordNavigationType: WordNavigationType, ctx: IOneCursorOperationContext): boolean {

		let selection = cursor.modelState.selection;

		if (selection.isEmpty()) {
			let position = cursor.modelState.position;

			let lineNumber = position.lineNumber;
			let column = position.column;

			let lineCount = cursor.model.getLineCount();
			let maxColumn = cursor.model.getLineMaxColumn(lineNumber);
			if (lineNumber === lineCount && column === maxColumn) {
				// Ignore deleting at end of file
				return true;
			}

			if (whitespaceHeuristics && this.deleteWordRightWhitespace(cursor, ctx)) {
				return true;
			}

			let nextWordOnLine = cursor.findNextWordOnLine(position);

			if (wordNavigationType === WordNavigationType.WordEnd) {
				if (nextWordOnLine) {
					column = nextWordOnLine.end + 1;
				} else {
					if (column < maxColumn || lineNumber === lineCount) {
						column = maxColumn;
					} else {
						lineNumber++;
						nextWordOnLine = cursor.findNextWordOnLine(new Position(lineNumber, 1));
						if (nextWordOnLine) {
							column = nextWordOnLine.start + 1;
						} else {
							column = cursor.model.getLineMaxColumn(lineNumber);
						}
					}
				}
			} else {
				if (nextWordOnLine && column >= nextWordOnLine.start + 1) {
					nextWordOnLine = cursor.findNextWordOnLine(new Position(lineNumber, nextWordOnLine.end + 1));
				}
				if (nextWordOnLine) {
					column = nextWordOnLine.start + 1;
				} else {
					if (column < maxColumn || lineNumber === lineCount) {
						column = maxColumn;
					} else {
						lineNumber++;
						nextWordOnLine = cursor.findNextWordOnLine(new Position(lineNumber, 1));
						if (nextWordOnLine) {
							column = nextWordOnLine.start + 1;
						} else {
							column = cursor.model.getLineMaxColumn(lineNumber);
						}
					}
				}
			}

			let deleteSelection = new Range(lineNumber, column, position.lineNumber, position.column);
			if (!deleteSelection.isEmpty()) {
				ctx.executeCommand = new ReplaceCommand(deleteSelection, '');
				return true;
			}
		}
		// fall back to normal deleteRight behavior
		return this.deleteRight(cursor, ctx);
	}

	public static deleteAllLeft(cursor: OneCursor, ctx: IOneCursorOperationContext): boolean {
		if (this._autoClosingPairDelete(cursor, ctx)) {
			// This was a case for an auto-closing pair delete
			return true;
		}

		let selection = cursor.modelState.selection;

		if (selection.isEmpty()) {
			let position = cursor.modelState.position;
			let lineNumber = position.lineNumber;
			let column = position.column;

			if (column === 1) {
				// Ignore deleting at beginning of line
				return true;
			}

			let deleteSelection = new Range(lineNumber, 1, lineNumber, column);
			if (!deleteSelection.isEmpty()) {
				ctx.executeCommand = new ReplaceCommand(deleteSelection, '');
				return true;
			}
		}

		return this.deleteLeft(cursor, ctx);
	}

	public static deleteAllRight(cursor: OneCursor, ctx: IOneCursorOperationContext): boolean {
		let selection = cursor.modelState.selection;

		if (selection.isEmpty()) {
			let position = cursor.modelState.position;
			let lineNumber = position.lineNumber;
			let column = position.column;
			let maxColumn = cursor.model.getLineMaxColumn(lineNumber);

			if (column === maxColumn) {
				// Ignore deleting at end of file
				return true;
			}

			let deleteSelection = new Range(lineNumber, column, lineNumber, maxColumn);
			if (!deleteSelection.isEmpty()) {
				ctx.executeCommand = new ReplaceCommand(deleteSelection, '');
				return true;
			}
		}

		return this.deleteRight(cursor, ctx);
	}

	public static cut(cursor: OneCursor, enableEmptySelectionClipboard: boolean, ctx: IOneCursorOperationContext): boolean {
		let selection = cursor.modelState.selection;

		if (selection.isEmpty()) {
			if (enableEmptySelectionClipboard) {
				// This is a full line cut

				let position = cursor.modelState.position;

				let startLineNumber: number,
					startColumn: number,
					endLineNumber: number,
					endColumn: number;

				if (position.lineNumber < cursor.model.getLineCount()) {
					// Cutting a line in the middle of the model
					startLineNumber = position.lineNumber;
					startColumn = 1;
					endLineNumber = position.lineNumber + 1;
					endColumn = 1;
				} else if (position.lineNumber > 1) {
					// Cutting the last line & there are more than 1 lines in the model
					startLineNumber = position.lineNumber - 1;
					startColumn = cursor.model.getLineMaxColumn(position.lineNumber - 1);
					endLineNumber = position.lineNumber;
					endColumn = cursor.model.getLineMaxColumn(position.lineNumber);
				} else {
					// Cutting the single line that the model contains
					startLineNumber = position.lineNumber;
					startColumn = 1;
					endLineNumber = position.lineNumber;
					endColumn = cursor.model.getLineMaxColumn(position.lineNumber);
				}

				let deleteSelection = new Range(
					startLineNumber,
					startColumn,
					endLineNumber,
					endColumn
				);

				if (!deleteSelection.isEmpty()) {
					ctx.executeCommand = new ReplaceCommand(deleteSelection, '');
				}
			} else {
				// Cannot cut empty selection
				return false;
			}
		} else {
			// Delete left or right, they will both result in the selection being deleted
			this.deleteRight(cursor, ctx);
		}
		return true;
	}

	// -------------------- END delete handlers & co.
}

class CursorHelper {
	private model: editorCommon.IModel;
	private configuration: editorCommon.IConfiguration;
	private moveHelper: CursorMoveHelper;

	constructor(model: editorCommon.IModel, configuration: editorCommon.IConfiguration, config: CursorMoveConfiguration) {
		this.model = model;
		this.configuration = configuration;
		this.moveHelper = new CursorMoveHelper(config);
	}

	public getColumnAtBeginningOfLine(model: ICursorMoveHelperModel, lineNumber: number, column: number): number {
		return this.moveHelper.getColumnAtBeginningOfLine(model, lineNumber, column);
	}

	public getColumnAtEndOfLine(model: ICursorMoveHelperModel, lineNumber: number, column: number): number {
		return this.moveHelper.getColumnAtEndOfLine(model, lineNumber, column);
	}

	public columnSelect(model: ICursorMoveHelperModel, fromLineNumber: number, fromVisibleColumn: number, toLineNumber: number, toVisibleColumn: number): IViewColumnSelectResult {
		return this.moveHelper.columnSelect(model, fromLineNumber, fromVisibleColumn, toLineNumber, toVisibleColumn);
	}

	public visibleColumnFromColumn(model: ICursorMoveHelperModel, lineNumber: number, column: number): number {
		return this.moveHelper.visibleColumnFromColumn(model, lineNumber, column);
	}

	private static _createWord(lineContent: string, wordType: WordType, start: number, end: number): IFindWordResult {
		// console.log('WORD ==> ' + start + ' => ' + end + ':::: <<<' + lineContent.substring(start, end) + '>>>');
		return { start: start, end: end, wordType: wordType };
	}

	public findPreviousWordOnLine(_position: Position): IFindWordResult {
		let position = this.model.validatePosition(_position);
		let wordSeparators = getMapForWordSeparators(this.configuration.editor.wordSeparators);
		let lineContent = this.model.getLineContent(position.lineNumber);
		return CursorHelper._findPreviousWordOnLine(lineContent, wordSeparators, position);
	}

	private static _findPreviousWordOnLine(lineContent: string, wordSeparators: WordCharacterClassifier, position: Position): IFindWordResult {
		let wordType = WordType.None;
		for (let chIndex = position.column - 2; chIndex >= 0; chIndex--) {
			let chCode = lineContent.charCodeAt(chIndex);
			let chClass = wordSeparators.get(chCode);

			if (chClass === CharacterClass.Regular) {
				if (wordType === WordType.Separator) {
					return CursorHelper._createWord(lineContent, wordType, chIndex + 1, CursorHelper._findEndOfWord(lineContent, wordSeparators, wordType, chIndex + 1));
				}
				wordType = WordType.Regular;
			} else if (chClass === CharacterClass.WordSeparator) {
				if (wordType === WordType.Regular) {
					return CursorHelper._createWord(lineContent, wordType, chIndex + 1, CursorHelper._findEndOfWord(lineContent, wordSeparators, wordType, chIndex + 1));
				}
				wordType = WordType.Separator;
			} else if (chClass === CharacterClass.Whitespace) {
				if (wordType !== WordType.None) {
					return CursorHelper._createWord(lineContent, wordType, chIndex + 1, CursorHelper._findEndOfWord(lineContent, wordSeparators, wordType, chIndex + 1));
				}
			}
		}

		if (wordType !== WordType.None) {
			return CursorHelper._createWord(lineContent, wordType, 0, CursorHelper._findEndOfWord(lineContent, wordSeparators, wordType, 0));
		}

		return null;
	}

	private static _findEndOfWord(lineContent: string, wordSeparators: WordCharacterClassifier, wordType: WordType, startIndex: number): number {
		let len = lineContent.length;
		for (let chIndex = startIndex; chIndex < len; chIndex++) {
			let chCode = lineContent.charCodeAt(chIndex);
			let chClass = wordSeparators.get(chCode);

			if (chClass === CharacterClass.Whitespace) {
				return chIndex;
			}
			if (wordType === WordType.Regular && chClass === CharacterClass.WordSeparator) {
				return chIndex;
			}
			if (wordType === WordType.Separator && chClass === CharacterClass.Regular) {
				return chIndex;
			}
		}
		return len;
	}

	public findNextWordOnLine(_position: Position): IFindWordResult {
		let position = this.model.validatePosition(_position);
		let wordSeparators = getMapForWordSeparators(this.configuration.editor.wordSeparators);
		let lineContent = this.model.getLineContent(position.lineNumber);
		return CursorHelper._findNextWordOnLine(lineContent, wordSeparators, position);
	}

	private static _findNextWordOnLine(lineContent: string, wordSeparators: WordCharacterClassifier, position: Position): IFindWordResult {
		let wordType = WordType.None;
		let len = lineContent.length;

		for (let chIndex = position.column - 1; chIndex < len; chIndex++) {
			let chCode = lineContent.charCodeAt(chIndex);
			let chClass = wordSeparators.get(chCode);

			if (chClass === CharacterClass.Regular) {
				if (wordType === WordType.Separator) {
					return CursorHelper._createWord(lineContent, wordType, CursorHelper._findStartOfWord(lineContent, wordSeparators, wordType, chIndex - 1), chIndex);
				}
				wordType = WordType.Regular;
			} else if (chClass === CharacterClass.WordSeparator) {
				if (wordType === WordType.Regular) {
					return CursorHelper._createWord(lineContent, wordType, CursorHelper._findStartOfWord(lineContent, wordSeparators, wordType, chIndex - 1), chIndex);
				}
				wordType = WordType.Separator;
			} else if (chClass === CharacterClass.Whitespace) {
				if (wordType !== WordType.None) {
					return CursorHelper._createWord(lineContent, wordType, CursorHelper._findStartOfWord(lineContent, wordSeparators, wordType, chIndex - 1), chIndex);
				}
			}
		}

		if (wordType !== WordType.None) {
			return CursorHelper._createWord(lineContent, wordType, CursorHelper._findStartOfWord(lineContent, wordSeparators, wordType, len - 1), len);
		}

		return null;
	}

	private static _findStartOfWord(lineContent: string, wordSeparators: WordCharacterClassifier, wordType: WordType, startIndex: number): number {
		for (let chIndex = startIndex; chIndex >= 0; chIndex--) {
			let chCode = lineContent.charCodeAt(chIndex);
			let chClass = wordSeparators.get(chCode);

			if (chClass === CharacterClass.Whitespace) {
				return chIndex + 1;
			}
			if (wordType === WordType.Regular && chClass === CharacterClass.WordSeparator) {
				return chIndex + 1;
			}
			if (wordType === WordType.Separator && chClass === CharacterClass.Regular) {
				return chIndex + 1;
			}
		}
		return 0;
	}
}

class WordCharacterClassifier extends CharacterClassifier<CharacterClass> {

	constructor(wordSeparators: string) {
		super(CharacterClass.Regular);

		for (let i = 0, len = wordSeparators.length; i < len; i++) {
			this.set(wordSeparators.charCodeAt(i), CharacterClass.WordSeparator);
		}

		this.set(CharCode.Space, CharacterClass.Whitespace);
		this.set(CharCode.Tab, CharacterClass.Whitespace);
	}

}

function once<R>(computeFn: (input: string) => R): (input: string) => R {
	let cache: { [key: string]: R; } = {}; // TODO@Alex unbounded cache
	return (input: string): R => {
		if (!cache.hasOwnProperty(input)) {
			cache[input] = computeFn(input);
		}
		return cache[input];
	};
}

let getMapForWordSeparators = once<WordCharacterClassifier>(
	(input) => new WordCharacterClassifier(input)
);

class Utils {

	/**
	 * Range contains position (including edges)?
	 */
	static rangeContainsPosition(range: editorCommon.IRange, position: editorCommon.IPosition): boolean {
		if (position.lineNumber < range.startLineNumber || position.lineNumber > range.endLineNumber) {
			return false;
		}
		if (position.lineNumber === range.startLineNumber && position.column < range.startColumn) {
			return false;
		}
		if (position.lineNumber === range.endLineNumber && position.column > range.endColumn) {
			return false;
		}
		return true;
	}

	/**
	 * Tests if position is contained inside range.
	 * If position is either the starting or ending of a range, false is returned.
	 */
	static isPositionInsideRange(position: editorCommon.IPosition, range: editorCommon.IRange): boolean {
		if (position.lineNumber < range.startLineNumber) {
			return false;
		}
		if (position.lineNumber > range.endLineNumber) {
			return false;
		}
		if (position.lineNumber === range.startLineNumber && position.column < range.startColumn) {
			return false;
		}
		if (position.lineNumber === range.endLineNumber && position.column > range.endColumn) {
			return false;
		}
		return true;
	}

	static isPositionAtRangeEdges(position: editorCommon.IPosition, range: editorCommon.IRange): boolean {
		if (position.lineNumber === range.startLineNumber && position.column === range.startColumn) {
			return true;
		}
		if (position.lineNumber === range.endLineNumber && position.column === range.endColumn) {
			return true;
		}
		return false;
	}
}
