'use strict';

import { Position } from 'vscode';

export enum TokenKind {
    Identifier,
    Number,
    String,
    Punct,
    /** A whole preprocessor logical line (`#...`), continuations folded in. `value` is the raw text. */
    Preprocessor,
    EndOfFile,
}

export interface Token {
    kind: TokenKind;
    value: string;
    start: number; // absolute offset of first char
    end: number;   // absolute offset just past last char
}

function isIdentStart(ch: number): boolean {
    return ch === 0x5f /* _ */
        || (ch >= 0x41 && ch <= 0x5a) /* A-Z */
        || (ch >= 0x61 && ch <= 0x7a) /* a-z */
        || ch >= 0x80; /* non-ascii */
}

function isIdentPart(ch: number): boolean {
    return isIdentStart(ch) || (ch >= 0x30 && ch <= 0x39); /* 0-9 */
}

function isDigit(ch: number): boolean {
    return ch >= 0x30 && ch <= 0x39;
}

/**
 * Comment / string / preprocessor aware tokenizer.
 *
 * Comments are consumed but never emitted, so an identifier inside `// ...` or
 * `/* ... *\/` can never reach the parser — the key correctness win over regex.
 * Strings are emitted as a single String token. Preprocessor directives (a `#`
 * as the first non-whitespace on a line) are emitted as one Preprocessor token,
 * with backslash-newline continuations folded into it.
 */
export class Lexer {
    private src: string;
    private pos: number = 0;
    private len: number;
    public readonly lineStarts: number[];
    /** The source after BOM stripping; token offsets index into this. */
    public readonly source: string;

    constructor(source: string) {
        // Strip a leading UTF-8 BOM.
        if (source.charCodeAt(0) === 0xfeff) {
            source = source.slice(1);
        }
        this.src = source;
        this.source = source;
        this.len = source.length;
        this.lineStarts = computeLineStarts(source);
    }

