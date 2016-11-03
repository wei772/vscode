/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'vs/css!./media/scrollbar';
import 'vs/css!./media/terminal';
import 'vs/css!./media/xterm';
import * as panel from 'vs/workbench/browser/panel';
import * as platform from 'vs/base/common/platform';
import nls = require('vs/nls');
import { Extensions, IConfigurationRegistry } from 'vs/platform/configuration/common/configurationRegistry';
import { GlobalQuickOpenAction } from 'vs/workbench/browser/parts/quickopen/quickopen.contribution';
import { ITerminalService, KEYBINDING_CONTEXT_TERMINAL_FOCUS, TERMINAL_PANEL_ID, TERMINAL_DEFAULT_SHELL_LINUX, TERMINAL_DEFAULT_SHELL_OSX, TERMINAL_DEFAULT_SHELL_WINDOWS } from 'vs/workbench/parts/terminal/electron-browser/terminal';
import { IWorkbenchActionRegistry, Extensions as ActionExtensions } from 'vs/workbench/common/actionRegistry';
import { KeyCode, KeyMod } from 'vs/base/common/keyCodes';
import { KillTerminalAction, CopyTerminalSelectionAction, CreateNewTerminalAction, FocusTerminalAction, FocusNextTerminalAction, FocusPreviousTerminalAction, RunSelectedTextInTerminalAction, ScrollDownTerminalAction, ScrollDownPageTerminalAction, ScrollToBottomTerminalAction, ScrollUpTerminalAction, ScrollUpPageTerminalAction, ScrollToTopTerminalAction, TerminalPasteAction, ToggleTerminalAction, ClearTerminalAction } from 'vs/workbench/parts/terminal/electron-browser/terminalActions';
import { Registry } from 'vs/platform/platform';
import { ShowAllCommandsAction } from 'vs/workbench/parts/quickopen/browser/commandsHandler';
import { SyncActionDescriptor } from 'vs/platform/actions/common/actions';
import { TerminalService } from 'vs/workbench/parts/terminal/electron-browser/terminalService';
import { ToggleTabFocusModeAction } from 'vs/editor/contrib/toggleTabFocusMode/common/toggleTabFocusMode';
import { registerSingleton } from 'vs/platform/instantiation/common/extensions';
import debugActions = require('vs/workbench/parts/debug/browser/debugActions');

