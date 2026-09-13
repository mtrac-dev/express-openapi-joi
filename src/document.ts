import joiToJsonImport from 'joi-to-json';
import type {
  ComponentsObject,
  OpenAPIObject,
  OperationObject,
  ParameterObject,
  PathsObject,
  RequestBodyObject,
  SchemaObject,
  SecurityRequirementObject as OASSecurityRequirementObject,
  SecuritySchemeObject,
} from 'openapi3-ts/oas31';

import type { AnyRouteDef } from './defineRoute.ts';
import { mergeSecurity } from './security.ts';

// paths/components are optional on the real OpenAPIObject (a document can
// technically have neither), but buildOpenApiDocument always provides both
// -- narrowed back to required so a consumer doesn't have to guard against
// `undefined` for a case that can't actually happen here.
export type OpenApiDocument = Omit<OpenAPIObject, 'paths' | 'components'> & {
  paths: PathsObject;
  components: ComponentsObject;
};

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

/**
 * joi-to-json's own types declare its return value as `any`. A `.id()`'d
 * schema (or one with an `.id()`'d schema nested inside it) also carries a
 * `schemas` companion object, keyed by id, holding each referenced schema's
 * own full definition -- convertJoiSchema (below) is what actually threads
 * that into components.schemas; call sites needing a plain schema value go
 * through it, not this function directly.
 */
function toJsonSchema(
  schema: unknown,
  fallbackType?: string
): SchemaObject & { schemas?: Record<string, SchemaObject> } {
  return normalizeCustomJoiTypes(
    joiToJson(schema, 'open-api-3.1'),
    fallbackType
  ) as SchemaObject & { schemas?: Record<string, SchemaObject> };
}

/**
 * `JSON.stringify` is order-sensitive -- `{a,b}` and `{b,a}` serialize
 * differently even though they're the same shape -- so comparing two
 * schemas via a plain `JSON.stringify(a) === JSON.stringify(b)` spuriously
 * treats identically-shaped schemas as different whenever their keys, or
 * an array like `required` (whose own element order likewise just follows
 * whatever order a Joi schema's fields happened to be declared in), come
 * out in a different order between two structurally-equal Joi schemas.
 * None of the arrays a JSON Schema built from Joi actually contains
 * (`required`, `enum`, `oneOf`, ...) are positionally significant to what
 * they validate, so sorting both object keys and array elements before
 * stringifying compares the actual shape instead of incidental ordering --
 * this is only ever used to compare, never to change what's actually
 * stored or emitted.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    const items = value.map(stableStringify).sort((a, b) => a.localeCompare(b));
    return `[${items.join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b));
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * joi-to-json returns a schema's own converted shape directly UNLESS the
 * Joi schema (or anything nested inside it) carries a `.id(...)` -- then it
 * returns the converted shape (or, when the WHOLE schema is itself id'd,
 * just `{ $ref }`) plus a sibling `schemas` object holding each referenced
 * id's own full definition, keyed by id, meant for `components.schemas`.
 * This merges any such definitions into the shared, document-wide
 * `componentSchemas` accumulator threaded through the whole document build
 * (deduping an identical repeat -- the same `.id()`'d schema converted at
 * another call site -- and throwing on a genuine collision between two
 * differently-shaped schemas sharing an id, so a mistake fails loudly at
 * generation time instead of silently documenting the wrong thing), and
 * returns the schema with `schemas` stripped off, ready to use directly
 * wherever a schema value is needed.
 */
function convertJoiSchema(
  schema: unknown,
  componentSchemas: Record<string, SchemaObject>,
  fallbackType?: string
): SchemaObject {
  const { schemas: refs, ...rest } = toJsonSchema(schema, fallbackType);

  for (const [name, def] of Object.entries(refs ?? {})) {
    const existing = componentSchemas[name] as SchemaObject | undefined;
    if (existing && stableStringify(existing) !== stableStringify(def)) {
      throw new Error(
        `buildOpenApiDocument: two different Joi schemas both used .id('${name}') with different shapes -- give one of them a different id.`
      );
    }
    componentSchemas[name] = def;
  }

  return rest;
}

/**
 * A converted object schema is either the plain shape directly (properties
 * reachable at the top level) or `{ $ref: '#/components/schemas/X' }` (the
 * whole thing was itself `.id()`'d) -- callers that need to look inside an
 * object schema's own properties (path/query/header extraction below) need
 * to dereference the second case via the same componentSchemas map
 * convertJoiSchema just populated.
 */
