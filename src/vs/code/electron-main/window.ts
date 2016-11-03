/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as path from 'path';
import * as platform from 'vs/base/common/platform';
import * as objects from 'vs/base/common/objects';
import { IStorageService } from 'vs/code/electron-main/storage';
import { shell, screen, BrowserWindow } from 'electron';
import { TPromise, TValueCallback } from 'vs/base/common/winjs.base';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { ILogService } from 'vs/code/electron-main/log';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { parseArgs, ParsedArgs } from 'vs/platform/environment/node/argv';
import product from 'vs/platform/product';

export interface IWindowState {
	width?: number;
	height?: number;
	x?: number;
	y?: number;
	mode?: WindowMode;
}

export interface IWindowCreationOptions {
	state: IWindowState;
	extensionDevelopmentPath?: string;
	allowFullscreen?: boolean;
}

export enum WindowMode {
	Maximized,
	Normal,
	Minimized,
	Fullscreen
}

export const defaultWindowState = function (mode = WindowMode.Normal): IWindowState {
	return {
		width: 1024,
		height: 768,
		mode: mode
	};
};

export enum ReadyState {

	/**
	 * This window has not loaded any HTML yet
	 */
	NONE,

	/**
	 * This window is loading HTML
	 */
	LOADING,

	/**
	 * This window is navigating to another HTML
	 */
	NAVIGATING,

	/**
	 * This window is done loading HTML
	 */
	READY
}

export interface IPath {

	// the workspace spath for a VSCode instance which can be null
	workspacePath?: string;

	// the file path to open within a VSCode instance
	filePath?: string;

	// the line number in the file path to open
	lineNumber?: number;

	// the column number in the file path to open
	columnNumber?: number;

	// indicator to create the file path in the VSCode instance
	createFilePath?: boolean;
}

export interface IWindowConfiguration extends ParsedArgs {
	appRoot: string;
	execPath: string;

	userEnv: platform.IProcessEnvironment;

	zoomLevel?: number;

	workspacePath?: string;

	filesToOpen?: IPath[];
	filesToCreate?: IPath[];
	filesToDiff?: IPath[];
}

export interface IWindowSettings {
	openFilesInNewWindow: boolean;
	reopenFolders: 'all' | 'one' | 'none';
	restoreFullscreen: boolean;
	zoomLevel: number;
}

export class VSCodeWindow {

	public static menuBarHiddenKey = 'menuBarHidden';
	public static colorThemeStorageKey = 'theme';

	private static MIN_WIDTH = 200;
	private static MIN_HEIGHT = 120;

	private options: IWindowCreationOptions;
	private showTimeoutHandle: any;
	private _id: number;
	private _win: Electron.BrowserWindow;
	private _lastFocusTime: number;
	private _readyState: ReadyState;
	private _extensionDevelopmentPath: string;
	private windowState: IWindowState;
	private currentWindowMode: WindowMode;

	private whenReadyCallbacks: TValueCallback<VSCodeWindow>[];

	private currentConfig: IWindowConfiguration;
	private pendingLoadConfig: IWindowConfiguration;

	constructor(
		config: IWindowCreationOptions,
		@ILogService private logService: ILogService,
		@IEnvironmentService private environmentService: IEnvironmentService,
		@IConfigurationService private configurationService: IConfigurationService,
		@IStorageService private storageService: IStorageService
	) {
		this.options = config;
		this._lastFocusTime = -1;
		this._readyState = ReadyState.NONE;
		this._extensionDevelopmentPath = config.extensionDevelopmentPath;
		this.whenReadyCallbacks = [];

		// Load window state
		this.restoreWindowState(config.state);

		// For VS theme we can show directly because background is white
		const usesLightTheme = /vs($| )/.test(this.storageService.getItem<string>(VSCodeWindow.colorThemeStorageKey));
		if (!global.windowShow) {
			global.windowShow = Date.now();
		}

		// in case we are maximized or fullscreen, only show later after the call to maximize/fullscreen (see below)
		const isFullscreenOrMaximized = (this.currentWindowMode === WindowMode.Maximized || this.currentWindowMode === WindowMode.Fullscreen);

		const options: Electron.BrowserWindowOptions = {
			width: this.windowState.width,
			height: this.windowState.height,
			x: this.windowState.x,
			y: this.windowState.y,
			backgroundColor: usesLightTheme ? '#FFFFFF' : platform.isMacintosh ? '#171717' : '#1E1E1E', // https://github.com/electron/electron/issues/5150
			minWidth: VSCodeWindow.MIN_WIDTH,
			minHeight: VSCodeWindow.MIN_HEIGHT,
			show: !isFullscreenOrMaximized,
			title: product.nameLong,
			webPreferences: {
				'backgroundThrottling': false // by default if Code is in the background, intervals and timeouts get throttled
			}
		};

		if (platform.isLinux) {
			options.icon = path.join(this.environmentService.appRoot, 'resources/linux/code.png'); // Windows and Mac are better off using the embedded icon(s)
		}

		// Create the browser window.
		this._win = new BrowserWindow(options);
		this._id = this._win.id;

		if (isFullscreenOrMaximized) {
			this.win.maximize();

			if (this.currentWindowMode === WindowMode.Fullscreen) {
				this.win.setFullScreen(true);
			}

			if (!this.win.isVisible()) {
				this.win.show(); // to reduce flicker from the default window size to maximize, we only show after maximize
			}
		}

		this._lastFocusTime = Date.now(); // since we show directly, we need to set the last focus time too

		if (this.storageService.getItem<boolean>(VSCodeWindow.menuBarHiddenKey, false)) {
			this.setMenuBarVisibility(false); // respect configured menu bar visibility
		}

		this.registerListeners();
	}