let configurationRegistry = <IConfigurationRegistry>Registry.as(Extensions.Configuration);
configurationRegistry.registerConfiguration({
	'id': 'terminal',
	'order': 100,
	'title': nls.localize('terminalIntegratedConfigurationTitle', "Integrated Terminal"),
	'type': 'object',
	'properties': {
		'terminal.integrated.shell.linux': {
			'description': nls.localize('terminal.integrated.shell.linux', "The path of the shell that the terminal uses on Linux."),
			'type': 'string',
			'default': TERMINAL_DEFAULT_SHELL_LINUX
		},
		'terminal.integrated.shellArgs.linux': {
			'description': nls.localize('terminal.integrated.shellArgs.linux', "The command line arguments to use when on the Linux terminal."),
			'type': 'array',
			'items': {
				'type': 'string'
			},
			'default': []
		},
		'terminal.integrated.shell.osx': {
			'description': nls.localize('terminal.integrated.shell.osx', "The path of the shell that the terminal uses on OS X."),
			'type': 'string',
			'default': TERMINAL_DEFAULT_SHELL_OSX
		},
		'terminal.integrated.shellArgs.osx': {
			'description': nls.localize('terminal.integrated.shellArgs.osx', "The command line arguments to use when on the OS X terminal."),
			'type': 'array',
			'items': {
				'type': 'string'
			},
			'default': []
		},
		'terminal.integrated.shell.windows': {
			'description': nls.localize('terminal.integrated.shell.windows', "The path of the shell that the terminal uses on Windows. When using shells shipped with Windows (cmd, PowerShell or Bash on Ubuntu), prefer C:\\Windows\\sysnative over C:\\Windows\\System32 to use the 64-bit versions."),
			'type': 'string',
			'default': TERMINAL_DEFAULT_SHELL_WINDOWS
		},
		'terminal.integrated.shellArgs.windows': {
			'description': nls.localize('terminal.integrated.shellArgs.windows', "The command line arguments to use when on the Windows terminal."),
			'type': 'array',
			'items': {
				'type': 'string'
			},
			'default': []
		},
		'terminal.integrated.fontFamily': {
			'description': nls.localize('terminal.integrated.fontFamily', "Controls the font family of the terminal, this defaults to editor.fontFamily's value."),
			'type': 'string'
		},
		'terminal.integrated.fontLigatures': {
			'description': nls.localize('terminal.integrated.fontLigatures', "Controls whether font ligatures are enabled in the terminal."),
			'type': 'boolean',
			'default': false
		},
		'terminal.integrated.fontSize': {
			'description': nls.localize('terminal.integrated.fontSize', "Controls the font size in pixels of the terminal, this defaults to editor.fontSize's value."),
			'type': 'number',
			'default': 0
		},
		'terminal.integrated.lineHeight': {
			'description': nls.localize('terminal.integrated.lineHeight', "Controls the line height of the terminal, this number is multipled by the terminal font size to get the actual line-height in pixels."),
			'type': 'number',
			'default': 1.2
		},
		'terminal.integrated.cursorBlinking': {
			'description': nls.localize('terminal.integrated.cursorBlinking', "Controls whether the terminal cursor blinks."),
			'type': 'boolean',
			'default': false
		},
		'terminal.integrated.setLocaleVariables': {
			'description': nls.localize('terminal.integrated.setLocaleVariables', "Controls whether locale variables are set at startup of the terminal, this defaults to true on OS X, false on other platforms."),
			'type': 'boolean',
			'default': platform.isMacintosh
		},
		'terminal.integrated.commandsToSkipShell': {
			'description': nls.localize('terminal.integrated.commandsToSkipShell', "A set of command IDs whose keybindings will not be sent to the shell and instead always be handled by Code. This allows the use of keybindings that would normally be consumed by the shell to act the same as when the terminal is not focused, for example ctrl+p to launch Quick Open."),
			'type': 'array',
			'items': {
				'type': 'string'
			},
			'default': [
				ToggleTabFocusModeAction.ID,
				GlobalQuickOpenAction.ID,
				ShowAllCommandsAction.ID,
				CreateNewTerminalAction.ID,
				CopyTerminalSelectionAction.ID,
				KillTerminalAction.ID,
				FocusTerminalAction.ID,
				FocusPreviousTerminalAction.ID,
				FocusNextTerminalAction.ID,
				TerminalPasteAction.ID,
				RunSelectedTextInTerminalAction.ID,
				ToggleTerminalAction.ID,
				ScrollDownTerminalAction.ID,
				ScrollDownPageTerminalAction.ID,
				ScrollToBottomTerminalAction.ID,
				ScrollUpTerminalAction.ID,
				ScrollUpPageTerminalAction.ID,
				ScrollToTopTerminalAction.ID,
				ClearTerminalAction.ID,
				debugActions.StartAction.ID,
				debugActions.StopAction.ID,
				debugActions.RunAction.ID,
				debugActions.RestartAction.ID,
				debugActions.ContinueAction.ID
			].sort()
		}
	}
});

registerSingleton(ITerminalService, TerminalService);

(<panel.PanelRegistry>Registry.as(panel.Extensions.Panels)).registerPanel(new panel.PanelDescriptor(
	'vs/workbench/parts/terminal/electron-browser/terminalPanel',
	'TerminalPanel',
	TERMINAL_PANEL_ID,
	nls.localize('terminal', "Terminal"),
	'terminal',
	40
));

