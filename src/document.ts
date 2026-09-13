import joiToJsonImport from 'joi-to-json';

import type { AnyRouteDef } from './defineRoute.ts';
import { mergeSecurity, type SecurityRequirementObject } from './security.ts';

interface Parameter {
  name: string;
  in: string;
  required: boolean;
  schema: unknown;
}

interface RequestBody {
  content: { 'application/json': { schema: unknown } };
}

interface Operation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters: Parameter[];
  requestBody?: RequestBody;
  responses: Record<string, unknown>;
  security?: SecurityRequirementObject[];
}

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string };
  servers?: { url: string }[];
  paths: Record<string, Record<string, Operation>>;
  components: { securitySchemes: Record<string, unknown> };
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

// Bounded negated-class quantifier between two literal braces -- no
// backtracking ambiguity.
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
function pathParameters(docPath: string, paramsSchema?: unknown): Parameter[] {
  const names = [...docPath.matchAll(PATH_PARAM_RE)].map(
    ([, paramName]) => paramName
  );
  if (names.length === 0) return [];

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
function queryParameters(querySchema?: unknown): Parameter[] {
  if (!querySchema) return [];

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
function headerParameters(headersSchema?: unknown): Parameter[] {
  if (!headersSchema) return [];

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

function parameterKey(p: Parameter) {
  return `${p.in}:${p.name}`;
}

/**
 * Unions parameters across every defineRoute registration sharing a
 * docPath+method, rather than letting the last one silently overwrite the
 * others -- the same problem `security` was already merged for, just for
 * path/query/header parameters instead. `required` is true if ANY
 * registration requires it: a caller who doesn't know in advance which
 * one will actually run (that's a server-side decision, e.g. which
 * auth/role branch applies) is safer over-providing a param some
 * registrations don't need than omitting one another requires.
 */
function mergeParameters(
  existing: Parameter[],
  incoming: Parameter[]
): Parameter[] {
  const merged = new Map(existing.map((p) => [parameterKey(p), p]));
  for (const p of incoming) {
    const key = parameterKey(p);
    const prior = merged.get(key);
    merged.set(
      key,
      prior ? { ...prior, required: prior.required || p.required } : p
    );
  }
  return [...merged.values()];
}

/**
 * Same idea as mergeParameters, but for requestBody: if every registration
 * sharing a docPath+method validates the identical body schema (the
 * common case), this collapses right back down to that one schema. Only
 * wraps in oneOf when registrations genuinely validate different shapes.
 */
function mergeRequestBody(
  existing: RequestBody | undefined,
  incoming: RequestBody | undefined
) {
  if (!incoming) return existing;
  if (!existing) return incoming;

  const existingSchema = existing.content['application/json'].schema as {
    oneOf?: unknown[];
  };
  const existingVariants: unknown[] = existingSchema.oneOf ?? [existingSchema];
  const incomingSchema = incoming.content['application/json'].schema;

  const alreadyPresent = existingVariants.some(
    (s) => JSON.stringify(s) === JSON.stringify(incomingSchema)
  );
  if (alreadyPresent) return existing;

  return {
    content: {
      'application/json': {
        schema: { oneOf: [...existingVariants, incomingSchema] },
      },
    },
  };
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
 *
 * A docPath+method can have more than one defineRoute registration --
 * e.g. a role-gated route that falls through to a different handler per
 * caller. OpenAPI has no way to represent "N different operations live
 * at this one path+method" (a caller can't select between them; which
 * one actually runs is a server-side decision), so every such stack
 * collapses into one operation here, merging what can be merged
 * (parameters, requestBody, security, tags) rather than letting whichever
 * registration runs last in routeRegistry iteration order silently
 * overwrite the others' contribution -- a route's `security` could
 * otherwise end up describing a completely different, discarded
 * registration than its own `operationId`/`summary`. `operationId`/
 * `summary` still can't be anything other than one value each (a
 * generated client needs exactly one method name per operation) --
 * summary keeps the last-registered one's, same precedent `security`
 * already sets; every other summary in the stack survives instead in
 * `description`, rather than vanishing.
 */
export function buildOpenApiDocument(
  routeRegistry: readonly AnyRouteDef[],
  {
    title,
    version,
    servers,
    securitySchemes = {},
  }: {
    title: string;
    version: string;
    servers?: string[];
    securitySchemes?: Record<string, unknown>;
  }
): OpenApiDocument {
  const paths: OpenApiDocument['paths'] = {};
  const summariesSeen = new Map<string, string[]>();

  for (const route of routeRegistry) {
    const parameters = [
      ...headerParameters(route.request?.headers),
      ...pathParameters(route.docPath, route.request?.params),
      ...queryParameters(route.request?.query),
    ];
    const requestBody: RequestBody | undefined = route.request?.body
      ? {
          content: {
            'application/json': { schema: toJsonSchema(route.request.body) },
          },
        }
      : undefined;

    // TS's Record indexing doesn't type an absent key as `undefined`
    // (that needs noUncheckedIndexedAccess), so this cast states
    // explicitly what's actually true at runtime for a docPath+method
    // not seen before: paths[route.docPath] itself, and its
    // [route.method] entry, can each genuinely be missing.
    const pathsForDocPath = paths[route.docPath] as
      Record<string, Operation> | undefined;
    const existing = pathsForDocPath?.[route.method];

    const security = mergeSecurity(existing?.security, route.security);
    // A merged result of just `[{}]` ("public" and nothing else) is the
    // same as no security requirement at all -- omit the key entirely
    // rather than clutter every undocumented route with a redundant one.
    const isOnlyPublic =
      security.length === 1 && Object.keys(security[0]).length === 0;

    const operationKey = `${route.docPath} ${route.method}`;
    const summaries = summariesSeen.get(operationKey) ?? [];
    if (route.summary && !summaries.includes(route.summary))
      summaries.push(route.summary);
    summariesSeen.set(operationKey, summaries);
    const olderSummaries = summaries.slice(0, -1);

    const tags = [
      ...new Set([...(existing?.tags ?? []), ...(route.tags ?? [])]),
    ];
    const mergedRequestBody = mergeRequestBody(
      existing?.requestBody,
      requestBody
    );

    paths[route.docPath] ??= {};
    paths[route.docPath][route.method] = {
      operationId: route.operationId,
      summary: route.summary ?? existing?.summary,
      ...(olderSummaries.length > 0 && {
        description: `Behavior varies by caller. Also available: ${olderSummaries.join('; ')}`,
      }),
      ...(tags.length > 0 && { tags }),
      parameters: mergeParameters(existing?.parameters ?? [], parameters),
      ...(mergedRequestBody && { requestBody: mergedRequestBody }),
      responses: responses(route.responses ?? { 200: { description: 'OK' } }),
      ...(security.length > 0 && !isOnlyPublic && { security }),
    };
  }

  return {
    openapi: '3.1.0',
    info: { title, version },
    ...(servers && { servers: servers.map((url) => ({ url })) }),
    paths,
    components: { securitySchemes },
  };
}
