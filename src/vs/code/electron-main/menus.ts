/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as nls from 'vs/nls';
import * as platform from 'vs/base/common/platform';
import * as arrays from 'vs/base/common/arrays';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { ipcMain as ipc, app, shell, dialog, Menu, MenuItem } from 'electron';
import { IWindowsMainService } from 'vs/code/electron-main/windows';
import { IPath, VSCodeWindow } from 'vs/code/electron-main/window';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IStorageService } from 'vs/code/electron-main/storage';
import { IFilesConfiguration, AutoSaveConfiguration } from 'vs/platform/files/common/files';
import { IUpdateService, State as UpdateState } from 'vs/code/electron-main/update-manager';
import { Keybinding } from 'vs/base/common/keybinding';
import product from 'vs/platform/product';

interface IResolvedKeybinding {
	id: string;
	binding: number;
}

interface IConfiguration extends IFilesConfiguration {
	workbench: {
		sideBar: {
			location: 'left' | 'right';
		},
		statusBar: {
			visible: boolean;
		}
	};
}

export class VSCodeMenu {

	private static lastKnownKeybindingsMapStorageKey = 'lastKnownKeybindings';

	private static MAX_MENU_RECENT_ENTRIES = 10;

	private currentAutoSaveSetting: string;
	private currentSidebarLocation: 'left' | 'right';
	private currentStatusbarVisible: boolean;

	private isQuitting: boolean;
	private appMenuInstalled: boolean;

	private actionIdKeybindingRequests: string[];
	private mapLastKnownKeybindingToActionId: { [id: string]: string; };
	private mapResolvedKeybindingToActionId: { [id: string]: string; };
	private keybindingsResolved: boolean;

	constructor(
		@IStorageService private storageService: IStorageService,
		@IUpdateService private updateService: IUpdateService,
		@IConfigurationService private configurationService: IConfigurationService,
		@IWindowsMainService private windowsService: IWindowsMainService,
		@IEnvironmentService private environmentService: IEnvironmentService
	) {
		this.actionIdKeybindingRequests = [];

		this.mapResolvedKeybindingToActionId = Object.create(null);
		this.mapLastKnownKeybindingToActionId = this.storageService.getItem<{ [id: string]: string; }>(VSCodeMenu.lastKnownKeybindingsMapStorageKey) || Object.create(null);

		this.onConfigurationUpdated(this.configurationService.getConfiguration<IConfiguration>());
	}

	public ready(): void {
		this.registerListeners();
		this.install();
	}

	private registerListeners(): void {

		// Keep flag when app quits
		app.on('will-quit', () => {
			this.isQuitting = true;
		});

		// Listen to "open" & "close" event from window service
		this.windowsService.onOpen(paths => this.onOpen(paths));
		this.windowsService.onClose(_ => this.onClose(this.windowsService.getWindowCount()));

		// Resolve keybindings when any first workbench is loaded
		this.windowsService.onReady(win => this.resolveKeybindings(win));

		// Listen to resolved keybindings
		ipc.on('vscode:keybindingsResolved', (event, rawKeybindings) => {
			let keybindings: IResolvedKeybinding[] = [];
			try {
				keybindings = JSON.parse(rawKeybindings);
			} catch (error) {
				// Should not happen
			}

			// Fill hash map of resolved keybindings
			let needsMenuUpdate = false;
			keybindings.forEach(keybinding => {
				const accelerator = new Keybinding(keybinding.binding)._toElectronAccelerator();
				if (accelerator) {
					this.mapResolvedKeybindingToActionId[keybinding.id] = accelerator;
					if (this.mapLastKnownKeybindingToActionId[keybinding.id] !== accelerator) {
						needsMenuUpdate = true; // we only need to update when something changed!
					}
				}
			});

			// A keybinding might have been unassigned, so we have to account for that too
			if (Object.keys(this.mapLastKnownKeybindingToActionId).length !== Object.keys(this.mapResolvedKeybindingToActionId).length) {
				needsMenuUpdate = true;
			}

			if (needsMenuUpdate) {
				this.storageService.setItem(VSCodeMenu.lastKnownKeybindingsMapStorageKey, this.mapResolvedKeybindingToActionId); // keep to restore instantly after restart
				this.mapLastKnownKeybindingToActionId = this.mapResolvedKeybindingToActionId; // update our last known map

				this.updateMenu();
			}
		});

		// Update when auto save config changes
		this.configurationService.onDidUpdateConfiguration(e => this.onConfigurationUpdated(e.config, true /* update menu if changed */));

		// Listen to update service
		this.updateService.on('change', () => this.updateMenu());
	}

	private onConfigurationUpdated(config: IConfiguration, handleMenu?: boolean): void {
		let updateMenu = false;
		const newAutoSaveSetting = config && config.files && config.files.autoSave;
		if (newAutoSaveSetting !== this.currentAutoSaveSetting) {
			this.currentAutoSaveSetting = newAutoSaveSetting;
			updateMenu = true;
		}

		if (config && config.workbench) {
			const newSidebarLocation = config.workbench.sideBar && config.workbench.sideBar.location || 'left';
			if (newSidebarLocation !== this.currentSidebarLocation) {
				this.currentSidebarLocation = newSidebarLocation;
				updateMenu = true;
			}

			let newStatusbarVisible = config.workbench.statusBar && config.workbench.statusBar.visible;
			if (typeof newStatusbarVisible !== 'boolean') {
				newStatusbarVisible = true;
			}
			if (newStatusbarVisible !== this.currentStatusbarVisible) {
				this.currentStatusbarVisible = newStatusbarVisible;
				updateMenu = true;
			}
		}

		if (handleMenu && updateMenu) {
			this.updateMenu();
		}
	}

	private resolveKeybindings(win: VSCodeWindow): void {
		if (this.keybindingsResolved) {
			return; // only resolve once
		}

		this.keybindingsResolved = true;

		// Resolve keybindings when workbench window is up
		if (this.actionIdKeybindingRequests.length) {
			win.send('vscode:resolveKeybindings', JSON.stringify(this.actionIdKeybindingRequests));
		}
	}

