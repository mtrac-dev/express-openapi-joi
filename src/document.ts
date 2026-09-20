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
import { mergeSecurity, type SecurityRequirementObject } from './security.ts';

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
 * Merges one named schema into the shared, document-wide `componentSchemas`
 * accumulator -- deduping identical repeats (the same name registered twice
 * with the same shape, e.g. a `.id()`'d Joi schema converted at another call
 * site) and throwing on a genuine collision between two differently-shaped
 * schemas sharing a name, so a mistake fails loudly at generation time
 * instead of silently documenting the wrong thing. Exported so any other
 * source of named component schemas (e.g. a TypeScript-type-driven response
 * generator) can reuse the exact same dedupe-or-throw rule against the same
 * `components.schemas`, rather than each maintaining its own copy.
 */
export function mergeComponentSchema(
  componentSchemas: Record<string, SchemaObject>,
  name: string,
  def: SchemaObject,
  sourceDescription: string
): void {
  const existing = componentSchemas[name] as SchemaObject | undefined;
  if (existing && stableStringify(existing) !== stableStringify(def)) {
    throw new Error(
      `mergeComponentSchema: two different schemas both used the component name '${name}' with different shapes (${sourceDescription}) -- give one of them a different name.`
    );
  }
  componentSchemas[name] = def;
}

const COMPONENT_SCHEMA_REF_RE = /^#\/components\/schemas\/(.+)$/;

/**
 * A TypeScript union response type generated via `.../typegen`'s
 * `generateResponseSchema` -- given a `@discriminator <propertyName>` JSDoc
 * tag and `discriminatorType: 'open-api'` -- comes out as a real OpenAPI
 * `{ discriminator: { propertyName }, oneOf }` shape, but the generator
 * never populates `discriminator.mapping` (the part that says which
 * literal discriminator value corresponds to which `oneOf` variant).
 * Without it, a generated client can't build the discriminator's
 * value->variant switch at all -- every case falls through to a default,
 * and the union itself can come out as a bare, uninstantiable type, even
 * though each variant's own shape generates correctly.
 *
 * Generic over every discriminated union in `componentSchemas` (not
 * hardcoded to one type name): for any schema shaped like the above with
 * no `mapping` of its own already, derives one by reading each `oneOf`
 * variant's own discriminator-property literal (a JSON Schema `const`, or
 * a single-value `enum`) -- throwing, not skipping, if a variant doesn't
 * actually narrow that property to one literal value, since a mapping
 * this function silently left off would leave that variant unreachable at
 * runtime exactly as if this fix were never applied.
 *
 * Call this AFTER merging in any typegen-generated schemas (e.g. via
 * ./typegen's `applyGeneratedResponseSchemas`) -- a discriminated union
 * that only exists because of that step isn't in `componentSchemas` yet
 * if this runs any earlier.
 */
export function applyDiscriminatorMappings(
  componentSchemas: Record<string, SchemaObject>
): void {
  for (const [schemaName, schema] of Object.entries(componentSchemas)) {
    if (
      !schema.discriminator ||
      schema.discriminator.mapping ||
      !Array.isArray(schema.oneOf)
    ) {
      continue;
    }

    const { propertyName } = schema.discriminator;
    const mapping: Record<string, string> = {};
    for (const variant of schema.oneOf) {
      const ref = variant.$ref;
      const match = ref?.match(COMPONENT_SCHEMA_REF_RE);
      if (!ref || !match) {
        throw new Error(
          `applyDiscriminatorMappings: '${schemaName}' has a non-$ref oneOf entry -- every discriminated union variant must be a named, referenced schema.`
        );
      }
      const [, variantName] = match;
      const variantSchema = componentSchemas[variantName] as
        SchemaObject | undefined;
      const propSchema = variantSchema?.properties?.[propertyName] as
        SchemaObject | undefined;
      // SchemaObject's own `const`/`enum` fields are typed `any` (they can
      // genuinely hold any JSON value) -- narrowed to `unknown` here since
      // only a single string literal is ever a valid discriminator value.
      const constValue = propSchema?.const as unknown;
      const enumValues = propSchema?.enum as unknown[] | undefined;
      const literalValue =
        constValue ??
        (Array.isArray(enumValues) && enumValues.length === 1
          ? enumValues[0]
          : undefined);
      if (typeof literalValue !== 'string') {
        throw new Error(
          `applyDiscriminatorMappings: '${schemaName}''s variant '${variantName}' doesn't narrow its own '${propertyName}' property to a single string literal -- can't derive a discriminator mapping entry for it.`
        );
      }
      mapping[literalValue] = ref;
    }
    schema.discriminator.mapping = mapping;
  }
}

