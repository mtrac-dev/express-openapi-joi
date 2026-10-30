import fs from 'fs';
import path from 'path';

// Must be imported before ts-json-schema-generator.
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

// Response schemas are generated with ts-json-schema-generator's
// `createParser`, `createFormatter` and `SchemaGenerator` instead of its
// documented `createGenerator`, which can't do two things needed here:
//
// - Parse a class with an unannotated method that returns `this`, such as
//   `static fromJSON() { return new this(); }`. `ThisTypeNodeParser` adds
//   that.
// - Generate from a type the checker resolves, such as a `toJSON()` return
//   type, which has no name `createGenerator` could look up.
//
// These are exported by the package but aren't its documented API, so a
// minor release of ts-json-schema-generator could break them.

/**
 * Parse `this` type nodes as `any`.
 *
 * @remarks
 * ts-json-schema-generator has no parser for `this` types. A response body
 * doesn't describe methods, so `any` is enough.
 *
 * Not covered by tests: the failure needs a class with a `this`-returning
 * method reached through a utility type such as `Pick<>`, which a small
 * fixture doesn't reproduce.
 */
/* c8 ignore start */
class ThisTypeNodeParser implements SubNodeParser {
  supportsNode(node: { kind: number }): boolean {
    // `node` comes from the nested `typescript`, so `kind` is a plain number.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
    return node.kind === nestedTs.SyntaxKind.ThisType;
  }

  createType(): AnyType {
    return new AnyType();
  }
}
/* c8 ignore stop */

/**
 * Add the `symbol` and `parent` links that ts-json-schema-generator expects
 * to a type node from `checker.typeToTypeNode`.
 *
 * @remarks
 * `typeToTypeNode` returns a detached node: its property signatures have no
 * `symbol`, and it has no `parent` chain to a source file. Each property's
 * symbol is looked up by name on `type`.
 */
function attachRealNodeInfo(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- nested-typescript compiler API objects
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
 * Create a program for one file and its imports with the nested
 * `typescript`.
 *
 * @remarks
 * Each file gets its own program, so same-named types in different files
 * don't collide. Diagnostics are never requested: the parser recovers from
 * syntax the nested `typescript` can't parse, so types elsewhere in the
 * program can still be generated.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- nested-typescript compiler API objects
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

/** A generated response schema, and the component schemas it refers to. */
export interface GeneratedSchema {
  /**
   * The response body schema: a `$ref` to a component schema, or an array
   * schema of them.
   */
  schema: Record<string, unknown>;
  /** The component schemas to add to `components.schemas`, keyed by name. */
  components: Record<string, unknown>;
}

const DEFINITIONS_REF_PREFIX = '#/definitions/';
const COMPONENTS_REF_PREFIX = '#/components/schemas/';

/**
 * Replace the characters OpenAPI doesn't allow in a component name with `_`.
 *
 * @remarks
 * Component names must match `^[a-zA-Z0-9.\-_]+$`. ts-json-schema-generator
 * percent-encodes names it derives from generic and utility types, such as
 * `Pick<Foo,"bar">`.
 */
function sanitizeComponentName(rawName: string): string {
  return decodeURIComponent(rawName).replace(/[^A-Za-z0-9.\-_]+/g, '_');
}

/**
 * Point every `#/definitions/` `$ref` at `#/components/schemas/` instead,
 * with the name sanitized.
 *
 * @remarks
 * Every key is visited, including the siblings of a `$ref`: a named schema
 * has the shape `{ $ref, definitions }`.
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
 * Generate the `{ $ref, definitions }` schema for a named response type.
 *
 * @remarks
 * A type with a `toJSON()` method is generated from that method's return
 * type.
 */
function resolveNamedSchema(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- nested-typescript compiler API objects
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
    // Look up named types by name. The checker-resolved path the toJSON branch
    // uses crashes ts-json-schema-generator on ordinary interface references
    // ("Cannot read properties of undefined (reading 'flags')").
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
    // With `topRef` off, createSchema doesn't wrap the result in
    // `{ $ref, definitions }`, so wrap it here.
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
  // typeToTypeNode returns `undefined` only for a type it can't express as a
  // node, which no toJSON return type has hit.
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
 * Generate the JSON Schema for one response type.
 *
 * @remarks
 * A type with a `toJSON()` method is documented by what `toJSON()` returns.
 *
 * @param program - A program from `createFileProgram`.
 * @param typeNode - The type's node in that program's AST: a named type, such
 *   as `Widget`, or an array of one, such as `Widget[]`.
 * @returns The schema, and the component schemas it refers to.
 *
 * @throws Error
 * Thrown if `typeNode` is an inline object type, a union or a generic
 * instantiation. Give such a type a named alias instead.
 */
export function generateResponseSchema(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- nested-typescript compiler API objects
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
    // Every instantiation of a generic would get the same component name, so
    // their schemas would collide.
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

  // With `topRef` on, createSchema(name) returns `{ $ref, definitions }`. The
  // toJSON path has no name, so resolveNamedSchema wraps its result the same
  // way. createParser and createFormatter need every Config field, so start
  // from DEFAULT_CONFIG.
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

/**
 * Create the TypeScript program that `generateResponseSchema` needs.
 *
 * @param rootFile - Path of the file to analyze. Its imports are included.
 * @param tsconfigPath - Path of the `tsconfig.json` whose compiler options to
 *   use.
 * @returns The program.
 *
 * @throws Error
 * Thrown if `rootFile` doesn't exist.
 */
export function createFileProgram(
  rootFile: string,
  tsconfigPath: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- nested-typescript compiler API objects
): any {
  if (!fs.existsSync(rootFile)) {
    throw new Error(`createFileProgram: no such file ${rootFile}`);
  }
  return createProgram(rootFile, tsconfigPath);
}