	public get isPluginDevelopmentHost(): boolean {
		return !!this._extensionDevelopmentPath;
	}

	public get extensionDevelopmentPath(): string {
		return this._extensionDevelopmentPath;
	}

	public get config(): IWindowConfiguration {
		return this.currentConfig;
	}

	public get id(): number {
		return this._id;
	}

	public get win(): Electron.BrowserWindow {
		return this._win;
	}

	public focus(): void {
		if (!this._win) {
			return;
		}

		if (this._win.isMinimized()) {
			this._win.restore();
		}

		this._win.focus();
	}

	public get lastFocusTime(): number {
		return this._lastFocusTime;
	}

	public get openedWorkspacePath(): string {
		return this.currentConfig.workspacePath;
	}

	public get openedFilePath(): string {
		return this.currentConfig.filesToOpen && this.currentConfig.filesToOpen[0] && this.currentConfig.filesToOpen[0].filePath;
	}

	public setReady(): void {
		this._readyState = ReadyState.READY;

		// inform all waiting promises that we are ready now
		while (this.whenReadyCallbacks.length) {
			this.whenReadyCallbacks.pop()(this);
		}
	}

	public ready(): TPromise<VSCodeWindow> {
		return new TPromise<VSCodeWindow>((c) => {
			if (this._readyState === ReadyState.READY) {
				return c(this);
			}

			// otherwise keep and call later when we are ready
			this.whenReadyCallbacks.push(c);
		});
	}

	public get readyState(): ReadyState {
		return this._readyState;
	}

	private registerListeners(): void {

		// Remember that we loaded
		this._win.webContents.on('did-finish-load', () => {
			this._readyState = ReadyState.LOADING;

			// Associate properties from the load request if provided
			if (this.pendingLoadConfig) {
				this.currentConfig = this.pendingLoadConfig;

				this.pendingLoadConfig = null;
			}

			// To prevent flashing, we set the window visible after the page has finished to load but before VSCode is loaded
			if (!this.win.isVisible()) {
				if (!global.windowShow) {
					global.windowShow = Date.now();
				}

				if (this.currentWindowMode === WindowMode.Maximized) {
					this.win.maximize();
				}

				if (!this.win.isVisible()) { // maximize also makes visible
					this.win.show();
				}
			}
		});

		// App commands support
		this._win.on('app-command', (e, cmd) => {
			if (this.readyState !== ReadyState.READY) {
				return; // window must be ready
			}

			// Support navigation via mouse buttons 4/5
			if (cmd === 'browser-backward') {
				this.send('vscode:runAction', 'workbench.action.navigateBack');
			} else if (cmd === 'browser-forward') {
				this.send('vscode:runAction', 'workbench.action.navigateForward');
			}
		});

		// Handle code that wants to open links
		this._win.webContents.on('new-window', (event: Event, url: string) => {
			event.preventDefault();

			shell.openExternal(url);
		});

		// Window Focus
		this._win.on('focus', () => {
			this._lastFocusTime = Date.now();
		});

		// Window Fullscreen
		this._win.on('enter-full-screen', () => {
			this.sendWhenReady('vscode:enterFullScreen');
		});

		this._win.on('leave-full-screen', () => {
			this.sendWhenReady('vscode:leaveFullScreen');
		});

		// Window Failed to load
		this._win.webContents.on('did-fail-load', (event: Event, errorCode: string, errorDescription: string) => {
			console.warn('[electron event]: fail to load, ', errorDescription);
		});

		// Prevent any kind of navigation triggered by the user!
		// But do not touch this in dev version because it will prevent "Reload" from dev tools
		if (this.environmentService.isBuilt) {
			this._win.webContents.on('will-navigate', (event: Event) => {
				if (event) {
					event.preventDefault();
				}
			});
		}
	}

