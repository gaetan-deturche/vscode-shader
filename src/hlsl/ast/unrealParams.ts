'use strict';

/**
 * Lightweight scanner for Unreal Engine shader-parameter / uniform-buffer
 * structs declared in C++ (`.h`/`.cpp`/`.inl`). These generate the uniform
 * buffers that HLSL shaders reference, so indexing them lets go-to-definition /
 * find-references on a uniform member jump to the C++ source.
 *
 * Recognised member macros (all-caps, anywhere a member can appear):
 *   SHADER_PARAMETER*        e.g. SHADER_PARAMETER(float, Foo), SHADER_PARAMETER_TEXTURE(...)
 *   UNIFORM_MEMBER*          legacy uniform buffer members
 *   *UNIFORM_BUFFER_MEMBER*  e.g. VIEW_UNIFORM_BUFFER_MEMBER_PER_VIEW(FVector4f, InvDeviceZToWorldZTransform)
 *
 * The UE View uniform buffer lists its members inside an *object-like* macro
 * table (`#define VIEW_UNIFORM_BUFFER_MEMBER_TABLE \ ...`), while the member
 * macros themselves are *function-like* `#define`s with placeholder args. We
 * scan the whole file but skip function-like #define regions, so placeholder
 * `(type, identifier)` args never leak in as bogus members.
 */

export interface UniformMember {
    name: string;
    type: string;       // best-effort declared type (for hover/completion detail)
    nameOffset: number; // absolute offset of the member name in the source
}

export interface UniformStruct {
    name: string;
    nameOffset: number;
    members: UniformMember[];
}

export interface UniformScan {
    /** Members declared inside a BEGIN_*_STRUCT(...) ... END block. */
    structs: UniformStruct[];
    /** Members declared outside any struct block (e.g. UE's View member table). */
    looseMembers: UniformMember[];
}

const BEGIN_RE = /\bBEGIN_[A-Z0-9_]*?(?:SHADER_PARAMETER|UNIFORM_BUFFER)_STRUCT[A-Z0-9_]*\s*\(/g;
const END_RE = /\bEND_[A-Z0-9_]*?(?:SHADER_PARAMETER|UNIFORM_BUFFER)_STRUCT[A-Z0-9_]*\s*\(/g;
// All-caps macro-style identifiers immediately followed by `(`.
const MACRO_CALL_RE = /\b([A-Z][A-Z0-9_]*)\s*\(/g;
const MEMBER_STEM_RE = /SHADER_PARAMETER|UNIFORM_MEMBER|UNIFORM_BUFFER_MEMBER/;
const IDENT_RE = /^[A-Za-z_]\w*$/;

interface Block { name: string; nameOffset: number; start: number; end: number; }

export function parseUniformBuffers(rawSource: string): UniformScan {
    // Blank comments and string literals (preserving offsets) so macro text
    // inside them is never matched.
    const src = blankCommentsAndStrings(rawSource);

    const blocks = findBlocks(src);
    const fnDefineRanges = functionLikeDefineRanges(src);

    const structs: UniformStruct[] = blocks.map(b => ({ name: b.name, nameOffset: b.nameOffset, members: [] }));
    const looseMembers: UniformMember[] = [];

    MACRO_CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MACRO_CALL_RE.exec(src))) {
        const macro = m[1];
        if (/^(?:BEGIN|END)_/.test(macro) || !MEMBER_STEM_RE.test(macro)) { continue; }

        const offset = m.index;
        // Skip the placeholder bodies of function-like macro definitions.
        if (inAnyRange(fnDefineRanges, offset)) { continue; }

        const openIdx = m.index + m[0].length - 1; // the '('
        const parens = readParens(src, openIdx);
        if (!parens) { continue; }
        const args = splitArgs(parens.content, openIdx + 1);
        if (args.length === 0) { MACRO_CALL_RE.lastIndex = parens.end; continue; }

        // Member name is the 2nd argument for nearly all macros; the *_ACCESS
        // family puts the resource name first instead.
        let nameIdx = args.length >= 2 ? 1 : 0;
        if (/_ACCESS$/.test(macro)) { nameIdx = 0; }

        const arg = args[nameIdx];
        if (arg && IDENT_RE.test(arg.text)) {
            const member: UniformMember = {
                name: arg.text,
                type: args.length >= 2 ? args[0].text : '',
                nameOffset: arg.offset,
            };
            const block = blocks.find(b => offset >= b.start && offset < b.end);
            if (block) { structs[blocks.indexOf(block)].members.push(member); }
            else { looseMembers.push(member); }
        }
        MACRO_CALL_RE.lastIndex = parens.end;
    }

    return { structs, looseMembers };
}

/** Locate BEGIN_*_STRUCT(Name, ...) ... END_*_STRUCT() blocks. */
function findBlocks(src: string): Block[] {
    const blocks: Block[] = [];
    BEGIN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = BEGIN_RE.exec(src))) {
        const openIdx = m.index + m[0].length - 1;
        const parens = readParens(src, openIdx);
        if (!parens) { continue; }
        const args = splitArgs(parens.content, openIdx + 1);
        if (args.length === 0 || !IDENT_RE.test(args[0].text)) { BEGIN_RE.lastIndex = parens.end; continue; }

        END_RE.lastIndex = parens.end;
        const e = END_RE.exec(src);
        const end = e ? e.index : src.length;
        blocks.push({ name: args[0].text, nameOffset: args[0].offset, start: parens.end, end });
        BEGIN_RE.lastIndex = end;
    }
    return blocks;
}

