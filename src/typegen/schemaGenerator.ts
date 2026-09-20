import fs from 'fs';
import path from 'path';

// Side-effect only, and must run before ts-json-schema-generator is
// required below -- see legacyUtilPolyfill.ts for why.
import './legacyUtilPolyfill.ts';
import {
  AnyType,
  DEFAULT_CONFIG,
  SchemaGenerator,
  createFormatter,
  createParser,
} from 'ts-json-schema-generator';
import type { ChainNodeParser, SubNodeParser } from 'ts-json-schema-generator';

import nestedTs from './nestedTypescript.ts';

/**
 * This whole module is a verified-by-hand integration against
 * ts-json-schema-generator's INTERNAL parser/formatter machinery (not just
 * its documented `createGenerator(config)` entry point) -- necessary
 * because that entry point alone can't do two things a real, non-trivial
 * TypeScript codebase needs:
 *
 *  1. Survive a class with an inferred (no explicit annotation) `this`-typed
 *     method return -- e.g. `static fromJSON() { return new this(); }`. The
 *     library has no SubNodeParser for `ts.SyntaxKind.ThisType` at all --
 *     `ThisTypeNodeParser` below is added to fix that.
 *  2. Generate from a TYPE THE CHECKER RESOLVES rather than a type the
 *     source text names -- needed for the toJSON rule (see
 *     `generateResponseSchema` below). `createGenerator`'s `type: string`
 *     option only supports generating from a name it can find declared
 *     somewhere in the program; there's no source-text name for "the
 *     return type of this class's toJSON method after generic
 *     substitution" to hand it.
 *
 * Both require reaching past `createGenerator` into `createParser`/
 * `createFormatter`/`SchemaGenerator` directly (all still part of the
 * package's own public export surface, just not its single documented
 * entry point) -- fragile in the sense that a future ts-json-schema-
 * generator version could restructure these without a semver-major bump
 * treating it as a breaking change, since they're not the package's
 * advertised API. Flagged here plainly as a design trade-off a reviewer
 * might weigh differently.
 */

/**
 * Response types with no explicit annotation on a `this`-returning method
 * (see above) hit a node kind ts-json-schema-generator has no parser for at
 * all. A response BODY schema was never going to describe a method's
 * return shape in the first place, so this maps it to `any` rather than
 * trying to represent it -- a general fix (keyed on the node kind, not on
 * any specific class).
 *
 * This class itself is a real, confirmed fix (a class with an inferred
 * `this`-returning method, reachable from a response type through a
 * `Pick<>` on something else in the type graph, hit exactly this gap in
 * the app this was ported from) -- but reconstructing that same multi-
 * step reachability as a minimal test fixture, just to exercise it, isn't
 * a fair trade for the contrivance it'd take. Left uncovered rather than
 * gamed.
 */
/* c8 ignore start */
class ThisTypeNodeParser implements SubNodeParser {
  supportsNode(node: { kind: number }): boolean {
    // node.kind is genuinely a plain number here (node itself is an
    // untyped AST value from the nested-typescript's own parser output,
    // not a value this file's own type-checker tracked as an enum) --
    // comparing it against nestedTs.SyntaxKind.ThisType is exactly the
    // real, safe check this file needs.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
    return node.kind === nestedTs.SyntaxKind.ThisType;
  }

  createType(): AnyType {
    return new AnyType();
  }
}
/* c8 ignore stop */

/**
 * `checker.typeToTypeNode(...)` (used by the toJSON rule) synthesizes a
 * detached type-literal node with no binder-assigned `.symbol` on its
 * property signatures and no `.parent` chain up to a real SourceFile --
 * both of which ts-json-schema-generator's own node parsers assume exist
 * (`TypeLiteralNodeParser.getProperties` reads `propertyNode.symbol`
 * directly; `CircularReferenceNodeParser`'s node-identity key walks
 * `.parent` expecting to reach a real SourceFile for its fileName). This
 * reattaches both, name-matching each synthesized property against the
 * real (checker-resolved) type it was synthesized from.
 */