function resolveObjectSchema(
  schema: SchemaObject,
  componentSchemas: Record<string, SchemaObject>
): SchemaObject {
  if (!schema.$ref) return schema;
  const parts = schema.$ref.split('/');
  // convertJoiSchema always populates componentSchemas with a $ref's target
  // before returning it, so this lookup can't actually miss today -- the
  // `?? {}` is a safety net against a future change to call order, not a
  // case exercised (or exercisable without one) right now.
  /* c8 ignore next */
  return componentSchemas[parts[parts.length - 1]] ?? {};
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
function pathParameters(
  docPath: string,
  paramsSchema: unknown,
  componentSchemas: Record<string, SchemaObject>
): ParameterObject[] {
  const names = [...docPath.matchAll(PATH_PARAM_RE)].map(
    ([, paramName]) => paramName
  );
  if (names.length === 0) return [];

  const paramsJsonSchema = paramsSchema
    ? resolveObjectSchema(
        convertJoiSchema(paramsSchema, componentSchemas),
        componentSchemas
      )
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
function queryParameters(
  querySchema: unknown,
  componentSchemas: Record<string, SchemaObject>
): ParameterObject[] {
  if (!querySchema) return [];

  const queryJsonSchema = resolveObjectSchema(
    convertJoiSchema(querySchema, componentSchemas),
    componentSchemas
  );
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
function headerParameters(
  headersSchema: unknown,
  componentSchemas: Record<string, SchemaObject>
): ParameterObject[] {
  if (!headersSchema) return [];

  const headersJsonSchema = resolveObjectSchema(
    convertJoiSchema(headersSchema, componentSchemas),
    componentSchemas
  );
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
  routeResponses: Record<number, { description: string; schema?: SchemaObject }>
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

function parameterKey(p: ParameterObject) {
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
  existing: ParameterObject[],
  incoming: ParameterObject[]
): ParameterObject[] {
  const merged = new Map(existing.map((p) => [parameterKey(p), p]));
  for (const p of incoming) {
    const key = parameterKey(p);
    const prior = merged.get(key);
    merged.set(
      key,
      prior
        ? { ...prior, required: Boolean(prior.required) || Boolean(p.required) }
        : p
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
  existing: RequestBodyObject | undefined,
  incoming: RequestBodyObject | undefined
): RequestBodyObject | undefined {
  if (!incoming) return existing;
  if (!existing) return incoming;

  const existingSchema = existing.content['application/json']
    .schema as SchemaObject;
  const existingVariants = existingSchema.oneOf ?? [existingSchema];
  // MediaTypeObject.schema is optional per spec, but every requestBody this
  // module builds always sets one -- buildOpenApiDocument only ever calls
  // this with requestBody objects it constructed itself.
  const incomingSchema = incoming.content['application/json']
    .schema as SchemaObject;

  const alreadyPresent = existingVariants.some(
    (s) => stableStringify(s) === stableStringify(incomingSchema)
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
    securitySchemes?: Record<string, SecuritySchemeObject>;
  }
): OpenApiDocument {
  const paths: Record<string, Record<string, OperationObject>> = {};
  const summariesSeen = new Map<string, string[]>();
  const componentSchemas: Record<string, SchemaObject> = {};

  for (const route of routeRegistry) {
    const parameters = [
      ...headerParameters(route.request?.headers, componentSchemas),
      ...pathParameters(route.docPath, route.request?.params, componentSchemas),
      ...queryParameters(route.request?.query, componentSchemas),
    ];
    const requestBody: RequestBodyObject | undefined = route.request?.body
      ? {
          content: {
            'application/json': {
              schema: convertJoiSchema(route.request.body, componentSchemas),
            },
          },
        }
      : undefined;

    // TS's Record indexing doesn't type an absent key as `undefined`
    // (that needs noUncheckedIndexedAccess), so this cast states
    // explicitly what's actually true at runtime for a docPath+method
    // not seen before: paths[route.docPath] itself, and its
    // [route.method] entry, can each genuinely be missing.
    const pathsForDocPath = paths[route.docPath] as
      Record<string, OperationObject> | undefined;
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
      existing?.requestBody as RequestBodyObject | undefined,
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
      parameters: mergeParameters(
        (existing?.parameters as ParameterObject[] | undefined) ?? [],
        parameters
      ),
      ...(mergedRequestBody && { requestBody: mergedRequestBody }),
      responses: responses(route.responses ?? { 200: { description: 'OK' } }),
      // mergeSecurity's own SecurityRequirementObject (security.ts) types each
      // scheme's scope list as `string[] | undefined` (Partial<Record<...>>)
      // to stay a plain, dependency-free type for consumers; it never
      // actually leaves a key mapped to undefined, so this always matches
      // openapi3-ts's stricter (required string[]) version at runtime.
      ...(security.length > 0 &&
        !isOnlyPublic && {
          security: security as OASSecurityRequirementObject[],
        }),
    };
  }

  return {
    openapi: '3.1.0',
    info: { title, version },
    ...(servers && { servers: servers.map((url) => ({ url })) }),
    paths,
    components: {
      ...(Object.keys(securitySchemes).length > 0 && { securitySchemes }),
      ...(Object.keys(componentSchemas).length > 0 && {
        schemas: componentSchemas,
      }),
    },
  };
}