	private updateMenu(): void {

		// Due to limitations in Electron, it is not possible to update menu items dynamically. The suggested
		// workaround from Electron is to set the application menu again.
		// See also https://github.com/electron/electron/issues/846
		//
		// Run delayed to prevent updating menu while it is open
		if (!this.isQuitting) {
			setTimeout(() => {
				if (!this.isQuitting) {
					this.install();
				}
			}, 10 /* delay this because there is an issue with updating a menu when it is open */);
		}
	}

	private onOpen(path: IPath): void {
		this.updateMenu();
	}

	private onClose(remainingWindowCount: number): void {
		if (remainingWindowCount === 0 && platform.isMacintosh) {
			this.updateMenu();
		}
	}

	private install(): void {

		// Menus
		const menubar = new Menu();

		// Mac: Application
		let macApplicationMenuItem: Electron.MenuItem;
		if (platform.isMacintosh) {
			const applicationMenu = new Menu();
			macApplicationMenuItem = new MenuItem({ label: product.nameShort, submenu: applicationMenu });
			this.setMacApplicationMenu(applicationMenu);
		}

		// File
		const fileMenu = new Menu();
		const fileMenuItem = new MenuItem({ label: mnemonicLabel(nls.localize({ key: 'mFile', comment: ['&& denotes a mnemonic'] }, "&&File")), submenu: fileMenu });
		this.setFileMenu(fileMenu);

		// Edit
		const editMenu = new Menu();
		const editMenuItem = new MenuItem({ label: mnemonicLabel(nls.localize({ key: 'mEdit', comment: ['&& denotes a mnemonic'] }, "&&Edit")), submenu: editMenu });
		this.setEditMenu(editMenu);

		// View
		const viewMenu = new Menu();
		const viewMenuItem = new MenuItem({ label: mnemonicLabel(nls.localize({ key: 'mView', comment: ['&& denotes a mnemonic'] }, "&&View")), submenu: viewMenu });
		this.setViewMenu(viewMenu);

		// Goto
		const gotoMenu = new Menu();
		const gotoMenuItem = new MenuItem({ label: mnemonicLabel(nls.localize({ key: 'mGoto', comment: ['&& denotes a mnemonic'] }, "&&Go")), submenu: gotoMenu });
		this.setGotoMenu(gotoMenu);

		// Mac: Window
		let macWindowMenuItem: Electron.MenuItem;
		if (platform.isMacintosh) {
			const windowMenu = new Menu();
			macWindowMenuItem = new MenuItem({ label: mnemonicLabel(nls.localize('mWindow', "Window")), submenu: windowMenu, role: 'window' });
			this.setMacWindowMenu(windowMenu);
		}

		// Help
		const helpMenu = new Menu();
		const helpMenuItem = new MenuItem({ label: mnemonicLabel(nls.localize({ key: 'mHelp', comment: ['&& denotes a mnemonic'] }, "&&Help")), submenu: helpMenu, role: 'help' });
		this.setHelpMenu(helpMenu);

		// Menu Structure
		if (macApplicationMenuItem) {
			menubar.append(macApplicationMenuItem);
		}

		menubar.append(fileMenuItem);
		menubar.append(editMenuItem);
		menubar.append(viewMenuItem);
		menubar.append(gotoMenuItem);

		if (macWindowMenuItem) {
			menubar.append(macWindowMenuItem);
		}

		menubar.append(helpMenuItem);

		Menu.setApplicationMenu(menubar);

		// Dock Menu
		if (platform.isMacintosh && !this.appMenuInstalled) {
			this.appMenuInstalled = true;

			const dockMenu = new Menu();
			dockMenu.append(new MenuItem({ label: mnemonicLabel(nls.localize({ key: 'miNewWindow', comment: ['&& denotes a mnemonic'] }, "&&New Window")), click: () => this.windowsService.openNewWindow() }));

			app.dock.setMenu(dockMenu);
		}
	}

	private setMacApplicationMenu(macApplicationMenu: Electron.Menu): void {
		const about = new MenuItem({ label: nls.localize('mAbout', "About {0}", product.nameLong), role: 'about' });
		const checkForUpdates = this.getUpdateMenuItems();
		const preferences = this.getPreferencesMenu();
		const hide = new MenuItem({ label: nls.localize('mHide', "Hide {0}", product.nameLong), role: 'hide', accelerator: 'Command+H' });
		const hideOthers = new MenuItem({ label: nls.localize('mHideOthers', "Hide Others"), role: 'hideothers', accelerator: 'Command+Alt+H' });
		const showAll = new MenuItem({ label: nls.localize('mShowAll', "Show All"), role: 'unhide' });
		const quit = new MenuItem({ label: nls.localize('miQuit', "Quit {0}", product.nameLong), click: () => this.quit(), accelerator: 'Command+Q' });

		const actions = [about];
		actions.push(...checkForUpdates);
		actions.push(...[
			__separator__(),
			preferences,
			__separator__(),
			hide,
			hideOthers,
			showAll,
			__separator__(),
			quit
		]);

		actions.forEach(i => macApplicationMenu.append(i));
	}