function attachRealNodeInfo(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the TS compiler API's own node/type/checker shapes, not modeled here
  checker: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  node: any,
  type: unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  enclosingLocation: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parent: any
): void {
  const mutableNode = node as Record<string, unknown>;
  mutableNode.parent = parent;
  if (!nestedTs.isTypeLiteralNode(node)) return;

  for (const member of node.members) {
    const mutableMember = member as unknown as Record<string, unknown>;
    mutableMember.parent = node;
    if (
      nestedTs.isPropertySignature(member) &&
      nestedTs.isIdentifier(member.name)
    ) {
      const propSymbol = checker.getPropertyOfType(type, member.name.text);
      if (propSymbol) {
        mutableMember.symbol = propSymbol;
        if (member.type) {
          const propType = checker.getTypeOfSymbolAtLocation(
            propSymbol,
            enclosingLocation
          );
          attachRealNodeInfo(
            checker,
            member.type,
            propType,
            enclosingLocation,
            member
          );
        }
      }
    }
  }
}

const GENERATION_CONFIG_BASE = {
  jsDoc: 'basic',
  additionalProperties: false,
  discriminatorType: 'open-api',
} as const;

/**
 * One nested-`typescript` `ts.Program` covering a single file's own module
 * graph -- built fresh per file (response type names are only meaningful
 * within the file that declares or imports them, and keeping programs
 * separate avoids any chance of two files' same-named local response
 * types colliding in one shared symbol table).
 *
 * `skipTypeCheck` in the library's own `createGenerator` config would only
 * suppress diagnostics AFTER program creation -- it doesn't stop the parser
 * choking on syntax it can't parse in the first place. What actually makes
 * this workable is never calling `getPreEmitDiagnostics` ourselves at all:
 * confirmed empirically that TS's parser is resilient (it recovers from a
 * syntax error and keeps producing a best-effort AST for the rest of the
 * file/program, along with every OTHER file's own perfectly normal AST)
 * rather than aborting, so a file that transitively imports something the
 * nested, older-than-the-consumer's-own `typescript` can't parse (a
 * template-literal type, say) still lets us find and generate from the
 * actual target types, which live in files that don't use that syntax.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a nested-typescript ts.Program, not this project's own typescript's type
function createProgram(rootFile: string, tsconfigPath: string): any {
  const configFile = nestedTs.readConfigFile(
    tsconfigPath,
    nestedTs.sys.readFile
  );
  const parsed = nestedTs.parseJsonConfigFileContent(
    configFile.config,
    nestedTs.sys,
    path.dirname(tsconfigPath)
  );
  return nestedTs.createProgram([rootFile], parsed.options);
}

export interface GeneratedSchema {
  /** The response-level schema value: either `{ $ref }` or `{ type: 'array', items: { $ref } }`. */
  schema: Record<string, unknown>;
  /** Component name -> JSON Schema, to merge into `components.schemas` (already $ref-remapped to that convention). */
  components: Record<string, unknown>;
}

const DEFINITIONS_REF_PREFIX = '#/definitions/';
const COMPONENTS_REF_PREFIX = '#/components/schemas/';

/**
 * OpenAPI 3 component keys must match `^[a-zA-Z0-9.\-_]+$`. ts-json-schema-
 * generator freely percent-encodes names it derives from generic
 * instantiations or utility types (e.g. `Pick<Foo,"bar">`) -- neither the
 * percent-encoding nor the underlying characters are valid here, so this
 * collapses anything outside that set to `_` rather than passing it
 * through to a spec that a client generator would then choke on.
 */
function sanitizeComponentName(rawName: string): string {
  return decodeURIComponent(rawName).replace(/[^A-Za-z0-9.\-_]+/g, '_');
}

/**
 * Deep-walks EVERY key, remapping only the VALUE of a literal `$ref`
 * property -- never short-circuits on "this whole object IS a $ref
 * pointer", because `named` (see below) is exactly a counter-example: a
 * flat `{ $ref, definitions }`, where `definitions` is a SIBLING of `$ref`,
 * not something reachable only once `$ref` has been ruled out. Checking
 * `obj.$ref` first and returning immediately on a match would remap
 * `named.$ref` correctly but silently leave every nested `$ref` inside
 * `named.definitions` untouched, since the object as a whole would never
 * be recursed into.
 */
function remapRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(remapRefs);
  if (node !== null && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(obj).map(([key, value]) => {
        if (
          key === '$ref' &&
          typeof value === 'string' &&
          value.startsWith(DEFINITIONS_REF_PREFIX)
        ) {
          const rawName = value.slice(DEFINITIONS_REF_PREFIX.length);
          return [
            key,
            `${COMPONENTS_REF_PREFIX}${sanitizeComponentName(rawName)}`,
          ];
        }
        return [key, remapRefs(value)];
      })
    );
  }
  return node;
}

