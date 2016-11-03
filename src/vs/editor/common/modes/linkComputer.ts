/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { ILink } from 'vs/editor/common/modes';
import { CharCode } from 'vs/base/common/charCode';
import { CharacterClassifier } from 'vs/editor/common/core/characterClassifier';

export interface ILinkComputerTarget {
	getLineCount(): number;
	getLineContent(lineNumber: number): string;
}

const enum State {
	Invalid = 0,
	Start = 1,
	H = 2,
	HT = 3,
	HTT = 4,
	HTTP = 5,
	F = 6,
	FI = 7,
	FIL = 8,
	BeforeColon = 9,
	AfterColon = 10,
	AlmostThere = 11,
	End = 12,
	Accept = 13
}

type Edge = [State, number, State];

class StateMachine {

	private _states: State[][];
	private _maxCharCode: number;

	constructor(edges: Edge[]) {
		let maxCharCode = 0;
		let maxState = State.Invalid;
		for (let i = 0, len = edges.length; i < len; i++) {
			let [from, chCode, to] = edges[i];
			if (chCode > maxCharCode) {
				maxCharCode = chCode;
			}
			if (from > maxState) {
				maxState = from;
			}
			if (to > maxState) {
				maxState = to;
			}
		}

		let states: number[][] = [];
		for (let i = 0; i <= maxState; i++) {
			let tmp: number[] = [];
			for (let j = 0; j <= maxCharCode; j++) {
				tmp[j] = State.Invalid;
			}
			states[i] = tmp;
		}

		for (let i = 0, len = edges.length; i < len; i++) {
			let [from, chCode, to] = edges[i];
			states[from][chCode] = to;
		}

		this._states = states;
		this._maxCharCode = maxCharCode;
	}

	public nextState(currentState: State, chCode: number): State {
		if (chCode < 0 || chCode > this._maxCharCode) {
			return State.Invalid;
		}
		return this._states[currentState][chCode];
	}
}

// State machine for http:// or https:// or file://
let stateMachine = new StateMachine([
	[State.Start, CharCode.h, State.H],
	[State.Start, CharCode.H, State.H],
	[State.Start, CharCode.f, State.F],
	[State.Start, CharCode.F, State.F],

	[State.H, CharCode.t, State.HT],
	[State.H, CharCode.T, State.HT],

	[State.HT, CharCode.t, State.HTT],
	[State.HT, CharCode.T, State.HTT],

	[State.HTT, CharCode.p, State.HTTP],
	[State.HTT, CharCode.P, State.HTTP],

	[State.HTTP, CharCode.s, State.BeforeColon],
	[State.HTTP, CharCode.S, State.BeforeColon],
	[State.HTTP, CharCode.Colon, State.AfterColon],

	[State.F, CharCode.i, State.FI],
	[State.F, CharCode.I, State.FI],

	[State.FI, CharCode.l, State.FIL],
	[State.FI, CharCode.L, State.FIL],

	[State.FIL, CharCode.e, State.BeforeColon],
	[State.FIL, CharCode.E, State.BeforeColon],

	[State.BeforeColon, CharCode.Colon, State.AfterColon],

	[State.AfterColon, CharCode.Slash, State.AlmostThere],

	[State.AlmostThere, CharCode.Slash, State.End],
]);

const enum CharacterClass {
	None = 0,
	ForceTermination = 1,
	CannotEndIn = 2
}

const classifier = (function () {
	let result = new CharacterClassifier(CharacterClass.None);

	const FORCE_TERMINATION_CHARACTERS = ' \t<>\'\"、。｡､，．：；？！＠＃＄％＆＊‘“〈《「『【〔（［｛｢｣｝］）〕】』」》〉”’｀～…';
	for (let i = 0; i < FORCE_TERMINATION_CHARACTERS.length; i++) {
		result.set(FORCE_TERMINATION_CHARACTERS.charCodeAt(i), CharacterClass.ForceTermination);
	}

	const CANNOT_END_WITH_CHARACTERS = '.,;';
	for (let i = 0; i < CANNOT_END_WITH_CHARACTERS.length; i++) {
		result.set(CANNOT_END_WITH_CHARACTERS.charCodeAt(i), CharacterClass.CannotEndIn);
	}

	return result;
})();