	private setFileMenu(fileMenu: Electron.Menu): void {
		const hasNoWindows = (this.windowsService.getWindowCount() === 0);

		let newFile: Electron.MenuItem;
		if (hasNoWindows) {
			newFile = new MenuItem({ label: mnemonicLabel(nls.localize({ key: 'miNewFile', comment: ['&& denotes a mnemonic'] }, "&&New File")), accelerator: this.getAccelerator('workbench.action.files.newUntitledFile'), click: () => this.windowsService.openNewWindow() });
		} else {
			newFile = this.createMenuItem(nls.localize({ key: 'miNewFile', comment: ['&& denotes a mnemonic'] }, "&&New File"), 'workbench.action.files.newUntitledFile');
		}

		const open = new MenuItem({ label: mnemonicLabel(nls.localize({ key: 'miOpen', comment: ['&& denotes a mnemonic'] }, "&&Open...")), accelerator: this.getAccelerator('workbench.action.files.openFileFolder'), click: () => this.windowsService.openFileFolderPicker() });
		const openFolder = new MenuItem({ label: mnemonicLabel(nls.localize({ key: 'miOpenFolder', comment: ['&& denotes a mnemonic'] }, "Open &&Folder...")), accelerator: this.getAccelerator('workbench.action.files.openFolder'), click: () => this.windowsService.openFolderPicker() });

		let openFile: Electron.MenuItem;
		if (hasNoWindows) {
			openFile = new MenuItem({ label: mnemonicLabel(nls.localize({ key: 'miOpenFile', comment: ['&& denotes a mnemonic'] }, "&&Open File...")), accelerator: this.getAccelerator('workbench.action.files.openFile'), click: () => this.windowsService.openFilePicker() });
		} else {
			openFile = this.createMenuItem(nls.localize({ key: 'miOpenFile', comment: ['&& denotes a mnemonic'] }, "&&Open File..."), 'workbench.action.files.openFile');
		}

		const openRecentMenu = new Menu();
		this.setOpenRecentMenu(openRecentMenu);
		const openRecent = new MenuItem({ label: mnemonicLabel(nls.localize({ key: 'miOpenRecent', comment: ['&& denotes a mnemonic'] }, "Open &&Recent")), submenu: openRecentMenu, enabled: openRecentMenu.items.length > 0 });

		const saveFile = this.createMenuItem(nls.localize({ key: 'miSave', comment: ['&& denotes a mnemonic'] }, "&&Save"), 'workbench.action.files.save', this.windowsService.getWindowCount() > 0);
		const saveFileAs = this.createMenuItem(nls.localize({ key: 'miSaveAs', comment: ['&& denotes a mnemonic'] }, "Save &&As..."), 'workbench.action.files.saveAs', this.windowsService.getWindowCount() > 0);
		const saveAllFiles = this.createMenuItem(nls.localize({ key: 'miSaveAll', comment: ['&& denotes a mnemonic'] }, "Save A&&ll"), 'workbench.action.files.saveAll', this.windowsService.getWindowCount() > 0);

		const autoSaveEnabled = [AutoSaveConfiguration.AFTER_DELAY, AutoSaveConfiguration.ON_FOCUS_CHANGE, AutoSaveConfiguration.ON_WINDOW_CHANGE].some(s => this.currentAutoSaveSetting === s);
		const autoSave = new MenuItem({ label: mnemonicLabel(nls.localize('miAutoSave', "Auto Save")), type: 'checkbox', checked: autoSaveEnabled, enabled: this.windowsService.getWindowCount() > 0, click: () => this.windowsService.sendToFocused('vscode.toggleAutoSave') });

		const preferences = this.getPreferencesMenu();

		const newWindow = new MenuItem({ label: mnemonicLabel(nls.localize({ key: 'miNewWindow', comment: ['&& denotes a mnemonic'] }, "&&New Window")), accelerator: this.getAccelerator('workbench.action.newWindow'), click: () => this.windowsService.openNewWindow() });
		const revertFile = this.createMenuItem(nls.localize({ key: 'miRevert', comment: ['&& denotes a mnemonic'] }, "Revert F&&ile"), 'workbench.action.files.revert', this.windowsService.getWindowCount() > 0);
		const closeWindow = new MenuItem({ label: mnemonicLabel(nls.localize({ key: 'miCloseWindow', comment: ['&& denotes a mnemonic'] }, "Close &&Window")), accelerator: this.getAccelerator('workbench.action.closeWindow'), click: () => this.windowsService.getLastActiveWindow().win.close(), enabled: this.windowsService.getWindowCount() > 0 });

		const closeFolder = this.createMenuItem(nls.localize({ key: 'miCloseFolder', comment: ['&& denotes a mnemonic'] }, "Close &&Folder"), 'workbench.action.closeFolder');
		const closeEditor = this.createMenuItem(nls.localize({ key: 'miCloseEditor', comment: ['&& denotes a mnemonic'] }, "Close &&Editor"), 'workbench.action.closeActiveEditor');

		const exit = this.createMenuItem(nls.localize({ key: 'miExit', comment: ['&& denotes a mnemonic'] }, "E&&xit"), () => this.quit());

		arrays.coalesce([
			newFile,
			newWindow,
			__separator__(),
			platform.isMacintosh ? open : null,
			!platform.isMacintosh ? openFile : null,
			!platform.isMacintosh ? openFolder : null,
			openRecent,
			__separator__(),
			saveFile,
			saveFileAs,
			saveAllFiles,
			__separator__(),
			autoSave,
			__separator__(),
			!platform.isMacintosh ? preferences : null,
			!platform.isMacintosh ? __separator__() : null,
			revertFile,
			closeEditor,
			closeFolder,
			!platform.isMacintosh ? closeWindow : null,
			!platform.isMacintosh ? __separator__() : null,
			!platform.isMacintosh ? exit : null
		]).forEach(item => fileMenu.append(item));
	}

	private getPreferencesMenu(): Electron.MenuItem {
		const userSettings = this.createMenuItem(nls.localize({ key: 'miOpenSettings', comment: ['&& denotes a mnemonic'] }, "&&User Settings"), 'workbench.action.openGlobalSettings');
		const workspaceSettings = this.createMenuItem(nls.localize({ key: 'miOpenWorkspaceSettings', comment: ['&& denotes a mnemonic'] }, "&&Workspace Settings"), 'workbench.action.openWorkspaceSettings');
		const kebindingSettings = this.createMenuItem(nls.localize({ key: 'miOpenKeymap', comment: ['&& denotes a mnemonic'] }, "&&Keyboard Shortcuts"), 'workbench.action.openGlobalKeybindings');
		const snippetsSettings = this.createMenuItem(nls.localize({ key: 'miOpenSnippets', comment: ['&& denotes a mnemonic'] }, "User &&Snippets"), 'workbench.action.openSnippets');
		const colorThemeSelection = this.createMenuItem(nls.localize({ key: 'miSelectColorTheme', comment: ['&& denotes a mnemonic'] }, "&&Color Theme"), 'workbench.action.selectTheme');
		const iconThemeSelection = this.createMenuItem(nls.localize({ key: 'miSelectIconTheme', comment: ['&& denotes a mnemonic'] }, "File &&Icon Theme"), 'workbench.action.selectIconTheme');

		const preferencesMenu = new Menu();
		preferencesMenu.append(userSettings);
		preferencesMenu.append(workspaceSettings);
		preferencesMenu.append(__separator__());
		preferencesMenu.append(kebindingSettings);
		preferencesMenu.append(__separator__());
		preferencesMenu.append(snippetsSettings);
		preferencesMenu.append(__separator__());
		preferencesMenu.append(colorThemeSelection);
		preferencesMenu.append(iconThemeSelection);

		return new MenuItem({ label: mnemonicLabel(nls.localize({ key: 'miPreferences', comment: ['&& denotes a mnemonic'] }, "&&Preferences")), submenu: preferencesMenu });
	}