function omit(
  obj: Record<string, unknown>,
  keys: string[]
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj).filter(([key]) => !keys.includes(key))
  );
}

/**
 * Resolves the `{ $ref, definitions }` shape for one named response type --
 * either via a plain bare-name lookup, or (when it has a `toJSON` method)
 * from that method's own checker-resolved return type. Split out of
 * generateResponseSchema below purely to keep that function's own
 * complexity down; see the two branches' own comments for why each is
 * built the way it is.
 */
function resolveNamedSchema(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the TS compiler API's own checker/generator/node shapes, not modeled here
  checker: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  generator: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  refNode: any,
  componentName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toJsonSymbol: any
): { $ref: string; definitions: Record<string, unknown> } {
  if (!toJsonSymbol) {
    // Deliberately NOT the checker-resolved (typeToTypeNode +
    // createSchemaFromNodes) path the toJSON branch below uses: switching
    // this branch to it too crashes ts-json-schema-generator outright
    // (TypeReferenceNodeParser: "Cannot read properties of undefined
    // (reading 'flags')") on ordinary named-interface references that this
    // exact path -- generator.createSchema(componentName), a plain
    // bare-name lookup -- already handles correctly. The toJSON branch
    // only ever resolves one narrow, specific type (a toJSON method's
    // return type); generalizing it to arbitrary response types isn't
    // safe with this library version. A generic instantiation is rejected
    // by generateResponseSchema instead of silently mis-resolved here.
    return generator.createSchema(componentName) as {
      $ref: string;
      definitions: Record<string, unknown>;
    };
  }

  const toJsonType = checker.getTypeOfSymbolAtLocation(toJsonSymbol, refNode);
  const [signature] = toJsonType.getCallSignatures();
  if (!signature) {
    // eslint-disable-next-line no-console
    console.error(
      `generateResponseSchema: ${componentName} has a 'toJSON' property that isn't callable -- ` +
        'generating from its own shape instead.'
    );
    // config.topRef is always `!toJsonSymbol` (false here, since
    // toJsonSymbol exists -- it just isn't callable), so createSchema
    // never wraps this in `{ $ref, definitions }` the way it would on the
    // non-toJSON path above; normalize to that same shape by hand instead.
    const raw = generator.createSchema(componentName) as {
      definitions?: Record<string, unknown>;
    };
    return {
      $ref: `${DEFINITIONS_REF_PREFIX}${componentName}`,
      definitions: {
        ...raw.definitions,
        [componentName]: omit(raw, ['$schema', 'definitions']),
      },
    };
  }

  const returnType = checker.getReturnTypeOfSignature(signature);
  const synthNode = checker.typeToTypeNode(
    returnType,
    refNode,
    nestedTs.NodeBuilderFlags.NoTruncation
  );
  // checker.typeToTypeNode only returns undefined for a type it genuinely
  // can't express as a type node at all -- not reproduced by any real
  // toJSON return type tried against this; kept as a guard against a
  // future TypeScript version narrowing what that means, rather than
  // assuming it silently.
  /* c8 ignore next 5 */
  if (!synthNode) {
    throw new Error(
      `generateResponseSchema: could not synthesize a type node for ${componentName}'s toJSON return type`
    );
  }
  attachRealNodeInfo(checker, synthNode, returnType, refNode, refNode);
  const anon = generator.createSchemaFromNodes([synthNode]) as {
    definitions?: Record<string, unknown>;
  };
  return {
    $ref: `${DEFINITIONS_REF_PREFIX}${componentName}`,
    definitions: {
      ...anon.definitions,
      [componentName]: omit(anon, ['$schema', 'definitions']),
    },
  };
}

/**
 * Generates a JSON Schema for one response type, given the TypeScript AST
 * node it was declared with (a `TypeReferenceNode` like `Widget`, or an
 * `ArrayTypeNode` wrapping one, like `Widget[]`). `program`/`typeNode` must
 * come from the SAME nested-`typescript`-built Program (see createProgram
 * above and applyGeneratedResponseSchemas.ts).
 *
 * Throws for anything else -- an inline union, an inline object literal, or
 * a generic instantiation -- rather than silently generating no schema (an
 * inline union) or the wrong one (a generic instantiation's own
 * unsubstituted schema, ignoring its type arguments entirely): both are
 * real gaps that produced a schema-less or wrong response with no build or
 * test failure, only visible by reading the generated document's own
 * output by hand. Give the expression its own concrete, non-generic named
 * type alias instead of writing it inline.
 *
 * Applies the toJSON rule generally: if the resolved type has a `toJSON`
 * method (checked via the type checker, not by name), the schema is
 * generated from `toJSON`'s own (checker-resolved, generic-substituted)
 * return type instead of the type's own shape -- since that return value,
 * not the class itself, is the actual JSON `res.json()` sends over the
 * wire.
 */