/**
 * joi-to-json returns a schema's own converted shape directly UNLESS the
 * Joi schema (or anything nested inside it) carries a `.id(...)` -- then it
 * returns the converted shape (or, when the WHOLE schema is itself id'd,
 * just `{ $ref }`) plus a sibling `schemas` object holding each referenced
 * id's own full definition, keyed by id, meant for `components.schemas`.
 * This merges any such definitions into the shared, document-wide
 * `componentSchemas` accumulator (see mergeComponentSchema above) and
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
    mergeComponentSchema(
      componentSchemas,
      name,
      def,
      `Joi schema .id('${name}')`
    );
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

/**
 * Same idea as mergeParameters/mergeRequestBody, but for responses: without
 * this, one registration's own responses (e.g. a role-gated 403) silently
 * vanished behind whatever the last-registered registration in the stack
 * documented, since `responses` was overwritten wholesale rather than
 * merged like every other field sharing a docPath+method. Only unions
 * distinct status codes -- two registrations that both document the SAME
 * status code with a different schema still just have the later one win,
 * same as mergeRequestBody's behavior before it added oneOf-wrapping;
 * left that as a follow-up for if it's ever actually needed, since it
 * hasn't come up.
 */
function mergeResponses(
  existing: OperationObject['responses'],
  incoming: OperationObject['responses']
): OperationObject['responses'] {
  return { ...existing, ...incoming };
}

function parameterKey(p: ParameterObject) {
  return `${p.in}:${p.name}`;
}

/**
 * Same idea as mergeRequestBody's oneOf-wrap, but for one parameter's own
 * schema: without this, mergeParameters below would silently keep
 * whichever registration's schema it happened to see first for a given
 * name+location, even when a later registration in the same docPath+method
 * stack validates that parameter differently (e.g. one registration's
 * `:id` is a UUID string, another's is a plain number) -- discarding that
 * registration's schema entirely rather than documenting both.
 */
function mergeParameterSchema(
  prior: SchemaObject,
  incoming: SchemaObject
): SchemaObject {
  if (stableStringify(prior) === stableStringify(incoming)) return prior;

  const priorVariants = prior.oneOf ?? [prior];
  return { oneOf: [...priorVariants, incoming] };
}

/**
 * Unions parameters across every defineRoute registration sharing a
 * docPath+method, rather than letting the last one silently overwrite the
 * others -- the same problem `security` was already merged for, just for
 * path/query/header parameters instead. `required` is true if ANY
 * registration requires it: a caller who doesn't know in advance which
 * one will actually run (that's a server-side decision, e.g. which
 * auth/role branch applies) is safer over-providing a param some
 * registrations don't need than omitting one another requires. A
 * differing `schema` for the same name+location also merges (see
 * mergeParameterSchema above), rather than only `required` being
 * reconciled and a later registration's own schema silently discarded.
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
        ? {
            ...prior,
            required: Boolean(prior.required) || Boolean(p.required),
            // ParameterObject.schema is optional per spec, but
            // pathParameters/queryParameters/headerParameters (the only
            // builders of a ParameterObject in this module) always set one.
            schema: mergeParameterSchema(
              prior.schema as SchemaObject,
              p.schema as SchemaObject
            ),
          }
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
 * joi-to-json, so there's nothing to keep in sync by hand. A route
 * without an explicit `responses` entry documents no success status at
 * all (client method returns void) -- never a fabricated 200, which would
 * misdocument a route whose real success status isn't 200.
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
    commonResponses,
  }: {
    title: string;
    version: string;
    servers?: string[];
    securitySchemes?: Record<string, SecuritySchemeObject>;
    /**
     * Responses to merge into EVERY operation's own `responses` -- e.g. the
     * 400/404/500 an app-wide error handler can produce for literally any
     * request, regardless of which defineRoute registration (if any)
     * actually ran. OpenAPI still wants these documented per-operation (a
     * caller reading one endpoint's spec has no way to know they also
     * apply), and repeating the same entries on every single defineRoute
     * call would just be copy-pasted boilerplate. A route's own `responses`
     * entry wins on a status-code collision -- it's describing something
     * more specific than the generic app-wide one.
     */
    commonResponses?: Record<
      number,
      { description: string; schema?: SchemaObject }
    >;
  }
): OpenApiDocument {
  const paths: Record<string, Record<string, OperationObject>> = {};
  const summariesSeen = new Map<string, string[]>();
  const securitySeen = new Map<string, SecurityRequirementObject[]>();
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
    const operationKey = `${route.docPath} ${route.method}`;

    // Reads/writes securitySeen rather than existing?.security, because
    // the emitted operation below omits `security` entirely when the
    // merged result is only `[{}]` ("public") -- if a later registration
    // in this same docPath+method stack then read that omission back as
    // "nothing stated yet", it would silently lose the fact that `public`
    // was ever a valid alternative (order-dependent: registering `public`
    // then a real scheme would drop `public`; the reverse order wouldn't).
    // securitySeen always keeps the true merged result across the whole
    // stack, independent of what the emitted operation below chooses to
    // display.
    const security = mergeSecurity(
      securitySeen.get(operationKey),
      route.security
    );
    securitySeen.set(operationKey, security);
    // A merged result of just `[{}]` ("public" and nothing else) is the
    // same as no security requirement at all -- omit the key entirely
    // rather than clutter every undocumented route with a redundant one.
    const isOnlyPublic =
      security.length === 1 && Object.keys(security[0]).length === 0;

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
      responses: mergeResponses(
        existing?.responses,
        responses({ ...commonResponses, ...route.responses })
      ),
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