    /** O(log n) mapping from absolute offset to a zero-based VS Code Position. */
    public offsetToPosition(offset: number): Position {
        const starts = this.lineStarts;
        let lo = 0, hi = starts.length - 1, line = 0;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (starts[mid] <= offset) {
                line = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return new Position(line, offset - starts[line]);
    }

    public tokenize(): Token[] {
        const tokens: Token[] = [];
        let atLineStart = true;

        while (this.pos < this.len) {
            const ch = this.src.charCodeAt(this.pos);

            // Whitespace
            if (ch === 0x20 || ch === 0x09 || ch === 0x0d) { this.pos++; continue; }
            if (ch === 0x0a) { this.pos++; atLineStart = true; continue; }

            // Comments
            if (ch === 0x2f /* / */ && this.pos + 1 < this.len) {
                const next = this.src.charCodeAt(this.pos + 1);
                if (next === 0x2f) { this.skipLineComment(); continue; }
                if (next === 0x2a) { this.skipBlockComment(); continue; }
            }

            // Preprocessor directive at line start
            if (ch === 0x23 /* # */ && atLineStart) {
                tokens.push(this.readPreprocessor());
                atLineStart = true;
                continue;
            }

            atLineStart = false;

            // String / char literal
            if (ch === 0x22 /* " */ || ch === 0x27 /* ' */) {
                tokens.push(this.readString(ch));
                continue;
            }

            // Identifier / keyword
            if (isIdentStart(ch)) {
                tokens.push(this.readIdentifier());
                continue;
            }

            // Number
            if (isDigit(ch) || (ch === 0x2e /* . */ && isDigit(this.src.charCodeAt(this.pos + 1)))) {
                tokens.push(this.readNumber());
                continue;
            }

            // Punctuation (multi-char where relevant)
            tokens.push(this.readPunct());
        }

        tokens.push({ kind: TokenKind.EndOfFile, value: '', start: this.len, end: this.len });
        return tokens;
    }

    private skipLineComment(): void {
        this.pos += 2;
        while (this.pos < this.len && this.src.charCodeAt(this.pos) !== 0x0a) {
            this.pos++;
        }
    }

    private skipBlockComment(): void {
        this.pos += 2;
        while (this.pos < this.len) {
            if (this.src.charCodeAt(this.pos) === 0x2a && this.src.charCodeAt(this.pos + 1) === 0x2f) {
                this.pos += 2;
                return;
            }
            this.pos++;
        }
    }

    private readPreprocessor(): Token {
        const start = this.pos;
        while (this.pos < this.len) {
            const ch = this.src.charCodeAt(this.pos);
            if (ch === 0x0a) {
                break;
            }
            // Backslash-newline continuation folds the next physical line in.
            if (ch === 0x5c /* \ */) {
                const n1 = this.src.charCodeAt(this.pos + 1);
                if (n1 === 0x0a) { this.pos += 2; continue; }
                if (n1 === 0x0d && this.src.charCodeAt(this.pos + 2) === 0x0a) { this.pos += 3; continue; }
            }
            // A comment inside a preprocessor line ends the directive's meaning;
            // simplest correct behaviour is to stop at it.
            if (ch === 0x2f && (this.src.charCodeAt(this.pos + 1) === 0x2f || this.src.charCodeAt(this.pos + 1) === 0x2a)) {
                break;
            }
            this.pos++;
        }
        return { kind: TokenKind.Preprocessor, value: this.src.slice(start, this.pos), start, end: this.pos };
    }

    private readString(quote: number): Token {
        const start = this.pos;
        this.pos++; // opening quote
        while (this.pos < this.len) {
            const ch = this.src.charCodeAt(this.pos);
            if (ch === 0x5c /* \ */) { this.pos += 2; continue; }
            if (ch === quote) { this.pos++; break; }
            if (ch === 0x0a) { break; } // unterminated
            this.pos++;
        }
        return { kind: TokenKind.String, value: this.src.slice(start, this.pos), start, end: this.pos };
    }

    private readIdentifier(): Token {
        const start = this.pos;
        this.pos++;
        while (this.pos < this.len && isIdentPart(this.src.charCodeAt(this.pos))) {
            this.pos++;
        }
        return { kind: TokenKind.Identifier, value: this.src.slice(start, this.pos), start, end: this.pos };
    }

    private readNumber(): Token {
        const start = this.pos;
        // Consume a permissive numeric run (digits, ., x, hex, exponent, suffixes).
        while (this.pos < this.len) {
            const ch = this.src.charCodeAt(this.pos);
            if (isIdentPart(ch) || ch === 0x2e /* . */) {
                this.pos++;
            } else if ((ch === 0x2b || ch === 0x2d) /* + - */ ) {
                // exponent sign, e.g. 1e-3
                const prev = this.src.charCodeAt(this.pos - 1);
                if (prev === 0x65 || prev === 0x45) { this.pos++; } else { break; }
            } else {
                break;
            }
        }
        return { kind: TokenKind.Number, value: this.src.slice(start, this.pos), start, end: this.pos };
    }

    private readPunct(): Token {
        const start = this.pos;
        const two = this.src.substr(this.pos, 2);
        const three = this.src.substr(this.pos, 3);
        const MULTI3 = ['<<=', '>>=', '...'];
        const MULTI2 = ['::', '->', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||',
            '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^='];
        if (MULTI3.indexOf(three) >= 0) { this.pos += 3; }
        else if (MULTI2.indexOf(two) >= 0) { this.pos += 2; }
        else { this.pos += 1; }
        return { kind: TokenKind.Punct, value: this.src.slice(start, this.pos), start, end: this.pos };
    }
}

/** Free-standing offset -> Position using a precomputed lineStarts table. */
export function offsetToPosition(lineStarts: number[], offset: number): Position {
    let lo = 0, hi = lineStarts.length - 1, line = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (lineStarts[mid] <= offset) { line = mid; lo = mid + 1; }
        else { hi = mid - 1; }
    }
    return new Position(line, offset - lineStarts[line]);
}

function computeLineStarts(source: string): number[] {
    const starts = [0];
    for (let i = 0; i < source.length; i++) {
        if (source.charCodeAt(i) === 0x0a) {
            starts.push(i + 1);
        }
    }
    return starts;
}
