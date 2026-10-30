import fs from 'fs';
import path from 'path';

import type { OperationObject, SchemaObject } from 'openapi3-ts/oas31';

import { mergeComponentSchema } from '../document.ts';
import type { OpenApiDocument } from '../document.ts';
import { pathToDocSegment } from '../defineRoute.ts';
import nestedTs from './nestedTypescript.ts';
import {
  createFileProgram,
  generateResponseSchema,
} from './schemaGenerator.ts';

/**
 * Check whether a node is a `defineRoute.withResponses<...>()(router, def)`
 * call.
 *
 * @remarks
 * Plain `defineRoute` calls have no response types to read, and are left
 * alone.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- nested-typescript compiler API objects
function isWithResponsesCall(node: any): boolean {
  if (!nestedTs.isCallExpression(node)) return false;
  const callee = node.expression;
  return (
    nestedTs.isCallExpression(callee) &&
    nestedTs.isPropertyAccessExpression(callee.expression) &&
    nestedTs.isIdentifier(callee.expression.expression) &&
    callee.expression.expression.text === 'defineRoute' &&
    callee.expression.name.text === 'withResponses' &&
    // withResponses requires exactly one type argument; this only fails for
    // code that doesn't type-check.
    /* c8 ignore next */
    (callee.typeArguments?.length ?? 0) === 1
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- nested-typescript compiler API objects
function findWithResponsesCalls(sourceFile: any): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const results: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const visit = (node: any): void => {
    if (isWithResponsesCall(node)) results.push(node);
    nestedTs.forEachChild(node, visit);
  };
  nestedTs.forEachChild(sourceFile, visit);
  return results;
}

/**
 * Map each status in a `withResponses` type argument to its type node, such
 * as `Widget` or `Widget[]`.
 *
 * @returns The map, or `undefined` if the type argument isn't an inline
 *   object type.
 */
