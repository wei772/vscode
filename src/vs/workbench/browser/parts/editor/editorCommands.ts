/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import * as types from 'vs/base/common/types';
import { ServicesAccessor } from 'vs/platform/instantiation/common/instantiation';
import { KeybindingsRegistry } from 'vs/platform/keybinding/common/keybindingsRegistry';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IEditorGroupService } from 'vs/workbench/services/group/common/groupService';
import { IWorkbenchEditorConfiguration, ActiveEditorMoveArguments, ActiveEditorMovePositioning, ActiveEditorMovePositioningBy, EditorCommands } from 'vs/workbench/common/editor';
import { IWorkbenchEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IEditor, Position, POSITIONS } from 'vs/platform/editor/common/editor';
import { EditorContextKeys } from 'vs/editor/common/editorCommon';
import { TextCompareEditorVisible, TextDiffEditor } from 'vs/workbench/browser/parts/editor/textDiffEditor';
import { EditorStacksModel } from 'vs/workbench/common/editor/editorStacksModel';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { IMessageService, Severity, CloseAction } from 'vs/platform/message/common/message';
import { Action } from 'vs/base/common/actions';

export function setup(): void {
	registerActiveEditorMoveCommand();
	registerDiffEditorCommands();
	handleCommandDeprecations();
}

const isActiveEditorMoveArg = function (arg): boolean {
	if (!types.isObject(arg)) {
		return false;
	}

	const activeEditorMoveArg: ActiveEditorMoveArguments = arg;

	if (!types.isString(activeEditorMoveArg.to)) {
		return false;
	}

	if (!types.isUndefined(activeEditorMoveArg.by) && !types.isString(activeEditorMoveArg.by)) {
		return false;
	}

	if (!types.isUndefined(activeEditorMoveArg.value) && !types.isNumber(activeEditorMoveArg.value)) {
		return false;
	}

	return true;
};

function registerActiveEditorMoveCommand(): void {
	KeybindingsRegistry.registerCommandAndKeybindingRule({
		id: EditorCommands.MoveActiveEditor,
		weight: KeybindingsRegistry.WEIGHT.workbenchContrib(),
		when: EditorContextKeys.TextFocus,
		primary: null,
		handler: (accessor, args: any) => moveActiveEditor(args, accessor),
		description: {
			description: nls.localize('editorCommand.activeEditorMove.description', "Move the active editor by tabs or groups"),
			args: [
				{
					name: nls.localize('editorCommand.activeEditorMove.arg.name', "Active editor move argument"),
					description: nls.localize('editorCommand.activeEditorMove.arg.description', `Argument Properties:
						* 'to': String value providing where to move.
						* 'by': String value providing the unit for move. By tab or by group.
						* 'value': Number value providing how many positions or an absolute position to move.
					`),
					constraint: isActiveEditorMoveArg
				}
			]
		}
	});
}

function moveActiveEditor(args: ActiveEditorMoveArguments = {}, accessor: ServicesAccessor): void {
	const config = <IWorkbenchEditorConfiguration>accessor.get(IConfigurationService).getConfiguration();
	const tabsShown = config.workbench && config.workbench.editor && config.workbench.editor.showTabs;
	args.to = args.to || ActiveEditorMovePositioning.RIGHT;
	args.by = tabsShown ? args.by || ActiveEditorMovePositioningBy.TAB : ActiveEditorMovePositioningBy.GROUP;
	args.value = types.isUndefined(args.value) ? 1 : args.value;

	const activeEditor = accessor.get(IWorkbenchEditorService).getActiveEditor();
	if (activeEditor) {
		switch (args.by) {
			case ActiveEditorMovePositioningBy.TAB:
				return moveActiveTab(args, activeEditor, accessor);
			case ActiveEditorMovePositioningBy.GROUP:
				return moveActiveEditorToGroup(args, activeEditor, accessor);
		}
	}
}

function moveActiveTab(args: ActiveEditorMoveArguments, activeEditor: IEditor, accessor: ServicesAccessor): void {
	const editorGroupsService: IEditorGroupService = accessor.get(IEditorGroupService);
	const editorGroup = editorGroupsService.getStacksModel().groupAt(activeEditor.position);
	let index = editorGroup.indexOf(activeEditor.input);
	switch (args.to) {
		case ActiveEditorMovePositioning.FIRST:
			index = 0;
			break;
		case ActiveEditorMovePositioning.LAST:
			index = editorGroup.count - 1;
			break;
		case ActiveEditorMovePositioning.LEFT:
			index = index - args.value;
			break;
		case ActiveEditorMovePositioning.RIGHT:
			index = index + args.value;
			break;
		case ActiveEditorMovePositioning.CENTER:
			index = Math.round(editorGroup.count / 2) - 1;
			break;
		case ActiveEditorMovePositioning.POSITION:
			index = args.value - 1;
			break;
	}

	index = index < 0 ? 0 : index >= editorGroup.count ? editorGroup.count - 1 : index;
	editorGroupsService.moveEditor(activeEditor.input, editorGroup, editorGroup, index);
}

function moveActiveEditorToGroup(args: ActiveEditorMoveArguments, activeEditor: IEditor, accessor: ServicesAccessor): void {
	let newPosition = activeEditor.position;
	switch (args.to) {
		case ActiveEditorMovePositioning.LEFT:
			newPosition = newPosition - 1;
			break;
		case ActiveEditorMovePositioning.RIGHT:
			newPosition = newPosition + 1;
			break;
		case ActiveEditorMovePositioning.FIRST:
			newPosition = Position.ONE;
			break;
		case ActiveEditorMovePositioning.LAST:
			newPosition = Position.THREE;
			break;
		case ActiveEditorMovePositioning.CENTER:
			newPosition = Position.TWO;
			break;
		case ActiveEditorMovePositioning.POSITION:
			newPosition = args.value - 1;
			break;
	}

	newPosition = POSITIONS.indexOf(newPosition) !== -1 ? newPosition : activeEditor.position;
	accessor.get(IEditorGroupService).moveEditor(activeEditor.input, activeEditor.position, newPosition);
}