	public load(config: IWindowConfiguration): void {

		// If this is the first time the window is loaded, we associate the paths
		// directly with the window because we assume the loading will just work
		if (this.readyState === ReadyState.NONE) {
			this.currentConfig = config;
		}

		// Otherwise, the window is currently showing a folder and if there is an
		// unload handler preventing the load, we cannot just associate the paths
		// because the loading might be vetoed. Instead we associate it later when
		// the window load event has fired.
		else {
			this.pendingLoadConfig = config;
			this._readyState = ReadyState.NAVIGATING;
		}

		// Make sure to clear any previous edited state
		if (platform.isMacintosh && this._win.isDocumentEdited()) {
			this._win.setDocumentEdited(false);
		}

		// Load URL
		this._win.loadURL(this.getUrl(config));

		// Make window visible if it did not open in N seconds because this indicates an error
		if (!this.environmentService.isBuilt) {
			this.showTimeoutHandle = setTimeout(() => {
				if (this._win && !this._win.isVisible() && !this._win.isMinimized()) {
					this._win.show();
					this._win.focus();
					this._win.webContents.openDevTools();
				}
			}, 10000);
		}
	}

	public reload(cli?: ParsedArgs): void {

		// Inherit current properties but overwrite some
		const configuration: IWindowConfiguration = objects.mixin({}, this.currentConfig);
		delete configuration.filesToOpen;
		delete configuration.filesToCreate;
		delete configuration.filesToDiff;

		// Some configuration things get inherited if the window is being reloaded and we are
		// in plugin development mode. These options are all development related.
		if (this.isPluginDevelopmentHost && cli) {
			configuration.verbose = cli.verbose;
			configuration.debugPluginHost = cli.debugPluginHost;
			configuration.debugBrkPluginHost = cli.debugBrkPluginHost;
			configuration['extensions-dir'] = cli['extensions-dir'];
		}

		// Load config
		this.load(configuration);
	}

	private getUrl(windowConfiguration: IWindowConfiguration): string {
		let url = require.toUrl('vs/workbench/electron-browser/bootstrap/index.html');

		// Set zoomlevel
		const windowConfig = this.configurationService.getConfiguration<IWindowSettings>('window');
		const zoomLevel = windowConfig && windowConfig.zoomLevel;
		if (typeof zoomLevel === 'number') {
			windowConfiguration.zoomLevel = zoomLevel;
		}

		// Config (combination of process.argv and window configuration)
		const environment = parseArgs(process.argv);
		const config = objects.assign(environment, windowConfiguration);
		for (let key in config) {
			if (!config[key]) {
				delete config[key]; // only send over properties that have a true value
			}
		}

		url += '?config=' + encodeURIComponent(JSON.stringify(config));

		return url;
	}

	public serializeWindowState(): IWindowState {
		if (this.win.isFullScreen()) {
			return {
				mode: WindowMode.Fullscreen,
				// still carry over window dimensions from previous sessions!
				width: this.windowState.width,
				height: this.windowState.height,
				x: this.windowState.x,
				y: this.windowState.y
			};
		}

		const state: IWindowState = Object.create(null);
		let mode: WindowMode;

		// get window mode
		if (!platform.isMacintosh && this.win.isMaximized()) {
			mode = WindowMode.Maximized;
		} else if (this.win.isMinimized()) {
			mode = WindowMode.Minimized;
		} else {
			mode = WindowMode.Normal;
		}

		// we don't want to save minimized state, only maximized or normal
		if (mode === WindowMode.Maximized) {
			state.mode = WindowMode.Maximized;
		} else if (mode !== WindowMode.Minimized) {
			state.mode = WindowMode.Normal;
		}

		// only consider non-minimized window states
		if (mode === WindowMode.Normal || mode === WindowMode.Maximized) {
			const pos = this.win.getPosition();
			const size = this.win.getSize();

			state.x = pos[0];
			state.y = pos[1];
			state.width = size[0];
			state.height = size[1];
		}

		return state;
	}