function extractResponsesMap(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- nested-typescript compiler API objects
  responsesTypeNode: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Map<number, any> | undefined {
  if (!nestedTs.isTypeLiteralNode(responsesTypeNode)) return undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const statusToType = new Map<number, any>();
  for (const member of responsesTypeNode.members) {
    if (
      nestedTs.isPropertySignature(member) &&
      member.type &&
      nestedTs.isNumericLiteral(member.name)
    ) {
      statusToType.set(Number(member.name.text), member.type);
    }
  }
  return statusToType;
}

/**
 * Collect the initializers of a file's top-level `const` declarations, by
 * name.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- nested-typescript compiler API objects
function localConstNodes(sourceFile: any): Map<string, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodes = new Map<string, any>();
  for (const statement of sourceFile.statements) {
    if (!nestedTs.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (nestedTs.isIdentifier(declaration.name) && declaration.initializer) {
        nodes.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  return nodes;
}

/**
 * Evaluate a `method`, `path` or `prefix` expression to a string without
 * running it.
 *
 * @remarks
 * Handles string literals, identifiers in `constMap`, `as const` assertions,
 * and template literals built from these, such as the template literal
 * `/:${CART_ID}`.
 *
 * @returns The string, or `undefined` for any other expression.
 */
function resolveStringExpression(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- nested-typescript compiler API objects
  expr: any,
  constMap: Map<string, string>
): string | undefined {
  if (nestedTs.isAsExpression(expr)) {
    return resolveStringExpression(expr.expression, constMap);
  }
  if (nestedTs.isStringLiteralLike(expr)) return expr.text;
  if (nestedTs.isIdentifier(expr)) return constMap.get(expr.text);
  if (nestedTs.isTemplateExpression(expr)) {
    let result = expr.head.text;
    for (const span of expr.templateSpans) {
      const resolvedSpan = resolveStringExpression(span.expression, constMap);
      if (resolvedSpan === undefined) return undefined;
      result += resolvedSpan + span.literal.text;
    }
    return result;
  }
  return undefined;
}

/**
 * Add the string constants named by a relative import to `constMap`.
 *
 * @remarks
 * Only the imported file's own top-level constants are resolved; its imports
 * aren't followed. An extensionless specifier is read as a `.ts` file.
 */
function resolveNamedImportConsts(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- nested-typescript compiler API objects
  statement: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  program: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sourceFile: any,
  constMap: Map<string, string>
): void {
  if (!nestedTs.isImportDeclaration(statement)) return;
  const { importClause, moduleSpecifier } = statement;
  if (
    !importClause?.namedBindings ||
    !nestedTs.isNamedImports(importClause.namedBindings)
  ) {
    return;
  }
  if (
    !nestedTs.isStringLiteralLike(moduleSpecifier) ||
    !moduleSpecifier.text.startsWith('.')
  ) {
    return;
  }

  // NodeNext imports already end in `.ts`, as in `'./paths.ts'`; older
  // resolution omits it, as in `'./paths'`.
  const resolvedSpecifier = path.resolve(
    path.dirname(sourceFile.fileName),
    moduleSpecifier.text
  );
  const resolvedPath = resolvedSpecifier.endsWith('.ts')
    ? resolvedSpecifier
    : `${resolvedSpecifier}.ts`;
  const importedSourceFile = program.getSourceFile(resolvedPath);
  if (!importedSourceFile) return;
  const importedLocals = localConstNodes(importedSourceFile);

  for (const element of importClause.namedBindings.elements) {
    const importedName = element.propertyName?.text ?? element.name.text;
    const initializer = importedLocals.get(importedName);
    const value =
      initializer && resolveStringExpression(initializer, new Map());
    if (value !== undefined) constMap.set(element.name.text, value);
  }
}

/**
 * Resolve the string value of each constant a file declares at the top
 * level or imports by name from a relative path.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- nested-typescript compiler API objects
function buildConstMap(program: any, sourceFile: any): Map<string, string> {
  const constMap = new Map<string, string>();

  for (const statement of sourceFile.statements) {
    resolveNamedImportConsts(statement, program, sourceFile, constMap);
  }

  for (const [name, initializer] of localConstNodes(sourceFile)) {
    const value = resolveStringExpression(initializer, constMap);
    if (value !== undefined) constMap.set(name, value);
  }

  return constMap;
}

function getObjectLiteralStringProp(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- nested-typescript compiler API objects
  obj: any,
  propName: string,
  constMap: Map<string, string>
): string | undefined {
  const prop = obj.properties.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- nested-typescript compiler API objects
    (p: any) =>
      nestedTs.isPropertyAssignment(p) &&
      nestedTs.isIdentifier(p.name) &&
      p.name.text === propName
  );
  return prop ? resolveStringExpression(prop.initializer, constMap) : undefined;
}

/**
 * Compute a `defineRoute` call's document path and method from its `def`
 * object literal, the same way `defineRoute` does.
 *
 * @returns The values that could be resolved. `docPath` is missing if `path`
 *   can't be resolved.
 */
function resolveDocPathAndMethod(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- nested-typescript compiler API objects
  defArg: any,
  constMap: Map<string, string>
): { docPath?: string; method?: string } {
  const method = getObjectLiteralStringProp(defArg, 'method', constMap);
  const prefix = getObjectLiteralStringProp(defArg, 'prefix', constMap);
  const routePath = getObjectLiteralStringProp(defArg, 'path', constMap);
  if (routePath === undefined) return { method };
  return { docPath: `${prefix ?? ''}${pathToDocSegment(routePath)}`, method };
}

// An operation from buildOpenApiDocument, which always sets `responses`.
type ResolvedOperation = OperationObject & {
  responses: Record<string, { description: string }>;
};

/**
 * Generate the schema for one status and set it on `operation`.
 *
 * @throws Error
 * Thrown if `operation` has no response for `status` to take a description
 * from.
 */
function applyGeneratedSchemaForStatus(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- nested-typescript compiler API objects
  program: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  typeNode: any,
  status: number,
  operation: ResolvedOperation,
  componentSchemas: Record<string, SchemaObject>,
  context: { relativeFile: string; docPath: string; method: string }
): void {
  const generated = generateResponseSchema(program, typeNode);

  for (const [name, def] of Object.entries(generated.components)) {
    const source = `${context.relativeFile}: ${context.method.toUpperCase()} ${context.docPath} ${status}`;
    mergeComponentSchema(componentSchemas, name, def as SchemaObject, source);
  }

  // Nothing checks that `responses` has an entry for each withResponses status.
  // Throw rather than invent a description.
  const existing = operation.responses[String(status)];
  if (!existing) {
    throw new Error(
      `applyGeneratedResponseSchemas: ${context.relativeFile}: ${context.method.toUpperCase()} ${context.docPath} ` +
        `declares ${status} in withResponses<> but has no matching responses[status] entry to take a description ` +
        'from -- add one.'
    );
  }
  operation.responses[String(status)] = {
    description: existing.description,
    content: { 'application/json': { schema: generated.schema } },
  };
}

/**
 * Apply the response schemas of one `defineRoute.withResponses` call to
 * `document`.
 *
 * @throws Error
 * Thrown if the type argument isn't an inline object type.
 */
function processWithResponsesCall(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- nested-typescript compiler API objects
  call: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  program: any,
  constMap: Map<string, string>,
  document: OpenApiDocument,
  componentSchemas: Record<string, SchemaObject>,
  relativeFile: string
): void {
  const responsesTypeNode = call.expression.typeArguments[0];
  const responsesMap = extractResponsesMap(responsesTypeNode);
  // A named type argument, such as `withResponses<WidgetResponses>()`, can't be
  // read. Throw rather than skip every status silently.
  if (!responsesMap) {
    throw new Error(
      `applyGeneratedResponseSchemas: ${relativeFile} -- a withResponses<> call's type argument must be an ` +
        'inline object type literal (e.g. `withResponses<{ 200: X }>()`), not a named type alias -- ' +
        "extraction can't resolve one and would otherwise silently skip generating any schema for it."
    );
  }
  const defArg = call.arguments[1];
  if (!defArg || !nestedTs.isObjectLiteralExpression(defArg)) return;

  const { docPath, method } = resolveDocPathAndMethod(defArg, constMap);
  if (!docPath || !method) {
    // eslint-disable-next-line no-console
    console.error(
      `applyGeneratedResponseSchemas: ${relativeFile} -- couldn't statically resolve docPath/method for a ` +
        'withResponses call, skipping it'
    );
    return;
  }

  const pathsRecord = document.paths as unknown as Record<
    string,
    Record<string, ResolvedOperation>
  >;
  // Either level may be missing if the call doesn't match a documented route.
  const pathsForDocPath = pathsRecord[docPath] as
    Record<string, ResolvedOperation> | undefined;
  const operation = pathsForDocPath?.[method];
  if (!operation) {
    // eslint-disable-next-line no-console
    console.error(
      `applyGeneratedResponseSchemas: ${relativeFile} -- ${method.toUpperCase()} ${docPath} has no matching ` +
        'operation in the built document, skipping it'
    );
    return;
  }

  for (const [status, typeNode] of responsesMap) {
    applyGeneratedSchemaForStatus(
      program,
      typeNode,
      status,
      operation,
      componentSchemas,
      { relativeFile, docPath, method }
    );
  }
}

/**
 * Fill in response body schemas from the types given to
 * `defineRoute.withResponses`.
 *
 * @remarks
 * Reads the TypeScript source of each file in `files`, finds its
 * `defineRoute.withResponses<...>()` calls, and sets the response schema for
 * each status on the matching operation, adding the types to
 * `components.schemas`. Response descriptions are left as they are.
 *
 * A call is read only if:
 *
 * - its type argument is an inline object type, such as
 *   `withResponses<{ 200: Widget[] }>()`
 * - each status maps to a named type or interface, or an array of one
 * - the route's `prefix` and `path` are string literals, or string constants
 *   declared in the file or imported from a relative path
 *
 * Other calls, and calls that match no operation in `document`, are skipped.
 * Most skips log a message to `console.error`.
 *
 * A type with a `toJSON()` method is documented by what `toJSON()` returns.
 *
 * @param document - The document from `buildOpenApiDocument`, updated in
 *   place.
 * @param files - Absolute paths of the route files to read. Directories
 *   aren't scanned; `fileLooksLikeItUsesWithResponses` helps filter a listing.
 * @param tsconfigPath - Absolute path to the `tsconfig.json` that resolves
 *   the types in `files`.
 *
 * @throws Error
 * Thrown if a file doesn't exist, if a type argument is a named type instead
 * of an inline object type, if a status maps to an inline type, a union or a
 * generic instantiation, or if a status has no `responses` entry to take its
 * description from.
 *
 * @example
 * ```ts
 * applyGeneratedResponseSchemas(
 *   document,
 *   [path.resolve('src/routes/widgets.ts')],
 *   path.resolve('tsconfig.json')
 * );
 * ```
 */
export function applyGeneratedResponseSchemas(
  document: OpenApiDocument,
  files: readonly string[],
  tsconfigPath: string
): void {
  document.components.schemas ??= {};
  const componentSchemas = document.components.schemas as Record<
    string,
    SchemaObject
  >;

  for (const file of files) {
    const program = createFileProgram(file, tsconfigPath);
    const sourceFile = program.getSourceFile(file);
    // `file` is the program's root, so this can't happen.
    /* c8 ignore next 5 */
    if (!sourceFile) {
      throw new Error(
        `applyGeneratedResponseSchemas: ${file} isn't its own Program's root file`
      );
    }

    const constMap = buildConstMap(program, sourceFile);
    const relativeFile = path.relative(process.cwd(), file);

    for (const call of findWithResponsesCalls(sourceFile)) {
      processWithResponsesCall(
        call,
        program,
        constMap,
        document,
        componentSchemas,
        relativeFile
      );
    }
  }
}

/**
 * Check whether a file mentions `withResponses`, as a quick filter for route
 * files.
 *
 * @param file - Path of the file to read.
 * @returns `true` if the file's text contains `withResponses`.
 */
export function fileLooksLikeItUsesWithResponses(file: string): boolean {
  return fs.readFileSync(file, 'utf8').includes('withResponses');
}
