import joiToJsonImport from 'joi-to-json';

import type { AnyRouteDef } from './defineRoute.ts';

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, unknown>>;
}

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
}

// joi-to-json is a plain CommonJS `module.exports = parse` -- no
// `__esModule`/default marker for NodeNext's stricter interop rules to key
// off of, so TS doesn't reliably resolve the default import as callable
// here even though esModuleInterop is on and Node's own real interop binds
// it correctly at runtime. Recast to the one signature actually used.
const joiToJson = joiToJsonImport as unknown as (
  schema: unknown,
  mode: string
) => unknown;

const JSON_SCHEMA_TYPES = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'object',
  'array',
  'null',
]);

/**
 * joi-to-json emits a custom Joi extension's own type name verbatim (e.g.
 * a phone-number extension's `type: 'phoneNumber'`) rather than the
 * underlying JSON Schema primitive it's actually built on. An OpenAPI
 * generator then reads that as an implicit reference to a model that was
 * never defined anywhere, breaking the generated client's own build.
 * `fallbackType` defaults to 'string' (the common case for a Joi
 * extension), but is overridable for one built on something else.
 */
function normalizeCustomJoiTypes(
  schema: unknown,
  fallbackType = 'string'
): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => normalizeCustomJoiTypes(item, fallbackType));
  }
  if (schema === null || typeof schema !== 'object') return schema;

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    normalized[key] = normalizeCustomJoiTypes(value, fallbackType);
  }
  if (
    typeof normalized.type === 'string' &&
    !JSON_SCHEMA_TYPES.has(normalized.type)
  ) {
    normalized.type = fallbackType;
  }
  return normalized;
}

/** joi-to-json's own types declare its return value as `any`. */
function toJsonSchema(schema: unknown, fallbackType?: string): JsonSchema {
  return normalizeCustomJoiTypes(
    joiToJson(schema, 'open-api-3.1'),
    fallbackType
  ) as JsonSchema;
}

// A single bounded negated-class quantifier between two literal braces --
// no ambiguity for backtracking to explore.
// eslint-disable-next-line sonarjs/super-linear-regex
const PATH_PARAM_RE = /\{([^}]+)\}/g;

/**
 * Path params declared in `docPath` (e.g. `{id}`) need an explicit OpenAPI
 * `parameters` entry to be treated as real, substitutable parameters by
 * tooling -- without one, a generated client has no way to know `{id}`
 * isn't just literal text in the URL. If `request.params` has a Joi schema
 * (an object schema keyed by param name), pull each param's own schema
 * from it via joi-to-json; otherwise fall back to a bare string, which is
 * still enough for a generated client to expose it as a real method argument.
 */
function pathParameters(docPath: string, paramsSchema?: unknown) {
  const names = [...docPath.matchAll(PATH_PARAM_RE)].map(
    ([, paramName]) => paramName
  );
  if (names.length === 0) return undefined;

  const paramsJsonSchema = paramsSchema
    ? toJsonSchema(paramsSchema)
    : undefined;

  return names.map((paramName) => ({
    name: paramName,
    in: 'path',
    required: true,
    schema: paramsJsonSchema?.properties?.[paramName] ?? { type: 'string' },
  }));
}

/**
 * Same idea as pathParameters, but for `request.query` -- without this, a
 * route validated only by a query schema (no path params, no body) gets no
 * OpenAPI parameters at all, and a generated client method ends up with no
 * way to pass query values through.
 */
function queryParameters(querySchema?: unknown) {
  if (!querySchema) return undefined;

  const queryJsonSchema = toJsonSchema(querySchema);
  const required = queryJsonSchema.required ?? [];

  return Object.entries(queryJsonSchema.properties ?? {}).map(
    ([paramName, schema]) => ({
      name: paramName,
      in: 'query',
      required: required.includes(paramName),
      schema,
    })
  );
}

/**
 * Same idea as pathParameters/queryParameters, but for `request.headers`.
 * defineRoute already validates headers against this schema at runtime
 * (via headerValidator) -- this is just the document-side counterpart.
 */
function headerParameters(headersSchema?: unknown) {
  if (!headersSchema) return undefined;

  const headersJsonSchema = toJsonSchema(headersSchema);
  const required = headersJsonSchema.required ?? [];

  return Object.entries(headersJsonSchema.properties ?? {}).map(
    ([paramName, schema]) => ({
      name: paramName,
      in: 'header',
      required: required.includes(paramName),
      schema,
    })
  );
}

/**
 * Response bodies have no runtime (Joi) schema to convert -- unlike
 * request validation, `responses[status].schema` (when present) is
 * already a plain JSON Schema object, authored by hand on the defineRoute
 * call. Without it, a generated client's method has nothing to
 * deserialize the response into and just discards the body.
 */
function responses(
  routeResponses: Record<number, { description: string; schema?: unknown }>
) {
  return Object.fromEntries(
    Object.entries(routeResponses).map(([status, { description, schema }]) => [
      status,
      {
        description,
        ...(schema ? { content: { 'application/json': { schema } } } : {}),
      },
    ])
  );
}

/**
 * Builds the OpenAPI document from a route registry -- every route
 * registered via defineRoute against it so far (see
 * createRouteRegistry(), which binds this to its own registry so a
 * caller doesn't have to pass one explicitly). Request schemas convert
 * from the same Joi schemas that actually validate the request, via
 * joi-to-json, so there's nothing to keep in sync by hand. Routes
 * without an explicit `responses` entry just get a generic 200 with no
 * body schema (client method returns void).
 */
export function buildOpenApiDocument(
  routeRegistry: readonly AnyRouteDef[],
  { title, version }: { title: string; version: string }
): OpenApiDocument {
  const paths: OpenApiDocument['paths'] = {};

  for (const route of routeRegistry) {
    const parameters = [
      ...(headerParameters(route.request?.headers) ?? []),
      ...(pathParameters(route.docPath, route.request?.params) ?? []),
      ...(queryParameters(route.request?.query) ?? []),
    ];

    paths[route.docPath] ??= {};
    paths[route.docPath][route.method] = {
      operationId: route.operationId,
      summary: route.summary,
      tags: route.tags,
      parameters,
      ...(route.request?.body && {
        requestBody: {
          content: {
            'application/json': { schema: toJsonSchema(route.request.body) },
          },
        },
      }),
      responses: responses(route.responses ?? { 200: { description: 'OK' } }),
    };
  }

  return {
    openapi: '3.1.0',
    info: { title, version },
    paths,
  };
}