	private restoreWindowState(state?: IWindowState): void {
		if (state) {
			try {
				state = this.validateWindowState(state);
			} catch (err) {
				this.logService.log(`Unexpected error validating window state: ${err}\n${err.stack}`); // somehow display API can be picky about the state to validate
			}
		}

		if (!state) {
			state = defaultWindowState();
		}

		this.windowState = state;
		this.currentWindowMode = this.windowState.mode;
	}

	private validateWindowState(state: IWindowState): IWindowState {
		if (!state) {
			return null;
		}

		if (state.mode === WindowMode.Fullscreen) {
			if (this.options.allowFullscreen) {
				return state;
			}

			state.mode = WindowMode.Normal; // if we do not allow fullscreen, treat this state as normal window state
		}

		if ([state.x, state.y, state.width, state.height].some(n => typeof n !== 'number')) {
			return null;
		}

		if (state.width <= 0 || state.height <= 0) {
			return null;
		}

		const displays = screen.getAllDisplays();

		// Single Monitor: be strict about x/y positioning
		if (displays.length === 1) {
			const displayBounds = displays[0].bounds;

			// Careful with maximized: in that mode x/y can well be negative!
			if (state.mode !== WindowMode.Maximized && displayBounds.width > 0 && displayBounds.height > 0 /* Linux X11 sessions sometimes report wrong display bounds */) {
				if (state.x < displayBounds.x) {
					state.x = displayBounds.x; // prevent window from falling out of the screen to the left
				}

				if (state.y < displayBounds.y) {
					state.y = displayBounds.y; // prevent window from falling out of the screen to the top
				}

				if (state.x > (displayBounds.x + displayBounds.width)) {
					state.x = displayBounds.x; // prevent window from falling out of the screen to the right
				}

				if (state.y > (displayBounds.y + displayBounds.height)) {
					state.y = displayBounds.y; // prevent window from falling out of the screen to the bottom
				}

				if (state.width > displayBounds.width) {
					state.width = displayBounds.width; // prevent window from exceeding display bounds width
				}

				if (state.height > displayBounds.height) {
					state.height = displayBounds.height; // prevent window from exceeding display bounds height
				}
			}

			if (state.mode === WindowMode.Maximized) {
				return defaultWindowState(WindowMode.Maximized); // when maximized, make sure we have good values when the user restores the window
			}

			return state;
		}

		// Multi Monitor: be less strict because metrics can be crazy
		const bounds = { x: state.x, y: state.y, width: state.width, height: state.height };
		const display = screen.getDisplayMatching(bounds);
		if (display && display.bounds.x + display.bounds.width > bounds.x && display.bounds.y + display.bounds.height > bounds.y) {
			if (state.mode === WindowMode.Maximized) {
				const defaults = defaultWindowState(WindowMode.Maximized); // when maximized, make sure we have good values when the user restores the window
				defaults.x = state.x; // carefull to keep x/y position so that the window ends up on the correct monitor
				defaults.y = state.y;

				return defaults;
			}

			return state;
		}

		return null;
	}

	public getBounds(): Electron.Rectangle {
		const pos = this.win.getPosition();
		const dimension = this.win.getSize();

		return { x: pos[0], y: pos[1], width: dimension[0], height: dimension[1] };
	}

	public toggleFullScreen(): void {
		const willBeFullScreen = !this.win.isFullScreen();

		this.win.setFullScreen(willBeFullScreen);

		// Windows & Linux: Hide the menu bar but still allow to bring it up by pressing the Alt key
		if (platform.isWindows || platform.isLinux) {
			if (willBeFullScreen) {
				this.setMenuBarVisibility(false);
			} else {
				this.setMenuBarVisibility(!this.storageService.getItem<boolean>(VSCodeWindow.menuBarHiddenKey, false)); // restore as configured
			}
		}
	}

	public setMenuBarVisibility(visible: boolean): void {
		this.win.setMenuBarVisibility(visible);
		this.win.setAutoHideMenuBar(!visible);
	}

	public sendWhenReady(channel: string, ...args: any[]): void {
		this.ready().then(() => {
			this.send(channel, ...args);
		});
	}

	public send(channel: string, ...args: any[]): void {
		this._win.webContents.send(channel, ...args);
	}

	public dispose(): void {
		if (this.showTimeoutHandle) {
			clearTimeout(this.showTimeoutHandle);
		}

		this._win = null; // Important to dereference the window object to allow for GC
	}
}