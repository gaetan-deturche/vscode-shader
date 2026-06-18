'use strict';

/**
 * AST node shapes for the declaration-level HLSL parser.
 *
 * The parser only models declarations (and, inside function bodies, local
 * declarations + block nesting for scope tracking). Statements and full
 * expressions are intentionally not represented.
 */

export interface NodeSpan {
    /** Absolute character offsets into the source string. */
    start: number;
    end: number;
}

/** A (possibly templated, possibly arrayed) type reference, e.g. `StructuredBuffer<float4>[2]`. */
export interface TypeRef {
    name: string;
    args?: TypeRef[];
    /** Number of array dimensions (`float a[2][3]` -> 2). 0/undefined = not an array. */
    arrayDims?: number;
}

export interface ParseError {
    message: string;
    span: NodeSpan;
}

export interface IncludeDecl {
    kind: 'IncludeDecl';
    path: string;
    angle: boolean; // true for <...>, false for "..."
    span: NodeSpan;
}

export interface MacroDecl {
    kind: 'MacroDecl';
    name: string;
    nameSpan: NodeSpan;
    /** undefined = object-like macro; array (possibly empty) = function-like macro. */
    params?: string[];
    body: string;
    span: NodeSpan;
}

export interface FieldDecl {
    kind: 'FieldDecl';
    name: string;
    nameSpan: NodeSpan;
    type: TypeRef;
    semantic?: string;
    span: NodeSpan;
}

export interface StructDecl {
    kind: 'StructDecl';
    name: string;
    nameSpan: NodeSpan;
    isClass: boolean;
    base?: string;
    fields: FieldDecl[];
    containerName?: string;
    span: NodeSpan;
}

export interface VariableDecl {
    kind: 'VariableDecl';
    name: string;
    nameSpan: NodeSpan;
    type: TypeRef;
    modifiers: string[];
    semantic?: string;
    register?: string;
    packoffset?: string;
    containerName?: string;
    span: NodeSpan;
}

export interface CBufferDecl {
    kind: 'CBufferDecl';
    bufferKind: 'cbuffer' | 'tbuffer';
    name: string;
    nameSpan: NodeSpan;
    register?: string;
    fields: VariableDecl[];
    span: NodeSpan;
}

export interface ResourceDecl {
    kind: 'ResourceDecl';
    name: string;
    nameSpan: NodeSpan;
    /** The resource type, e.g. Texture2D, StructuredBuffer<T>, SamplerState, ConstantBuffer<T>. */
    type: TypeRef;
    register?: string;
    span: NodeSpan;
}

export interface Attribute {
    name: string;
    args: string;
    span: NodeSpan;
}

export interface ParamDecl {
    kind: 'ParamDecl';
    name: string;
    nameSpan: NodeSpan;
    type: TypeRef;
    direction: 'in' | 'out' | 'inout' | 'none';
    semantic?: string;
    span: NodeSpan;
}

export interface FunctionDecl {
    kind: 'FunctionDecl';
    name: string;
    nameSpan: NodeSpan;
    returnType: TypeRef;
    params: ParamDecl[];
    semantic?: string;
    attributes: Attribute[];
    isDefinition: boolean; // true if a body `{...}` was present
    body?: Scope;
    containerName?: string;
    span: NodeSpan;
}

export interface TypedefDecl {
    kind: 'TypedefDecl';
    name: string;
    nameSpan: NodeSpan;
    underlying: TypeRef;
    span: NodeSpan;
}

export interface NamespaceDecl {
    kind: 'NamespaceDecl';
    name: string;
    nameSpan: NodeSpan;
    decls: Decl[];
    span: NodeSpan;
}

export type Decl =
    | IncludeDecl
    | MacroDecl
    | StructDecl
    | VariableDecl
    | CBufferDecl
    | ResourceDecl
    | FunctionDecl
    | TypedefDecl
    | NamespaceDecl;

export interface SourceFile {
    kind: 'SourceFile';
    uri: string;
    decls: Decl[];
    scope: Scope;
    includes: IncludeDecl[];
    errors: ParseError[];
    /** Offsets of the start of each line, for offset -> Position mapping. */
    lineStarts: number[];
    span: NodeSpan;
}

// --- Scope model -------------------------------------------------------

import { SymbolKind } from 'vscode';

export interface SymbolEntry {
    name: string;
    decl: Decl | ParamDecl | FieldDecl;
    kind: SymbolKind;
    type?: TypeRef;
}

export interface Scope {
    parent: Scope | null;
    span: NodeSpan;
    /** name -> entries (array allows overloads / redeclarations). */
    symbols: Map<string, SymbolEntry[]>;
    children: Scope[];
}

// --- Builtin type tables ----------------------------------------------

/**
 * Resource/object type identifiers recognised structurally as ResourceDecl.
 * Mirrors (and extends) the texture/buffer/sampler names used by the regex
 * backend in symbolProvider.ts.
 */
export const KNOWN_RESOURCE_TYPES = new Set<string>([
    // Samplers
    'sampler', 'sampler1D', 'sampler2D', 'sampler3D', 'samplerCUBE', 'samplerRECT',
    'sampler_state', 'SamplerState', 'SamplerComparisonState',
    // Textures
    'texture', 'texture2D', 'textureCUBE',
    'Texture1D', 'Texture1DArray', 'Texture2D', 'Texture2DArray', 'Texture2DMS',
    'Texture2DMSArray', 'Texture2DMultisample', 'Texture3D', 'TextureCube', 'TextureCubeArray',
    'RWTexture1D', 'RWTexture1DArray', 'RWTexture2D', 'RWTexture2DArray', 'RWTexture3D',
    'TextureRenderTarget2D', 'RenderTarget2D', 'RenderTargetCube',
    // Buffers
    'AppendStructuredBuffer', 'Buffer', 'ByteAddressBuffer', 'ConsumeStructuredBuffer',
    'RWBuffer', 'RWByteAddressBuffer', 'RWStructuredBuffer', 'StructuredBuffer',
    'ConstantBuffer',
]);

/** Vector base type -> component count, used for swizzle completion. */
export const VECTOR_TYPES: { [name: string]: number } = {
    float2: 2, float3: 3, float4: 4,
    half2: 2, half3: 3, half4: 4,
    int2: 2, int3: 3, int4: 4,
    uint2: 2, uint3: 3, uint4: 4,
    double2: 2, double3: 3, double4: 4,
    bool2: 2, bool3: 3, bool4: 4,
};