	private quit(): void {

		// If the user selected to exit from an extension development host window, do not quit, but just
		// close the window unless this is the last window that is opened.
		const vscodeWindow = this.windowsService.getFocusedWindow();
		if (vscodeWindow && vscodeWindow.isPluginDevelopmentHost && this.windowsService.getWindowCount() > 1) {
			vscodeWindow.win.close();
		}

		// Otherwise: normal quit
		else {
			setTimeout(() => {
				this.isQuitting = true;

				app.quit();
			}, 10 /* delay this because there is an issue with quitting while the menu is open */);
		}
	}

	private setOpenRecentMenu(openRecentMenu: Electron.Menu): void {
		openRecentMenu.append(this.createMenuItem(nls.localize({ key: 'miReopenClosedEditor', comment: ['&& denotes a mnemonic'] }, "&&Reopen Closed Editor"), 'workbench.action.reopenClosedEditor'));

		const {folders, files} = this.windowsService.getRecentPathsList();

		// Folders
		if (folders.length > 0) {
			openRecentMenu.append(__separator__());

			for (let i = 0; i < VSCodeMenu.MAX_MENU_RECENT_ENTRIES && i < folders.length; i++) {
				openRecentMenu.append(this.createOpenRecentMenuItem(folders[i]));
			}
		}

		// Files
		if (files.length > 0) {
			openRecentMenu.append(__separator__());

			for (let i = 0; i < VSCodeMenu.MAX_MENU_RECENT_ENTRIES && i < files.length; i++) {
				openRecentMenu.append(this.createOpenRecentMenuItem(files[i]));
			}
		}

		if (folders.length || files.length) {
			openRecentMenu.append(__separator__());
			openRecentMenu.append(new MenuItem({ label: mnemonicLabel(nls.localize({ key: 'miClearItems', comment: ['&& denotes a mnemonic'] }, "&&Clear Items")), click: () => { this.windowsService.clearRecentPathsList(); this.updateMenu(); } }));
		}
	}

	private createOpenRecentMenuItem(path: string): Electron.MenuItem {
		return new MenuItem({
			label: unMnemonicLabel(path), click: (menuItem, win, event) => {
				const openInNewWindow = event && ((!platform.isMacintosh && event.ctrlKey) || (platform.isMacintosh && event.metaKey));
				const success = !!this.windowsService.open({ cli: this.environmentService.args, pathsToOpen: [path], forceNewWindow: openInNewWindow });
				if (!success) {
					this.windowsService.removeFromRecentPathsList(path);
					this.updateMenu();
				}
			}
		});
	}

	private createRoleMenuItem(label: string, actionId: string, role: Electron.MenuItemRole): Electron.MenuItem {
		const options: Electron.MenuItemOptions = {
			label: mnemonicLabel(label),
			accelerator: this.getAccelerator(actionId),
			role,
			enabled: true
		};

		return new MenuItem(options);
	}

	private setEditMenu(winLinuxEditMenu: Electron.Menu): void {
		let undo: Electron.MenuItem;
		let redo: Electron.MenuItem;
		let cut: Electron.MenuItem;
		let copy: Electron.MenuItem;
		let paste: Electron.MenuItem;
		let selectAll: Electron.MenuItem;

		if (platform.isMacintosh) {
			undo = this.createDevToolsAwareMenuItem(nls.localize({ key: 'miUndo', comment: ['&& denotes a mnemonic'] }, "&&Undo"), 'undo', devTools => devTools.undo());
			redo = this.createDevToolsAwareMenuItem(nls.localize({ key: 'miRedo', comment: ['&& denotes a mnemonic'] }, "&&Redo"), 'redo', devTools => devTools.redo());
			cut = this.createRoleMenuItem(nls.localize({ key: 'miCut', comment: ['&& denotes a mnemonic'] }, "&&Cut"), 'editor.action.clipboardCutAction', 'cut');
			copy = this.createRoleMenuItem(nls.localize({ key: 'miCopy', comment: ['&& denotes a mnemonic'] }, "C&&opy"), 'editor.action.clipboardCopyAction', 'copy');
			paste = this.createRoleMenuItem(nls.localize({ key: 'miPaste', comment: ['&& denotes a mnemonic'] }, "&&Paste"), 'editor.action.clipboardPasteAction', 'paste');
			selectAll = this.createDevToolsAwareMenuItem(nls.localize({ key: 'miSelectAll', comment: ['&& denotes a mnemonic'] }, "&&Select All"), 'editor.action.selectAll', (devTools) => devTools.selectAll());
		} else {
			undo = this.createMenuItem(nls.localize({ key: 'miUndo', comment: ['&& denotes a mnemonic'] }, "&&Undo"), 'undo');
			redo = this.createMenuItem(nls.localize({ key: 'miRedo', comment: ['&& denotes a mnemonic'] }, "&&Redo"), 'redo');
			cut = this.createMenuItem(nls.localize({ key: 'miCut', comment: ['&& denotes a mnemonic'] }, "&&Cut"), 'editor.action.clipboardCutAction');
			copy = this.createMenuItem(nls.localize({ key: 'miCopy', comment: ['&& denotes a mnemonic'] }, "C&&opy"), 'editor.action.clipboardCopyAction');
			paste = this.createMenuItem(nls.localize({ key: 'miPaste', comment: ['&& denotes a mnemonic'] }, "&&Paste"), 'editor.action.clipboardPasteAction');
			selectAll = this.createMenuItem(nls.localize({ key: 'miSelectAll', comment: ['&& denotes a mnemonic'] }, "&&Select All"), 'editor.action.selectAll');
		}

		const find = this.createMenuItem(nls.localize({ key: 'miFind', comment: ['&& denotes a mnemonic'] }, "&&Find"), 'actions.find');
		const replace = this.createMenuItem(nls.localize({ key: 'miReplace', comment: ['&& denotes a mnemonic'] }, "&&Replace"), 'editor.action.startFindReplaceAction');
		const findInFiles = this.createMenuItem(nls.localize({ key: 'miFindInFiles', comment: ['&& denotes a mnemonic'] }, "Find &&in Files"), 'workbench.action.findInFiles');
		const replaceInFiles = this.createMenuItem(nls.localize({ key: 'miReplaceInFiles', comment: ['&& denotes a mnemonic'] }, "Replace &&in Files"), 'workbench.action.replaceInFiles');

		[
			undo,
			redo,
			__separator__(),
			cut,
			copy,
			paste,
			selectAll,
			__separator__(),
			find,
			replace,
			__separator__(),
			findInFiles,
			replaceInFiles
		].forEach(item => winLinuxEditMenu.append(item));
	}