/** Offset ranges covered by function-like `#define NAME(...) ...` directives (incl. `\` continuations). */
function functionLikeDefineRanges(src: string): { start: number; end: number }[] {
    const ranges: { start: number; end: number }[] = [];
    const re = /^[ \t]*#[ \t]*define[ \t]+[A-Za-z_]\w*\(/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
        const start = m.index;
        let i = start;
        while (i < src.length) {
            if (src[i] === '\n') {
                let k = i - 1;
                while (k >= 0 && (src[k] === ' ' || src[k] === '\t' || src[k] === '\r')) { k--; }
                if (src[k] === '\\') { i++; continue; } // line continuation
                break;
            }
            i++;
        }
        ranges.push({ start, end: i });
        re.lastIndex = i;
    }
    return ranges;
}

function inAnyRange(ranges: { start: number; end: number }[], offset: number): boolean {
    for (const r of ranges) { if (offset >= r.start && offset < r.end) { return true; } }
    return false;
}

/** Reads a balanced `(...)` starting at `openIdx`; returns the inner text + index past `)`. */
function readParens(src: string, openIdx: number): { content: string; end: number } | null {
    if (src[openIdx] !== '(') { return null; }
    let depth = 0;
    for (let i = openIdx; i < src.length; i++) {
        const c = src[i];
        if (c === '(') { depth++; }
        else if (c === ')') { depth--; if (depth === 0) { return { content: src.slice(openIdx + 1, i), end: i + 1 }; } }
    }
    return null;
}

/** Split top-level comma-separated args, returning each trimmed text + its absolute offset. */
function splitArgs(s: string, base: number): { text: string; offset: number }[] {
    const out: { text: string; offset: number }[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i <= s.length; i++) {
        const c = s[i];
        if (i === s.length || (c === ',' && depth === 0)) {
            const raw = s.slice(start, i);
            const lead = raw.length - raw.replace(/^\s+/, '').length;
            const text = raw.trim();
            if (text.length > 0) { out.push({ text, offset: base + start + lead }); }
            start = i + 1;
        } else if (c === '(' || c === '[' || c === '<' || c === '{') { depth++; }
        else if (c === ')' || c === ']' || c === '>' || c === '}') { depth--; }
    }
    return out;
}

/** Replace comment and string-literal characters with spaces, preserving length and newlines. */
function blankCommentsAndStrings(src: string): string {
    const a = src.split('');
    const n = src.length;
    let i = 0;
    const blank = (j: number) => { if (src[j] !== '\n' && src[j] !== '\r') { a[j] = ' '; } };
    while (i < n) {
        const c = src[i], d = src[i + 1];
        if (c === '/' && d === '/') {
            while (i < n && src[i] !== '\n') { blank(i); i++; }
        } else if (c === '/' && d === '*') {
            a[i] = ' '; a[i + 1] = ' '; i += 2;
            while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { blank(i); i++; }
            if (i < n) { a[i] = ' '; a[i + 1] = ' '; i += 2; }
        } else if (c === '"' || c === '\'') {
            const q = c; a[i] = ' '; i++;
            while (i < n && src[i] !== q) {
                if (src[i] === '\\') { blank(i); if (i + 1 < n) { blank(i + 1); } i += 2; continue; }
                blank(i); i++;
            }
            if (i < n) { a[i] = ' '; i++; }
        } else { i++; }
    }
    return a.join('');
}
