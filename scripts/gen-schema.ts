// Emits docs/protocol.schema.json: a machine-readable description of the @bizzi/protocol wire protocol
// (landscape.md §4.5), as JSON Schema draft 2020-12 with one $defs entry per type.
//
//   node scripts/gen-schema.ts           # write docs/protocol.schema.json   (npm run schema)
//   node scripts/gen-schema.ts --check   # fail if the committed file is stale (npm run schema:check)
//
// It walks the protocol's type declarations with the TypeScript compiler API (the installed
// `typescript` devDependency, via its tsgo API). Every interface and type alias in the wire files gets
// a $def under its own name; each method gets `params:<method>` and `result:<method>`, each event
// `session:<type>` / `global:<type>` (the two channels share some type names). The generic and mapped
// envelope types (RequestMsg, SessionEventBody, …) are expanded from the method and event maps.
// TypeScript syntax the walker doesn't know fails the run instead of being dropped silently.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API } from 'typescript/unstable/sync';
import { SyntaxKind } from 'typescript/unstable/ast';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Schema = { [k: string]: Json };
// The tsgo AST is a remote, read-only view; the walker reads it structurally.
type Node = any;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROTOCOL = join(ROOT, 'packages/protocol');
const OUT = join(ROOT, 'docs/protocol.schema.json');
/** The wire protocol. adapter.ts (internal adapter contract) and ids.ts (id helpers) are not on the wire. */
const WIRE_FILES = ['model.ts', 'capabilities.ts', 'methods.ts', 'events.ts', 'envelope.ts', 'hub.ts'];
/** Maps expanded into per-entry $defs instead of being emitted as objects. */
const MAPS = { methods: 'Methods', session: 'SessionEventMap', global: 'GlobalEventMap' } as const;
/** Generic / mapped helpers whose $defs are built from the maps (or that are type-level only). */
const BUILT = new Set(['RequestMsg', 'ResponseOkMsg', 'MethodName', 'SessionEventType', 'GlobalEventType', 'SessionEventBody', 'GlobalEventBody']);
const TYPE_LEVEL_ONLY = new Set(['MethodParams', 'MethodResult']);

interface Decl {
  name: string;
  node: Node;
  text: string;
}

class Walker {
  readonly decls = new Map<string, Decl>();
  readonly defs: Record<string, Schema> = {};
  readonly #refs = new Set<string>();

  add(text: string, statements: readonly Node[]): void {
    for (const s of statements) {
      if (s.kind !== SyntaxKind.InterfaceDeclaration && s.kind !== SyntaxKind.TypeAliasDeclaration) continue;
      const name = s.name.text as string;
      if (this.decls.has(name)) throw new Error(`duplicate declaration ${name}`);
      this.decls.set(name, { name, node: s, text });
    }
  }

  decl(name: string): Decl {
    const d = this.decls.get(name);
    if (!d) throw new Error(`unknown type ${name}`);
    return d;
  }

  ref(name: string): Schema {
    this.#refs.add(name);
    return { $ref: `#/$defs/${name}` };
  }