	private setViewMenu(viewMenu: Electron.Menu): void {
		const explorer = this.createMenuItem(nls.localize({ key: 'miViewExplorer', comment: ['&& denotes a mnemonic'] }, "&&Explorer"), 'workbench.view.explorer');
		const search = this.createMenuItem(nls.localize({ key: 'miViewSearch', comment: ['&& denotes a mnemonic'] }, "&&Search"), 'workbench.view.search');
		const git = this.createMenuItem(nls.localize({ key: 'miViewGit', comment: ['&& denotes a mnemonic'] }, "&&Git"), 'workbench.view.git');
		const debug = this.createMenuItem(nls.localize({ key: 'miViewDebug', comment: ['&& denotes a mnemonic'] }, "&&Debug"), 'workbench.view.debug');
		const extensions = this.createMenuItem(nls.localize({ key: 'miViewExtensions', comment: ['&& denotes a mnemonic'] }, "E&&xtensions"), 'workbench.view.extensions');
		const output = this.createMenuItem(nls.localize({ key: 'miToggleOutput', comment: ['&& denotes a mnemonic'] }, "&&Output"), 'workbench.action.output.toggleOutput');
		const debugConsole = this.createMenuItem(nls.localize({ key: 'miToggleDebugConsole', comment: ['&& denotes a mnemonic'] }, "De&&bug Console"), 'workbench.debug.action.toggleRepl');
		const integratedTerminal = this.createMenuItem(nls.localize({ key: 'miToggleIntegratedTerminal', comment: ['&& denotes a mnemonic'] }, "&&Integrated Terminal"), 'workbench.action.terminal.toggleTerminal');
		const problems = this.createMenuItem(nls.localize({ key: 'miMarker', comment: ['&& denotes a mnemonic'] }, "&&Problems"), 'workbench.actions.view.problems');

		const commands = this.createMenuItem(nls.localize({ key: 'miCommandPalette', comment: ['&& denotes a mnemonic'] }, "&&Command Palette..."), 'workbench.action.showCommands');

		const fullscreen = new MenuItem({ label: mnemonicLabel(nls.localize({ key: 'miToggleFullScreen', comment: ['&& denotes a mnemonic'] }, "Toggle &&Full Screen")), accelerator: this.getAccelerator('workbench.action.toggleFullScreen'), click: () => this.windowsService.getLastActiveWindow().toggleFullScreen(), enabled: this.windowsService.getWindowCount() > 0 });
		const toggleMenuBar = this.createMenuItem(nls.localize({ key: 'miToggleMenuBar', comment: ['&& denotes a mnemonic'] }, "Toggle Menu &&Bar"), 'workbench.action.toggleMenuBar');
		const splitEditor = this.createMenuItem(nls.localize({ key: 'miSplitEditor', comment: ['&& denotes a mnemonic'] }, "Split &&Editor"), 'workbench.action.splitEditor');
		const toggleEditorLayout = this.createMenuItem(nls.localize({ key: 'miToggleEditorLayout', comment: ['&& denotes a mnemonic'] }, "Toggle Editor Group &&Layout"), 'workbench.action.toggleEditorGroupLayout');
		const toggleSidebar = this.createMenuItem(nls.localize({ key: 'miToggleSidebar', comment: ['&& denotes a mnemonic'] }, "&&Toggle Side Bar"), 'workbench.action.toggleSidebarVisibility');

		let moveSideBarLabel: string;
		if (this.currentSidebarLocation !== 'right') {
			moveSideBarLabel = nls.localize({ key: 'miMoveSidebarRight', comment: ['&& denotes a mnemonic'] }, "&&Move Side Bar Right");
		} else {
			moveSideBarLabel = nls.localize({ key: 'miMoveSidebarLeft', comment: ['&& denotes a mnemonic'] }, "&&Move Side Bar Left");
		}

		const moveSidebar = this.createMenuItem(moveSideBarLabel, 'workbench.action.toggleSidebarPosition');

		const togglePanel = this.createMenuItem(nls.localize({ key: 'miTogglePanel', comment: ['&& denotes a mnemonic'] }, "Toggle &&Panel"), 'workbench.action.togglePanel');

		let statusBarLabel: string;
		if (this.currentStatusbarVisible) {
			statusBarLabel = nls.localize({ key: 'miHideStatusbar', comment: ['&& denotes a mnemonic'] }, "&&Hide Status Bar");
		} else {
			statusBarLabel = nls.localize({ key: 'miShowStatusbar', comment: ['&& denotes a mnemonic'] }, "&&Show Status Bar");
		}
		const toggleStatusbar = this.createMenuItem(statusBarLabel, 'workbench.action.toggleStatusbarVisibility');

		const toggleWordWrap = this.createMenuItem(nls.localize({ key: 'miToggleWordWrap', comment: ['&& denotes a mnemonic'] }, "Toggle &&Word Wrap"), 'editor.action.toggleWordWrap');
		const toggleRenderWhitespace = this.createMenuItem(nls.localize({ key: 'miToggleRenderWhitespace', comment: ['&& denotes a mnemonic'] }, "Toggle &&Render Whitespace"), 'editor.action.toggleRenderWhitespace');
		const toggleRenderControlCharacters = this.createMenuItem(nls.localize({ key: 'miToggleRenderControlCharacters', comment: ['&& denotes a mnemonic'] }, "Toggle &&Control Characters"), 'editor.action.toggleRenderControlCharacter');

		const zoomIn = this.createMenuItem(nls.localize({ key: 'miZoomIn', comment: ['&& denotes a mnemonic'] }, "&&Zoom In"), 'workbench.action.zoomIn');
		const zoomOut = this.createMenuItem(nls.localize({ key: 'miZoomOut', comment: ['&& denotes a mnemonic'] }, "Zoom O&&ut"), 'workbench.action.zoomOut');
		const resetZoom = this.createMenuItem(nls.localize({ key: 'miZoomReset', comment: ['&& denotes a mnemonic'] }, "&&Reset Zoom"), 'workbench.action.zoomReset');

		arrays.coalesce([
			commands,
			__separator__(),
			explorer,
			search,
			git,
			debug,
			extensions,
			__separator__(),
			output,
			problems,
			debugConsole,
			integratedTerminal,
			__separator__(),
			fullscreen,
			platform.isWindows || platform.isLinux ? toggleMenuBar : void 0,
			__separator__(),
			splitEditor,
			toggleEditorLayout,
			moveSidebar,
			toggleSidebar,
			togglePanel,
			toggleStatusbar,
			__separator__(),
			toggleWordWrap,
			toggleRenderWhitespace,
			toggleRenderControlCharacters,
			__separator__(),
			zoomIn,
			zoomOut,
			resetZoom
		]).forEach(item => viewMenu.append(item));
	}

