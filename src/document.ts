import joiToJsonImport from 'joi-to-json';

import { routeRegistry } from './defineRoute.ts';

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

/** joi-to-json's own types declare its return value as `any`. */
function toJsonSchema(schema: unknown): JsonSchema {
  return joiToJson(schema, 'open-api-3.1') as JsonSchema;
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
 * Builds the OpenAPI document from routeRegistry -- every route registered
 * via defineRoute so far. Request schemas convert from the same Joi schemas
 * that actually validate the request, via joi-to-json, so there's nothing
 * to keep in sync by hand. Routes without an explicit `responses` entry
 * just get a generic 200 with no body schema (client method returns void).
 */
export function buildOpenApiDocument({
  title,
  version,
}: {
  title: string;
  version: string;
}): OpenApiDocument {
  const paths: OpenApiDocument['paths'] = {};

  for (const route of routeRegistry) {
    paths[route.docPath] ??= {};
    paths[route.docPath][route.method] = {
      operationId: route.operationId,
      summary: route.summary,
      tags: route.tags,
      parameters: pathParameters(route.docPath, route.request?.params),
      ...(route.request?.body && {
        requestBody: {
          content: {
            'application/json': { schema: toJsonSchema(route.request.body) },
          },
        },
      }),
      responses: route.responses ?? { 200: { description: 'OK' } },
    };
  }

  return {
    openapi: '3.1.0',
    info: { title, version },
    paths,
  };
}