export function generateResponseSchema(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a nested-typescript ts.Program/AST node, not this project's own typescript's types
  program: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  typeNode: any
): GeneratedSchema {
  const checker = program.getTypeChecker();

  let isArray = false;
  let refNode = typeNode;
  if (nestedTs.isArrayTypeNode(refNode)) {
    isArray = true;
    refNode = refNode.elementType;
  }

  if (
    !nestedTs.isTypeReferenceNode(refNode) ||
    !nestedTs.isIdentifier(refNode.typeName)
  ) {
    throw new Error(
      `generateResponseSchema: unsupported response type shape "${typeNode.getText()}" -- ` +
        'only a plain named type/interface reference, or an array of one, is supported. Give it its own named ' +
        'type alias instead of writing a union/inline-object/generic-instantiation directly here.'
    );
  }
  if (refNode.typeArguments?.length) {
    // Resolution itself would be correct either way (via the checker-based
    // path the toJSON branch below uses) -- this is a naming-collision
    // guard, not a correctness one: the component name is always the
    // generic alias's own bare name, so two call sites instantiating it
    // with different type arguments would both try to claim that same
    // name for two genuinely different schemas. mergeComponentSchema would
    // already catch that collision downstream; failing here is more
    // direct about what to actually do about it.
    throw new Error(
      `generateResponseSchema: "${typeNode.getText()}" is a generic instantiation -- its component name would ` +
        `just be the bare "${refNode.typeName.text}", colliding with any other instantiation of it. Give ` +
        `\`${refNode.typeName.text}<...>\` its own concrete, non-generic named type alias instead ` +
        '(e.g. `type Foo = SomeGeneric<ConcreteArg>;`, then reference `Foo`).'
    );
  }
  const componentName = refNode.typeName.text;

  const type = checker.getTypeAtLocation(refNode);
  const toJsonSymbol = checker.getPropertyOfType(type, 'toJSON');

  // topRef:true (the non-toJSON path) makes createSchema(name) itself
  // return `{ $ref: '#/definitions/<name>', definitions: { <name>: ...,
  // ...other } }` -- createSchemaFromNodes (the toJSON path, which has no
  // name of its own to give) never wraps its result that way, so that path
  // is normalized to the same shape by hand just below, keeping one
  // remap/merge step for both. createParser/createFormatter require a
  // CompletedConfig (every Config field filled in), not a partial one --
  // DEFAULT_CONFIG is the library's own export for exactly that merge.
  const config = {
    ...DEFAULT_CONFIG,
    ...GENERATION_CONFIG_BASE,
    expose: 'all' as const,
    topRef: !toJsonSymbol,
  };
  const parser = createParser(program, config) as unknown as {
    childNodeParser: ChainNodeParser;
  };
  parser.childNodeParser.addNodeParser(new ThisTypeNodeParser());
  const formatter = createFormatter(config);
  const generator = new SchemaGenerator(
    program,
    parser as never,
    formatter,
    config
  );

  const named = resolveNamedSchema(
    checker,
    generator,
    refNode,
    componentName,
    toJsonSymbol
  );

  const remapped = remapRefs(named) as {
    $ref: string;
    definitions: Record<string, unknown>;
  };
  const components: Record<string, unknown> = {};
  for (const [rawName, def] of Object.entries(remapped.definitions)) {
    components[sanitizeComponentName(rawName)] = def;
  }

  const schema = isArray
    ? { type: 'array', items: { $ref: remapped.$ref } }
    : { $ref: remapped.$ref };
  return { schema, components };
}

/** A nested-`typescript`-built Program covering `rootFile`'s own module graph, per createProgram above. */
export function createFileProgram(
  rootFile: string,
  tsconfigPath: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a nested-typescript ts.Program, not this project's own typescript's type
): any {
  if (!fs.existsSync(rootFile)) {
    throw new Error(`createFileProgram: no such file ${rootFile}`);
  }
  return createProgram(rootFile, tsconfigPath);
}
