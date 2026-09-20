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
 * True for `defineRoute.withResponses<Responses>()(router, def)` -- the
 * only call shape that carries a `Responses` type argument to read. Plain
 * `defineRoute(router, def)` calls (no compile-time response checking) are
 * left alone entirely; nothing here ever touches their `responses` field.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a nested-typescript AST node, not this project's own typescript's type
function isWithResponsesCall(node: any): boolean {
  if (!nestedTs.isCallExpression(node)) return false;
  const callee = node.expression;
  return (
    nestedTs.isCallExpression(callee) &&
    nestedTs.isPropertyAccessExpression(callee.expression) &&
    nestedTs.isIdentifier(callee.expression.expression) &&
    callee.expression.expression.text === 'defineRoute' &&
    callee.expression.name.text === 'withResponses' &&
    // withResponses<Responses>() has no default for Responses, so any
    // call site that actually type-checks always has exactly one type
    // argument here -- this guards against a malformed/non-type-checked
    // source file having some other count, not a shape reachable from any
    // real TypeScript program.
    /* c8 ignore next */
    (callee.typeArguments?.length ?? 0) === 1
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a nested-typescript ts.SourceFile/AST node array, not this project's own typescript's type
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

/** status (`200`) -> the response type's own AST node (`Widget`, `Widget[]`, ...). */
function extractResponsesMap(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a nested-typescript AST node, not this project's own typescript's type
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

/** Every top-level `const NAME = <expr>;` in the file -- the only shape defineRoute calls here build docPath from. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a nested-typescript ts.SourceFile, not this project's own typescript's type
function buildConstMap(sourceFile: any): Map<string, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const constMap = new Map<string, any>();
  for (const statement of sourceFile.statements) {
    if (nestedTs.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          nestedTs.isIdentifier(declaration.name) &&
          declaration.initializer
        ) {
          constMap.set(declaration.name.text, declaration.initializer);
        }
      }
    }
  }
  return constMap;
}

/**
 * Statically evaluates the handful of expression shapes `method`/`path`/
 * `prefix` actually use across a typical defineRoute call: a plain string
 * literal, a local `const` reference to one (resolved via `constMap`), or
 * a template expression combining the two (e.g. `` `${cartPrefix}/migrate` ``).
 * Anything else -- a function call, a computed member access, ... --
 * returns `undefined` rather than guessing.
 */
function resolveStringExpression(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a nested-typescript AST node, not this project's own typescript's type
  expr: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constMap: Map<string, any>
): string | undefined {
  if (nestedTs.isStringLiteralLike(expr)) return expr.text;
  if (nestedTs.isIdentifier(expr)) {
    const initializer = constMap.get(expr.text);
    return initializer
      ? resolveStringExpression(initializer, constMap)
      : undefined;
  }
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

function getObjectLiteralStringProp(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a nested-typescript ObjectLiteralExpression, not this project's own typescript's type
  obj: any,
  propName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constMap: Map<string, any>
): string | undefined {
  const prop = obj.properties.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a nested-typescript AST node, not this project's own typescript's type
    (p: any) =>
      nestedTs.isPropertyAssignment(p) &&
      nestedTs.isIdentifier(p.name) &&
      p.name.text === propName
  );
  return prop ? resolveStringExpression(prop.initializer, constMap) : undefined;
}

/**
 * Reproduces defineRoute's own `docPath = (prefix ?? '') + pathToDocSegment(path)`
 * (see ../defineRoute.ts), from the def object literal's own AST instead of
 * running it.
 */
function resolveDocPathAndMethod(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a nested-typescript ObjectLiteralExpression, not this project's own typescript's type
  defArg: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constMap: Map<string, any>
): { docPath?: string; method?: string } {
  const method = getObjectLiteralStringProp(defArg, 'method', constMap);
  const prefix = getObjectLiteralStringProp(defArg, 'prefix', constMap);
  const routePath = getObjectLiteralStringProp(defArg, 'path', constMap);
  if (routePath === undefined) return { method };
  return { docPath: `${prefix ?? ''}${pathToDocSegment(routePath)}`, method };
}

// document.paths is typed against real OpenAPI shapes (no generic string
// index into a PathItemObject's own named method properties, and
// `responses` itself is optional per the general spec), but every path
// this module reads back was built by buildOpenApiDocument itself, which
// always keys each path's entry by real HTTP method names and always sets
// `responses` -- safe to read back that way in the functions below.
type ResolvedOperation = OperationObject & {
  responses: Record<string, { description: string }>;
};

/**
 * Generates and applies one status's schema, once its operation has
 * already been resolved -- split out of processWithResponsesCall purely to
 * keep that function's own complexity down.
 */
function applyGeneratedSchemaForStatus(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a nested-typescript ts.Program, not this project's own typescript's type
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

  // `responses` is optional on RouteDef, and nothing type-checks that its
  // keys line up with Responses' own -- a status declared in
  // withResponses<{...}> with no matching responses[status] entry is
  // exactly the same "what does this actually mean" gap document.ts no
  // longer papers over for an undocumented route (see the commit removing
  // its fabricated-200 default). Erroring here, not defaulting a
  // description, is what makes that gap visible instead of silently
  // inventing one.
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
 * Resolves and processes one `defineRoute.withResponses<>()` call site --
 * split out of applyGeneratedResponseSchemas purely to keep that
 * function's own complexity down.
 */
function processWithResponsesCall(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a nested-typescript AST node, not this project's own typescript's type
  call: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  program: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constMap: Map<string, any>,
  document: OpenApiDocument,
  componentSchemas: Record<string, SchemaObject>,
  relativeFile: string
): void {
  const responsesTypeNode = call.expression.typeArguments[0];
  const responsesMap = extractResponsesMap(responsesTypeNode);
  // extractResponsesMap only resolves an inline `{...}` object type
  // literal -- a named type alias (`withResponses<SomeAlias>()`) is a
  // TypeReferenceNode, not a TypeLiteralNode, and would otherwise silently
  // produce no schema at all for every status in it. That's the same
  // "gap masquerading as success" this module already refuses to allow
  // for a missing description below -- loud here too, not a silent skip.
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
  // TS's Record indexing doesn't type an absent key as `undefined` (that
  // needs noUncheckedIndexedAccess) -- this cast states explicitly what's
  // actually true at runtime for a docPath+method this pass can't
  // statically resolve to a real operation in the built document: both
  // levels can genuinely be missing.
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
 * Runs the extraction (AST) + generation (schemaGenerator.ts) pass over
 * every given file that uses `defineRoute.withResponses`, and fills in
 * `responses[status].content` on the ALREADY-BUILT OpenAPI document for
 * any (docPath, method, status) it can resolve a schema for -- as a post-
 * process on `buildOpenApiDocument`'s own output, rather than threading a
 * second accumulator through document.ts itself. Only ever ADDS/overwrites
 * a response's `content.schema`; the `description` a route (or
 * `commonResponses`) already gave that status is left untouched.
 *
 * A docPath+method a stack of registrations shares (e.g. a role-gated
 * route falling through to a different handler per caller) naturally
 * generates the same schema from each of its own `withResponses` call
 * sites -- `mergeComponentSchema`'s existing dedupe-or-throw check (the
 * same one document.ts already uses for Joi `.id()` collisions) is what
 * catches it if two registrations sharing a key ever disagree, rather than
 * silently keeping whichever one happened to run last.
 *
 * @param document The document buildOpenApiDocument already built, mutated
 *   in place.
 * @param files Absolute paths to every file that might contain a
 *   `defineRoute.withResponses<>` call. This module doesn't scan a
 *   directory itself -- pass the exact set of files your own route
 *   registration lives in (e.g. via your own `fs.readdirSync` over
 *   whichever directory that is in your project).
 * @param tsconfigPath Absolute path to the tsconfig.json whose
 *   compilerOptions resolve `files`' own types.
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
    // createFileProgram builds its Program from exactly [file] as the
    // root -- confirmed empirically that TS's own path normalization
    // reconciles a relative `file` against the same canonical entry
    // either way, so this hasn't been reproducible with any real input;
    // kept as a guard against a future createFileProgram change that
    // stops guaranteeing that, rather than assuming it silently.
    /* c8 ignore next 5 */
    if (!sourceFile) {
      throw new Error(
        `applyGeneratedResponseSchemas: ${file} isn't its own Program's root file`
      );
    }

    const constMap = buildConstMap(sourceFile);
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

// Re-exported so a consumer's own directory-scan (see the `files` param
// doc above) can filter to just the files worth parsing, the same
// substring check this module's own development used to verify against.
export function fileLooksLikeItUsesWithResponses(file: string): boolean {
  return fs.readFileSync(file, 'utf8').includes('withResponses');
}