  /** Every $ref must point at a $def. */
  assertResolved(): void {
    const missing = [...this.#refs].filter((r) => !(r in this.defs));
    if (missing.length) throw new Error(`unresolved $refs: ${missing.join(', ')}`);
  }

  /** $def for an interface or type alias. */
  declaration(d: Decl): Schema {
    const n = d.node;
    if (n.typeParameters?.length) throw new Error(`${d.name}: generic declarations need a hand-built $def`);
    let schema: Schema;
    if (n.kind === SyntaxKind.InterfaceDeclaration) {
      const own = this.object(n.members, d.text, true);
      const bases = (n.heritageClauses ?? []).flatMap((h: Node) => [...h.types]).map((t: Node) => {
        if (t.typeArguments?.length) throw new Error(`${d.name}: generic base types are not supported`);
        return this.ref(t.expression.text);
      });
      schema = bases.length ? { allOf: [...bases, own] } : own;
    } else {
      schema = this.type(n.type, d.text);
    }
    const description = jsdoc(d.text, n);
    return description ? { description, ...schema } : schema;
  }

  /** An object schema from type members (interface body or type literal). */
  object(members: readonly Node[], text: string, withRequired: boolean): Schema {
    const properties: Record<string, Json> = {};
    const required: string[] = [];
    let additional: Json | undefined;
    for (const m of members) {
      if (m.kind === SyntaxKind.PropertySignature) {
        const key = propName(m.name);
        let prop = m.type ? this.type(m.type, text) : {};
        const description = jsdoc(text, m);
        if (description) prop = { description, ...prop };
        properties[key] = prop;
        if (m.postfixToken?.kind !== SyntaxKind.QuestionToken) required.push(key);
      } else if (m.kind === SyntaxKind.IndexSignature) {
        const keyType = m.parameters?.[0]?.type;
        if (keyType?.kind !== SyntaxKind.StringKeyword) throw new Error(`index signature key must be string: ${src(text, m)}`);
        additional = this.type(m.type, text);
      } else {
        throw new Error(`unsupported member ${SyntaxKind[m.kind]}: ${src(text, m)}`);
      }
    }
    const out: Schema = { type: 'object', properties };
    if (withRequired && required.length) out.required = required;
    if (additional !== undefined) out.additionalProperties = additional;
    return out;
  }

  /** Members of a named or literal object type, for Partial<> and indexed access. */
  members(t: Node, text: string): { members: Node[]; text: string } {
    if (t.kind === SyntaxKind.TypeLiteral) return { members: [...t.members], text };
    if (t.kind === SyntaxKind.TypeReference && !t.typeArguments?.length) {
      const d = this.decl(t.typeName.text);
      if (d.node.kind === SyntaxKind.InterfaceDeclaration && !d.node.heritageClauses?.length) return { members: [...d.node.members], text: d.text };
      if (d.node.kind === SyntaxKind.TypeAliasDeclaration) return this.members(d.node.type, d.text);
    }
    throw new Error(`not a plain object type: ${src(text, t)}`);
  }

  type(t: Node, text: string): Schema {
    switch (t.kind) {
      case SyntaxKind.StringKeyword:
        return { type: 'string' };
      case SyntaxKind.NumberKeyword:
        return { type: 'number' };
      case SyntaxKind.BooleanKeyword:
        return { type: 'boolean' };
      case SyntaxKind.UnknownKeyword:
      case SyntaxKind.AnyKeyword:
        return {};
      case SyntaxKind.NeverKeyword:
        return { not: {} };
      case SyntaxKind.ParenthesizedType:
        return this.type(t.type, text);
      case SyntaxKind.TypeOperator:
        if (t.operator !== SyntaxKind.ReadonlyKeyword) break;
        return this.type(t.type, text);
      case SyntaxKind.ArrayType:
        return { type: 'array', items: this.type(t.elementType, text) };
      case SyntaxKind.TupleType: {
        const items = [...t.elements].map((e: Node) => {
          if (e.kind === SyntaxKind.RestType || e.kind === SyntaxKind.OptionalType || e.dotDotDotToken || e.questionToken) {
            throw new Error(`rest/optional tuple elements are not supported: ${src(text, t)}`);
          }
          return this.type(e.kind === SyntaxKind.NamedTupleMember ? e.type : e, text);
        });
        return { type: 'array', prefixItems: items, minItems: items.length, maxItems: items.length };
      }
      case SyntaxKind.LiteralType:
        return literal(t.literal, text);
      case SyntaxKind.TypeLiteral:
        return this.object(t.members, text, true);
      case SyntaxKind.UnionType:
        return union([...t.types].filter((m: Node) => m.kind !== SyntaxKind.UndefinedKeyword).map((m: Node) => this.type(m, text)));
      case SyntaxKind.IntersectionType:
        return { allOf: [...t.types].map((m: Node) => this.type(m, text)) };
      case SyntaxKind.IndexedAccessType: {
        if (t.indexType.kind !== SyntaxKind.LiteralType || t.indexType.literal.kind !== SyntaxKind.StringLiteral) break;
        const key = t.indexType.literal.text as string;
        const { members, text: mt } = this.members(t.objectType, text);
        const m = members.find((x) => x.kind === SyntaxKind.PropertySignature && propName(x.name) === key);
        if (!m) throw new Error(`no property ${key}: ${src(text, t)}`);
        return this.type(m.type, mt);
      }
      case SyntaxKind.TypeReference:
        return this.reference(t, text);
    }
    throw new Error(`unsupported type syntax ${SyntaxKind[t.kind]}: ${src(text, t)}`);
  }

  reference(t: Node, text: string): Schema {
    if (t.typeName.kind !== SyntaxKind.Identifier) throw new Error(`qualified type names are not supported: ${src(text, t)}`);
    const name = t.typeName.text as string;
    const args: Node[] = [...(t.typeArguments ?? [])];
    switch (name) {
      case 'Record': {
        const [k, v] = args;
        if (k?.kind !== SyntaxKind.StringKeyword) throw new Error(`Record keys must be string: ${src(text, t)}`);
        return v.kind === SyntaxKind.NeverKeyword
          ? { type: 'object', additionalProperties: false }
          : { type: 'object', additionalProperties: this.type(v, text) };
      }
      case 'Partial': {
        const { members, text: mt } = this.members(args[0], text);
        return this.object(members, mt, false);
      }
      case 'Array':
      case 'ReadonlyArray':
        return { type: 'array', items: this.type(args[0], text) };
    }
    if (args.length) throw new Error(`unsupported generic reference: ${src(text, t)}`);
    if (TYPE_LEVEL_ONLY.has(name)) throw new Error(`${name} is type-level only: ${src(text, t)}`);
    this.decl(name);
    return this.ref(name);
  }
}

function propName(n: Node): string {
  if (n.kind === SyntaxKind.Identifier || n.kind === SyntaxKind.StringLiteral) return n.text;
  throw new Error(`unsupported property name ${SyntaxKind[n.kind]}`);
}

function literal(l: Node, text: string): Schema {
  switch (l.kind) {
    case SyntaxKind.StringLiteral:
      return { const: l.text };
    case SyntaxKind.NumericLiteral:
      return { const: Number(l.text) };
    case SyntaxKind.TrueKeyword:
      return { const: true };
    case SyntaxKind.FalseKeyword:
      return { const: false };
    case SyntaxKind.NullKeyword:
      return { type: 'null' };
  }
  throw new Error(`unsupported literal: ${src(text, l)}`);
}

/** String-literal unions become enums; unions of bare primitive types a type list; the rest anyOf. */
function union(members: Schema[]): Schema {
  if (members.length === 1) return members[0]!;
  if (members.every((m) => Object.keys(m).length === 1 && typeof m.const === 'string')) {
    return { type: 'string', enum: members.map((m) => m.const as string) };
  }
  if (members.every((m) => Object.keys(m).length === 1 && typeof m.type === 'string')) {
    return { type: members.map((m) => m.type as string) };
  }
  return { anyOf: members };
}

function src(text: string, n: Node): string {
  return text.slice(n.pos, n.end).trim().slice(0, 120);
}

/** The JSDoc block right before a node (its leading trivia), as one line of text. */
function jsdoc(text: string, n: Node): string | undefined {
  const trivia = /^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/.exec(text.slice(n.pos, n.end))?.[0] ?? '';
  const m = /\/\*\*([\s\S]*?)\*\/\s*$/.exec(trivia);
  if (!m) return undefined;
  const lines = m[1]!.split('\n').map((l) => l.replace(/^\s*\*?\s?/, '').trimEnd());
  return lines.join(' ').replace(/\s+/g, ' ').trim() || undefined;
}

function constString(text: string, statements: readonly Node[], name: string): string {
  for (const s of statements) {
    if (s.kind !== SyntaxKind.VariableStatement) continue;
    for (const d of s.declarationList.declarations) {
      if (d.name.text === name && d.initializer?.kind === SyntaxKind.StringLiteral) return d.initializer.text;
    }
  }
  throw new Error(`const ${name} not found in ${text.slice(0, 40)}…`);
}

function mapEntries(w: Walker, mapName: string): { name: string; type: Node; text: string; description?: string }[] {
  const d = w.decl(mapName);
  if (d.node.kind !== SyntaxKind.InterfaceDeclaration) throw new Error(`${mapName} must be an interface`);
  return [...d.node.members].map((m: Node) => {
    if (m.kind !== SyntaxKind.PropertySignature) throw new Error(`${mapName}: unsupported member ${src(d.text, m)}`);
    const description = jsdoc(d.text, m);
    return { name: propName(m.name), type: m.type, text: d.text, ...(description ? { description } : {}) };
  });
}



export function generate(): string {
  const api = new API({ cwd: ROOT });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [join(PROTOCOL, 'tsconfig.json')] });
    const program = snapshot.getProjects()[0]?.program;
    if (!program) throw new Error('could not open packages/protocol/tsconfig.json');
    const w = new Walker();
    let version = '';
    for (const f of WIRE_FILES) {
      const sf = program.getSourceFile(join(PROTOCOL, 'src', f));
      if (!sf) throw new Error(`source file ${f} not in the protocol program`);
      const statements = [...sf.statements];
      w.add(sf.text, statements);
      if (f === 'envelope.ts') version = constString(sf.text, statements, 'PROTOCOL_VERSION');
    }

    // Named types.
    const mapNames = new Set<string>(Object.values(MAPS));
    for (const d of w.decls.values()) {
      if (BUILT.has(d.name) || TYPE_LEVEL_ONLY.has(d.name) || mapNames.has(d.name)) continue;
      w.defs[d.name] = w.declaration(d);
    }

    // Methods: params:<m> / result:<m>, plus the request envelope.
    const methods: Record<string, Json> = {};
    const requests: Json[] = [];
    for (const m of mapEntries(w, MAPS.methods)) {
      if (m.type.kind !== SyntaxKind.TypeLiteral) throw new Error(`Methods['${m.name}'] must be { params; result }`);
      const parts = Object.fromEntries([...m.type.members].map((x: Node) => [propName(x.name), x]));
      if (!parts.params || !parts.result) throw new Error(`Methods['${m.name}'] needs params and result`);
      for (const part of ['params', 'result'] as const) {
        const p = parts[part];
        const description = jsdoc(m.text, p);
        const s = w.type(p.type, m.text);
        w.defs[`${part}:${m.name}`] = description ? { description, ...s } : s;
      }
      methods[m.name] = { ...(m.description ? { description: m.description } : {}), params: w.ref(`params:${m.name}`), result: w.ref(`result:${m.name}`) };
      requests.push({
        type: 'object',
        required: ['id', 'method', 'params'],
        properties: { id: { type: 'string' }, method: { const: m.name }, params: w.ref(`params:${m.name}`) },
      });
    }
    w.defs.MethodName = { type: 'string', enum: Object.keys(methods) };
    w.defs.RequestMsg = { description: 'A client → server request; `params` follows the method.', oneOf: requests };
    w.defs.ResponseOkMsg = {
      description: 'A successful response; `result` is the `result:<method>` of the request with the same id.',
      type: 'object',
      required: ['id', 'result'],
      properties: { id: { type: 'string' }, result: {} },
    };

    // Events: session:<type> / global:<type>, plus the event bodies.
    const events: Record<string, Json> = {};
    for (const [channel, mapName] of [['session', MAPS.session], ['global', MAPS.global]] as const) {
      const entries = mapEntries(w, mapName);
      const byType: Record<string, Json> = {};
      const bodies: Json[] = [];
      for (const e of entries) {
        w.defs[`${channel}:${e.name}`] = w.type(e.type, e.text);
        byType[e.name] = { ...(e.description ? { description: e.description } : {}), data: w.ref(`${channel}:${e.name}`) };
        bodies.push({ type: 'object', required: ['type', 'data'], properties: { type: { const: e.name }, data: w.ref(`${channel}:${e.name}`) } });
      }
      const prefix = channel === 'session' ? 'Session' : 'Global';
      w.defs[`${prefix}EventType`] = { type: 'string', enum: entries.map((e) => e.name) };
      w.defs[`${prefix}EventBody`] = { oneOf: bodies };
      events[channel] = byType;
    }

    w.assertResolved();
    const schema: Schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'urn:bizzi:protocol',
      title: 'bizzi wire protocol',
      description:
        'Generated from packages/protocol/src by scripts/gen-schema.ts; do not edit. The root schema validates one ' +
        'WebSocket text frame (ClientMsg or ServerMsg). x-methods and x-events index the per-method and per-event $defs.',
      'x-protocolVersion': version,
      oneOf: [w.ref('ClientMsg'), w.ref('ServerMsg')],
      'x-methods': methods,
      'x-events': events,
      // $defs sorted by name; properties keep their source order.
      $defs: Object.fromEntries(Object.keys(w.defs).sort().map((k) => [k, w.defs[k]!])),
    };
    return JSON.stringify(schema, null, 2) + '\n';
  } finally {
    api.close();
  }
}

if (import.meta.main) {
  const out = generate();
  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(OUT, 'utf8');
    } catch {}
    if (current !== out) {
      process.stderr.write('docs/protocol.schema.json is stale: run `npm run schema` and commit the result.\n');
      process.exit(1);
    }
    process.stdout.write('docs/protocol.schema.json is up to date\n');
  } else {
    writeFileSync(OUT, out);
    const n = Object.keys(JSON.parse(out).$defs).length;
    process.stdout.write(`wrote docs/protocol.schema.json (${n} $defs)\n`);
  }
}