	private setGotoMenu(gotoMenu: Electron.Menu): void {
		const back = this.createMenuItem(nls.localize({ key: 'miBack', comment: ['&& denotes a mnemonic'] }, "&&Back"), 'workbench.action.navigateBack');
		const forward = this.createMenuItem(nls.localize({ key: 'miForward', comment: ['&& denotes a mnemonic'] }, "&&Forward"), 'workbench.action.navigateForward');

		const switchEditorMenu = new Menu();

		const nextEditor = this.createMenuItem(nls.localize({ key: 'miNextEditor', comment: ['&& denotes a mnemonic'] }, "&&Next Editor"), 'workbench.action.nextEditor');
		const previousEditor = this.createMenuItem(nls.localize({ key: 'miPreviousEditor', comment: ['&& denotes a mnemonic'] }, "&&Previous Editor"), 'workbench.action.previousEditor');
		const nextEditorInGroup = this.createMenuItem(nls.localize({ key: 'miNextEditorInGroup', comment: ['&& denotes a mnemonic'] }, "&&Next Used Editor in Group"), 'workbench.action.openNextRecentlyUsedEditorInGroup');
		const previousEditorInGroup = this.createMenuItem(nls.localize({ key: 'miPreviousEditorInGroup', comment: ['&& denotes a mnemonic'] }, "&&Previous Used Editor in Group"), 'workbench.action.openPreviousRecentlyUsedEditorInGroup');

		[
			nextEditor,
			previousEditor,
			__separator__(),
			nextEditorInGroup,
			previousEditorInGroup
		].forEach(item => switchEditorMenu.append(item));

		const switchEditor = new MenuItem({ label: mnemonicLabel(nls.localize({ key: 'miSwitchEditor', comment: ['&& denotes a mnemonic'] }, "Switch &&Editor")), submenu: switchEditorMenu, enabled: true });

		const switchGroupMenu = new Menu();

		const focusFirstGroup = this.createMenuItem(nls.localize({ key: 'miFocusFirstGroup', comment: ['&& denotes a mnemonic'] }, "&&First Group"), 'workbench.action.focusFirstEditorGroup');
		const focusSecondGroup = this.createMenuItem(nls.localize({ key: 'miFocusSecondGroup', comment: ['&& denotes a mnemonic'] }, "&&Second Group"), 'workbench.action.focusSecondEditorGroup');
		const focusThirdGroup = this.createMenuItem(nls.localize({ key: 'miFocusThirdGroup', comment: ['&& denotes a mnemonic'] }, "&&Third Group"), 'workbench.action.focusThirdEditorGroup');
		const nextGroup = this.createMenuItem(nls.localize({ key: 'miNextGroup', comment: ['&& denotes a mnemonic'] }, "&&Next Group"), 'workbench.action.focusNextGroup');
		const previousGroup = this.createMenuItem(nls.localize({ key: 'miPreviousGroup', comment: ['&& denotes a mnemonic'] }, "&&Previous Group"), 'workbench.action.focusPreviousGroup');

		[
			focusFirstGroup,
			focusSecondGroup,
			focusThirdGroup,
			__separator__(),
			nextGroup,
			previousGroup
		].forEach(item => switchGroupMenu.append(item));

		const switchGroup = new MenuItem({ label: mnemonicLabel(nls.localize({ key: 'miSwitchGroup', comment: ['&& denotes a mnemonic'] }, "Switch &&Group")), submenu: switchGroupMenu, enabled: true });

		const gotoFile = this.createMenuItem(nls.localize({ key: 'miGotoFile', comment: ['&& denotes a mnemonic'] }, "Go to &&File..."), 'workbench.action.quickOpen');
		const gotoSymbolInFile = this.createMenuItem(nls.localize({ key: 'miGotoSymbolInFile', comment: ['&& denotes a mnemonic'] }, "Go to &&Symbol in File..."), 'workbench.action.gotoSymbol');
		const gotoSymbolInWorkspace = this.createMenuItem(nls.localize({ key: 'miGotoSymbolInWorkspace', comment: ['&& denotes a mnemonic'] }, "Go to Symbol in &&Workspace..."), 'workbench.action.showAllSymbols');
		const gotoDefinition = this.createMenuItem(nls.localize({ key: 'miGotoDefinition', comment: ['&& denotes a mnemonic'] }, "Go to &&Definition"), 'editor.action.goToDeclaration');
		const gotoLine = this.createMenuItem(nls.localize({ key: 'miGotoLine', comment: ['&& denotes a mnemonic'] }, "Go to &&Line..."), 'workbench.action.gotoLine');

		[
			back,
			forward,
			__separator__(),
			switchEditor,
			switchGroup,
			__separator__(),
			gotoFile,
			gotoSymbolInFile,
			gotoSymbolInWorkspace,
			gotoDefinition,
			gotoLine
		].forEach(item => gotoMenu.append(item));
	}