// On mac cmd+` is reserved to cycle between windows, that's why the keybindings use WinCtrl
const category = nls.localize('terminalCategory', "Terminal");
let actionRegistry = <IWorkbenchActionRegistry>Registry.as(ActionExtensions.WorkbenchActions);
actionRegistry.registerWorkbenchAction(new SyncActionDescriptor(KillTerminalAction, KillTerminalAction.ID, KillTerminalAction.LABEL), 'Terminal: Kill the Active Terminal Instance', category);
actionRegistry.registerWorkbenchAction(new SyncActionDescriptor(CopyTerminalSelectionAction, CopyTerminalSelectionAction.ID, CopyTerminalSelectionAction.LABEL, {
	primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KEY_C,
	// Don't apply to Mac since cmd+c works
	mac: { primary: null }
}, KEYBINDING_CONTEXT_TERMINAL_FOCUS), 'Terminal: Copy Selection', category);
actionRegistry.registerWorkbenchAction(new SyncActionDescriptor(CreateNewTerminalAction, CreateNewTerminalAction.ID, CreateNewTerminalAction.LABEL, {
	primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.US_BACKTICK,
	mac: { primary: KeyMod.WinCtrl | KeyMod.Shift | KeyCode.US_BACKTICK }
}), 'Terminal: Create New Integrated Terminal', category);
actionRegistry.registerWorkbenchAction(new SyncActionDescriptor(FocusTerminalAction, FocusTerminalAction.ID, FocusTerminalAction.LABEL), 'Terminal: Focus Terminal', category);
actionRegistry.registerWorkbenchAction(new SyncActionDescriptor(FocusNextTerminalAction, FocusNextTerminalAction.ID, FocusNextTerminalAction.LABEL), 'Terminal: Focus Next Terminal', category);
actionRegistry.registerWorkbenchAction(new SyncActionDescriptor(FocusPreviousTerminalAction, FocusPreviousTerminalAction.ID, FocusPreviousTerminalAction.LABEL), 'Terminal: Focus Previous Terminal', category);
actionRegistry.registerWorkbenchAction(new SyncActionDescriptor(TerminalPasteAction, TerminalPasteAction.ID, TerminalPasteAction.LABEL, {
	primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KEY_V,
	// Don't apply to Mac since cmd+v works
	mac: { primary: null }
}, KEYBINDING_CONTEXT_TERMINAL_FOCUS), 'Terminal: Paste into Active Terminal', category);
actionRegistry.registerWorkbenchAction(new SyncActionDescriptor(RunSelectedTextInTerminalAction, RunSelectedTextInTerminalAction.ID, RunSelectedTextInTerminalAction.LABEL), 'Terminal: Run Selected Text In Active Terminal', category);
actionRegistry.registerWorkbenchAction(new SyncActionDescriptor(ToggleTerminalAction, ToggleTerminalAction.ID, ToggleTerminalAction.LABEL, {
	primary: KeyMod.CtrlCmd | KeyCode.US_BACKTICK,
	mac: { primary: KeyMod.WinCtrl | KeyCode.US_BACKTICK }
}), 'View: Toggle Integrated Terminal', nls.localize('viewCategory', "View"));
actionRegistry.registerWorkbenchAction(new SyncActionDescriptor(ScrollDownTerminalAction, ScrollDownTerminalAction.ID, ScrollDownTerminalAction.LABEL, {
	primary: KeyMod.CtrlCmd | KeyCode.DownArrow,
	linux: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.DownArrow }
}, KEYBINDING_CONTEXT_TERMINAL_FOCUS), 'Terminal: Scroll Down (Line)', category);
actionRegistry.registerWorkbenchAction(new SyncActionDescriptor(ScrollDownPageTerminalAction, ScrollDownPageTerminalAction.ID, ScrollDownPageTerminalAction.LABEL, {
	primary: KeyMod.Shift | KeyCode.PageDown,
	mac: { primary: KeyCode.PageDown }
}, KEYBINDING_CONTEXT_TERMINAL_FOCUS), 'Terminal: Scroll Down (Page)', category);
actionRegistry.registerWorkbenchAction(new SyncActionDescriptor(ScrollToBottomTerminalAction, ScrollToBottomTerminalAction.ID, ScrollToBottomTerminalAction.LABEL, {
	primary: KeyMod.CtrlCmd | KeyCode.End,
	linux: { primary: KeyMod.Shift | KeyCode.End }
}, KEYBINDING_CONTEXT_TERMINAL_FOCUS), 'Terminal: Scroll to Bottom', category);
actionRegistry.registerWorkbenchAction(new SyncActionDescriptor(ScrollUpTerminalAction, ScrollUpTerminalAction.ID, ScrollUpTerminalAction.LABEL, {
	primary: KeyMod.CtrlCmd | KeyCode.UpArrow,
	linux: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.UpArrow },
}, KEYBINDING_CONTEXT_TERMINAL_FOCUS), 'Terminal: Scroll Up (Line)', category);
actionRegistry.registerWorkbenchAction(new SyncActionDescriptor(ScrollUpPageTerminalAction, ScrollUpPageTerminalAction.ID, ScrollUpPageTerminalAction.LABEL, {
	primary: KeyMod.Shift | KeyCode.PageUp,
	mac: { primary: KeyCode.PageUp }
}, KEYBINDING_CONTEXT_TERMINAL_FOCUS), 'Terminal: Scroll Up (Page)', category);
actionRegistry.registerWorkbenchAction(new SyncActionDescriptor(ScrollToTopTerminalAction, ScrollToTopTerminalAction.ID, ScrollToTopTerminalAction.LABEL, {
	primary: KeyMod.CtrlCmd | KeyCode.Home,
	linux: { primary: KeyMod.Shift | KeyCode.Home }
}, KEYBINDING_CONTEXT_TERMINAL_FOCUS), 'Terminal: Scroll to Top', category);
actionRegistry.registerWorkbenchAction(new SyncActionDescriptor(ClearTerminalAction, ClearTerminalAction.ID, ClearTerminalAction.LABEL), 'Terminal: Clear', category);