class LinkComputer {

	private static _createLink(line: string, lineNumber: number, linkBeginIndex: number, linkEndIndex: number): ILink {
		// Do not allow to end link in certain characters...
		let lastIncludedCharIndex = linkEndIndex - 1;
		do {
			const chCode = line.charCodeAt(lastIncludedCharIndex);
			const chClass = classifier.get(chCode);
			if (chClass !== CharacterClass.CannotEndIn) {
				break;
			}
			lastIncludedCharIndex--;
		} while (lastIncludedCharIndex > linkBeginIndex);

		return {
			range: {
				startLineNumber: lineNumber,
				startColumn: linkBeginIndex + 1,
				endLineNumber: lineNumber,
				endColumn: lastIncludedCharIndex + 2
			},
			url: line.substring(linkBeginIndex, lastIncludedCharIndex + 1)
		};
	}

	public static computeLinks(model: ILinkComputerTarget): ILink[] {
		let result: ILink[] = [];
		for (let i = 1, lineCount = model.getLineCount(); i <= lineCount; i++) {
			const line = model.getLineContent(i);
			const len = line.length;

			let j = 0;
			let linkBeginIndex = 0;
			let state = State.Start;
			let hasOpenParens = false;
			let hasOpenSquareBracket = false;
			let hasOpenCurlyBracket = false;

			while (j < len) {

				let resetStateMachine = false;
				const chCode = line.charCodeAt(j);

				if (state === State.Accept) {
					let chClass: CharacterClass;
					switch (chCode) {
						case CharCode.OpenParen:
							hasOpenParens = true;
							chClass = CharacterClass.None;
							break;
						case CharCode.CloseParen:
							chClass = (hasOpenParens ? CharacterClass.None : CharacterClass.ForceTermination);
							break;
						case CharCode.OpenSquareBracket:
							hasOpenSquareBracket = true;
							chClass = CharacterClass.None;
							break;
						case CharCode.CloseSquareBracket:
							chClass = (hasOpenSquareBracket ? CharacterClass.None : CharacterClass.ForceTermination);
							break;
						case CharCode.OpenCurlyBrace:
							hasOpenCurlyBracket = true;
							chClass = CharacterClass.None;
							break;
						case CharCode.CloseCurlyBrace:
							chClass = (hasOpenCurlyBracket ? CharacterClass.None : CharacterClass.ForceTermination);
							break;
						default:
							chClass = classifier.get(chCode);
					}

					// Check if character terminates link
					if (chClass === CharacterClass.ForceTermination) {
						result.push(LinkComputer._createLink(line, i, linkBeginIndex, j));
						resetStateMachine = true;
					}
				} else if (state === State.End) {
					const chClass = classifier.get(chCode);

					// Check if character terminates link
					if (chClass === CharacterClass.ForceTermination) {
						resetStateMachine = true;
					} else {
						state = State.Accept;
					}
				} else {
					state = stateMachine.nextState(state, chCode);
					if (state === State.Invalid) {
						resetStateMachine = true;
					}
				}

				if (resetStateMachine) {
					state = State.Start;
					hasOpenParens = false;
					hasOpenSquareBracket = false;
					hasOpenCurlyBracket = false;

					// Record where the link started
					linkBeginIndex = j + 1;
				}

				j++;
			}

			if (state === State.Accept) {
				result.push(LinkComputer._createLink(line, i, linkBeginIndex, len));
			}

		}

		return result;
	}
}

/**
 * Returns an array of all links contains in the provided
 * document. *Note* that this operation is computational
 * expensive and should not run in the UI thread.
 */
export function computeLinks(model: ILinkComputerTarget): ILink[] {
	if (!model || typeof model.getLineCount !== 'function' || typeof model.getLineContent !== 'function') {
		// Unknown caller!
		return [];
	}
	return LinkComputer.computeLinks(model);
}