	private setMacWindowMenu(macWindowMenu: Electron.Menu): void {
		const minimize = new MenuItem({ label: nls.localize('mMinimize', "Minimize"), role: 'minimize', accelerator: 'Command+M', enabled: this.windowsService.getWindowCount() > 0 });
		const close = new MenuItem({ label: nls.localize('mClose', "Close"), role: 'close', accelerator: 'Command+W', enabled: this.windowsService.getWindowCount() > 0 });
		const bringAllToFront = new MenuItem({ label: nls.localize('mBringToFront', "Bring All to Front"), role: 'front', enabled: this.windowsService.getWindowCount() > 0 });

		[
			minimize,
			close,
			__separator__(),
			bringAllToFront
		].forEach(item => macWindowMenu.append(item));
	}

	private toggleDevTools(): void {
		const w = this.windowsService.getFocusedWindow();
		if (w && w.win) {
			w.win.webContents.toggleDevTools();
		}
	}

	private setHelpMenu(helpMenu: Electron.Menu): void {
		const toggleDevToolsItem = new MenuItem({
			label: mnemonicLabel(nls.localize({ key: 'miToggleDevTools', comment: ['&& denotes a mnemonic'] }, "&&Toggle Developer Tools")),
			accelerator: this.getAccelerator('workbench.action.toggleDevTools'),
			click: () => this.toggleDevTools(),
			enabled: (this.windowsService.getWindowCount() > 0)
		});

		const showAccessibilityOptions = new MenuItem({
			label: mnemonicLabel(nls.localize({ key: 'miAccessibilityOptions', comment: ['&& denotes a mnemonic'] }, "Accessibility &&Options")),
			accelerator: null,
			click: () => {
				this.windowsService.openAccessibilityOptions();
			}
		});

		let reportIssuesItem: Electron.MenuItem = null;
		if (product.reportIssueUrl) {
			const label = nls.localize({ key: 'miReportIssues', comment: ['&& denotes a mnemonic'] }, "Report &&Issues");

			if (this.windowsService.getWindowCount() > 0) {
				reportIssuesItem = this.createMenuItem(label, 'workbench.action.reportIssues');
			} else {
				reportIssuesItem = new MenuItem({ label: mnemonicLabel(label), click: () => this.openUrl(product.reportIssueUrl, 'openReportIssues') });
			}
		}

		const keyboardShortcutsUrl = platform.isLinux ? product.keyboardShortcutsUrlLinux : platform.isMacintosh ? product.keyboardShortcutsUrlMac : product.keyboardShortcutsUrlWin;
		arrays.coalesce([
			product.documentationUrl ? new MenuItem({ label: mnemonicLabel(nls.localize({ key: 'miDocumentation', comment: ['&& denotes a mnemonic'] }, "&&Documentation")), click: () => this.openUrl(product.documentationUrl, 'openDocumentationUrl') }) : null,
			product.releaseNotesUrl ? new MenuItem({ label: mnemonicLabel(nls.localize({ key: 'miReleaseNotes', comment: ['&& denotes a mnemonic'] }, "&&Release Notes")), click: () => this.windowsService.sendToFocused('vscode:runAction', 'update.showCurrentReleaseNotes') }) : null,
			(product.documentationUrl || product.releaseNotesUrl) ? __separator__() : null,
			keyboardShortcutsUrl ? new MenuItem({ label: mnemonicLabel(nls.localize({ key: 'miKeyboardShortcuts', comment: ['&& denotes a mnemonic'] }, "&&Keyboard Shortcuts Reference")), click: () => this.openUrl(keyboardShortcutsUrl, 'openKeyboardShortcutsUrl') }) : null,
			product.introductoryVideosUrl ? new MenuItem({ label: mnemonicLabel(nls.localize({ key: 'miIntroductoryVideos', comment: ['&& denotes a mnemonic'] }, "Introductory &&Videos")), click: () => this.openUrl(product.introductoryVideosUrl, 'openIntroductoryVideosUrl') }) : null,
			(product.introductoryVideosUrl || keyboardShortcutsUrl) ? __separator__() : null,
			product.twitterUrl ? new MenuItem({ label: mnemonicLabel(nls.localize({ key: 'miTwitter', comment: ['&& denotes a mnemonic'] }, "&&Join us on Twitter")), click: () => this.openUrl(product.twitterUrl, 'openTwitterUrl') }) : null,
			product.requestFeatureUrl ? new MenuItem({ label: mnemonicLabel(nls.localize({ key: 'miUserVoice', comment: ['&& denotes a mnemonic'] }, "&&Search Feature Requests")), click: () => this.openUrl(product.requestFeatureUrl, 'openUserVoiceUrl') }) : null,
			reportIssuesItem,
			(product.twitterUrl || product.requestFeatureUrl || product.reportIssueUrl) ? __separator__() : null,
			product.licenseUrl ? new MenuItem({
				label: mnemonicLabel(nls.localize({ key: 'miLicense', comment: ['&& denotes a mnemonic'] }, "View &&License")), click: () => {
					if (platform.language) {
						const queryArgChar = product.licenseUrl.indexOf('?') > 0 ? '&' : '?';
						this.openUrl(`${product.licenseUrl}${queryArgChar}lang=${platform.language}`, 'openLicenseUrl');
					} else {
						this.openUrl(product.licenseUrl, 'openLicenseUrl');
					}
				}
			}) : null,
			product.privacyStatementUrl ? new MenuItem({
				label: mnemonicLabel(nls.localize({ key: 'miPrivacyStatement', comment: ['&& denotes a mnemonic'] }, "&&Privacy Statement")), click: () => {
					if (platform.language) {
						const queryArgChar = product.licenseUrl.indexOf('?') > 0 ? '&' : '?';
						this.openUrl(`${product.privacyStatementUrl}${queryArgChar}lang=${platform.language}`, 'openPrivacyStatement');
					} else {
						this.openUrl(product.privacyStatementUrl, 'openPrivacyStatement');
					}
				}
			}) : null,
			(product.licenseUrl || product.privacyStatementUrl) ? __separator__() : null,
			toggleDevToolsItem,
			platform.isWindows && product.quality !== 'stable' ? showAccessibilityOptions : null
		]).forEach(item => helpMenu.append(item));

		if (!platform.isMacintosh) {
			const updateMenuItems = this.getUpdateMenuItems();
			if (updateMenuItems.length) {
				helpMenu.append(__separator__());
				updateMenuItems.forEach(i => helpMenu.append(i));
			}

			helpMenu.append(__separator__());
			helpMenu.append(new MenuItem({ label: mnemonicLabel(nls.localize({ key: 'miAbout', comment: ['&& denotes a mnemonic'] }, "&&About")), click: () => this.openAboutDialog() }));
		}
	}

