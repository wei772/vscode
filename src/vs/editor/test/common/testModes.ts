/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { LanguageConfigurationRegistry } from 'vs/editor/common/modes/languageConfigurationRegistry';
import { CommentRule } from 'vs/editor/common/modes/languageConfiguration';
import { MockMode } from 'vs/editor/test/common/mocks/mockMode';

export class CommentMode extends MockMode {
	constructor(commentsConfig: CommentRule) {
		super();
		LanguageConfigurationRegistry.register(this.getId(), {
			comments: commentsConfig
		});
	}
}