function registerDiffEditorCommands(): void {
	KeybindingsRegistry.registerCommandAndKeybindingRule({
		id: 'workbench.action.compareEditor.nextChange',
		weight: KeybindingsRegistry.WEIGHT.workbenchContrib(),
		when: TextCompareEditorVisible,
		primary: null,
		handler: accessor => navigateInDiffEditor(accessor, true)
	});

	KeybindingsRegistry.registerCommandAndKeybindingRule({
		id: 'workbench.action.compareEditor.previousChange',
		weight: KeybindingsRegistry.WEIGHT.workbenchContrib(),
		when: TextCompareEditorVisible,
		primary: null,
		handler: accessor => navigateInDiffEditor(accessor, false)
	});

	function navigateInDiffEditor(accessor: ServicesAccessor, next: boolean): void {
		let editorService = accessor.get(IWorkbenchEditorService);
		const candidates = [editorService.getActiveEditor(), ...editorService.getVisibleEditors()].filter(e => e instanceof TextDiffEditor);

		if (candidates.length > 0) {
			next ? (<TextDiffEditor>candidates[0]).getDiffNavigator().next() : (<TextDiffEditor>candidates[0]).getDiffNavigator().previous();
		}
	}

	KeybindingsRegistry.registerCommandAndKeybindingRule({
		id: '_workbench.printStacksModel',
		weight: KeybindingsRegistry.WEIGHT.workbenchContrib(0),
		handler(accessor: ServicesAccessor) {
			console.log(`${accessor.get(IEditorGroupService).getStacksModel().toString()}\n\n`);
		},
		when: undefined,
		primary: undefined
	});

	KeybindingsRegistry.registerCommandAndKeybindingRule({
		id: '_workbench.validateStacksModel',
		weight: KeybindingsRegistry.WEIGHT.workbenchContrib(0),
		handler(accessor: ServicesAccessor) {
			(<EditorStacksModel>accessor.get(IEditorGroupService).getStacksModel()).validate();
		},
		when: undefined,
		primary: undefined
	});
}

function handleCommandDeprecations(): void {
	const mapDeprecatedCommands = {
		'workbench.action.focusFirstEditor': 'workbench.action.focusFirstEditorGroup',
		'workbench.action.focusSecondEditor': 'workbench.action.focusSecondEditorGroup',
		'workbench.action.focusThirdEditor': 'workbench.action.focusThirdEditorGroup',
		'workbench.action.focusLeftEditor': 'workbench.action.focusPreviousGroup',
		'workbench.action.focusRightEditor': 'workbench.action.focusNextGroup',
		'workbench.action.moveActiveEditorLeft': 'workbench.action.moveActiveEditorGroupLeft',
		'workbench.action.moveActiveEditorRight': 'workbench.action.moveActiveEditorGroupRight',
		'workbench.action.openPreviousEditor': 'workbench.action.openPreviousEditorFromHistory',
		'workbench.files.action.addToWorkingFiles': 'workbench.action.keepEditor',
		'workbench.files.action.closeAllFiles': 'workbench.action.closeAllEditors',
		'workbench.files.action.closeFile': 'workbench.action.closeActiveEditor',
		'workbench.files.action.closeOtherFiles': 'workbench.action.closeOtherEditors',
		'workbench.files.action.focusWorkingFiles': 'workbench.files.action.focusOpenEditorsView',
		'workbench.files.action.openNextWorkingFile': 'workbench.action.nextEditor',
		'workbench.files.action.openPreviousWorkingFile': 'workbench.action.previousEditor',
		'workbench.files.action.reopenClosedFile': 'workbench.action.reopenClosedEditor',
		'workbench.files.action.workingFilesPicker': 'workbench.action.showAllEditors',
		'workbench.action.cycleEditor': 'workbench.action.navigateEditorGroups',
		'workbench.action.terminal.focus': 'workbench.action.focusPanel',
		'workbench.action.showEditorsInLeftGroup': 'workbench.action.showEditorsInFirstGroup',
		'workbench.action.showEditorsInCenterGroup': 'workbench.action.showEditorsInSecondGroup',
		'workbench.action.showEditorsInRightGroup': 'workbench.action.showEditorsInThirdGroup',
		'workbench.action.moveEditorToLeftGroup': 'workbench.action.moveEditorToPreviousGroup',
		'workbench.action.moveEditorToRightGroup': 'workbench.action.moveEditorToNextGroup'
	};

	Object.keys(mapDeprecatedCommands).forEach(deprecatedCommandId => {
		const newCommandId = mapDeprecatedCommands[deprecatedCommandId];

		KeybindingsRegistry.registerCommandAndKeybindingRule({
			id: deprecatedCommandId,
			weight: KeybindingsRegistry.WEIGHT.workbenchContrib(0),
			handler(accessor: ServicesAccessor) {
				const messageService = accessor.get(IMessageService);
				const commandService = accessor.get(ICommandService);

				messageService.show(Severity.Warning, {
					message: nls.localize('commandDeprecated', "Command **{0}** has been removed. You can use **{1}** instead", deprecatedCommandId, newCommandId),
					actions: [
						new Action('openKeybindings', nls.localize('openKeybindings', "Configure Keyboard Shortcuts"), null, true, () => {
							return commandService.executeCommand('workbench.action.openGlobalKeybindings');
						}),
						CloseAction
					]
				});
			},
			when: undefined,
			primary: undefined
		});
	});
}