	private getUpdateMenuItems(): Electron.MenuItem[] {
		switch (this.updateService.state) {
			case UpdateState.Uninitialized:
				return [];

			case UpdateState.UpdateDownloaded:
				const update = this.updateService.availableUpdate;
				return [new MenuItem({
					label: nls.localize('miRestartToUpdate', "Restart To Update..."), click: () => {
						this.reportMenuActionTelemetry('RestartToUpdate');
						update.quitAndUpdate();
					}
				})];

			case UpdateState.CheckingForUpdate:
				return [new MenuItem({ label: nls.localize('miCheckingForUpdates', "Checking For Updates..."), enabled: false })];

			case UpdateState.UpdateAvailable:
				if (platform.isLinux) {
					const update = this.updateService.availableUpdate;
					return [new MenuItem({
						label: nls.localize('miDownloadUpdate', "Download Available Update"), click: () => {
							update.quitAndUpdate();
						}
					})];
				}

				const updateAvailableLabel = platform.isWindows
					? nls.localize('miDownloadingUpdate', "Downloading Update...")
					: nls.localize('miInstallingUpdate', "Installing Update...");

				return [new MenuItem({ label: updateAvailableLabel, enabled: false })];

			default:
				const result = [new MenuItem({
					label: nls.localize('miCheckForUpdates', "Check For Updates..."), click: () => setTimeout(() => {
						this.reportMenuActionTelemetry('CheckForUpdate');
						this.updateService.checkForUpdates(true);
					}, 0)
				})];

				return result;
		}
	}

	private createMenuItem(label: string, actionId: string, enabled?: boolean, checked?: boolean): Electron.MenuItem;
	private createMenuItem(label: string, click: () => void, enabled?: boolean, checked?: boolean): Electron.MenuItem;
	private createMenuItem(arg1: string, arg2: any, arg3?: boolean, arg4?: boolean): Electron.MenuItem {
		const label = mnemonicLabel(arg1);
		const click: () => void = (typeof arg2 === 'function') ? arg2 : () => this.windowsService.sendToFocused('vscode:runAction', arg2);
		const enabled = typeof arg3 === 'boolean' ? arg3 : this.windowsService.getWindowCount() > 0;
		const checked = typeof arg4 === 'boolean' ? arg4 : false;

		let actionId: string;
		if (typeof arg2 === 'string') {
			actionId = arg2;
		}

		const options: Electron.MenuItemOptions = {
			label,
			accelerator: this.getAccelerator(actionId),
			click,
			enabled
		};

		if (checked) {
			options['type'] = 'checkbox';
			options['checked'] = checked;
		}

		return new MenuItem(options);
	}

	private createDevToolsAwareMenuItem(label: string, actionId: string, devToolsFocusedFn: (contents: Electron.WebContents) => void): Electron.MenuItem {
		return new MenuItem({
			label: mnemonicLabel(label),
			accelerator: this.getAccelerator(actionId),
			enabled: this.windowsService.getWindowCount() > 0,
			click: () => {
				const windowInFocus = this.windowsService.getFocusedWindow();
				if (!windowInFocus) {
					return;
				}

				if (windowInFocus.win.webContents.isDevToolsFocused()) {
					devToolsFocusedFn(windowInFocus.win.webContents.devToolsWebContents);
				} else {
					this.windowsService.sendToFocused('vscode:runAction', actionId);
				}
			}
		});
	}

	private getAccelerator(actionId: string): string {
		if (actionId) {
			const resolvedKeybinding = this.mapResolvedKeybindingToActionId[actionId];
			if (resolvedKeybinding) {
				return resolvedKeybinding; // keybinding is fully resolved
			}

			if (!this.keybindingsResolved) {
				this.actionIdKeybindingRequests.push(actionId); // keybinding needs to be resolved
			}

			const lastKnownKeybinding = this.mapLastKnownKeybindingToActionId[actionId];

			return lastKnownKeybinding; // return the last known keybining (chance of mismatch is very low unless it changed)
		}

		return void (0);
	}

	private openAboutDialog(): void {
		const lastActiveWindow = this.windowsService.getFocusedWindow() || this.windowsService.getLastActiveWindow();

		dialog.showMessageBox(lastActiveWindow && lastActiveWindow.win, {
			title: product.nameLong,
			type: 'info',
			message: product.nameLong,
			detail: nls.localize('aboutDetail',
				"\nVersion {0}\nCommit {1}\nDate {2}\nShell {3}\nRenderer {4}\nNode {5}",
				app.getVersion(),
				product.commit || 'Unknown',
				product.date || 'Unknown',
				process.versions['electron'],
				process.versions['chrome'],
				process.versions['node']
			),
			buttons: [nls.localize('okButton', "OK")],
			noLink: true
		}, result => null);

		this.reportMenuActionTelemetry('showAboutDialog');
	}

	private openUrl(url: string, id: string): void {
		shell.openExternal(url);
		this.reportMenuActionTelemetry(id);
	}

	private reportMenuActionTelemetry(id: string): void {
		this.windowsService.sendToFocused('vscode:telemetry', { eventName: 'workbenchActionExecuted', data: { id, from: 'menu' } });
	}
}

function __separator__(): Electron.MenuItem {
	return new MenuItem({ type: 'separator' });
}

function mnemonicLabel(label: string): string {
	if (platform.isMacintosh) {
		return label.replace(/\(&&\w\)|&&/g, ''); // no mnemonic support on mac
	}

	return label.replace(/&&/g, '&');
}

function unMnemonicLabel(label: string): string {
	if (platform.isMacintosh) {
		return label; // no mnemonic support on mac
	}

	return label.replace(/&/g, '&&');
}
