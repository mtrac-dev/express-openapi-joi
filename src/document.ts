import joiToJsonImport from 'joi-to-json';
import { isReferenceObject } from 'openapi3-ts/oas31';
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

// buildOpenApiDocument always sets `paths` and `components`, so they're
// required here.
export type OpenApiDocument = Omit<OpenAPIObject, 'paths' | 'components'> & {
  paths: PathsObject;
  components: ComponentsObject;
};

// joi-to-json is a CommonJS `module.exports = parse` with no `__esModule`
// marker, so TypeScript doesn't type the default import as callable under
// NodeNext. It works at runtime.
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
 * Replace custom Joi type names in a converted schema with `fallbackType`.
 *
 * @remarks
 * joi-to-json writes a custom Joi extension's type name, such as
 * `phoneNumber`, as the schema's `type`. Client generators read an unknown
 * `type` as a reference to a model that doesn't exist.
 *
 * @param schema - A schema from joi-to-json.
 * @param fallbackType - The JSON Schema type to use instead.
 * @returns A copy of `schema` with every unknown `type` replaced.
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
 * Convert a Joi schema to JSON Schema.
 *
 * @remarks
 * The result has a `schemas` property holding the definitions of any
 * `.id()`'d schemas. Call `convertJoiSchema` instead, which moves them into
 * `components.schemas`.
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
 * Serialize a value with object keys and array elements sorted, to compare
 * two schemas by shape.
 *
 * @remarks
 * The order of a Joi schema's fields decides the order of the converted
 * schema's keys and of its `required` array, so two equal schemas can
 * serialize differently. None of the arrays in a converted schema depend on
 * order. Use the result only for comparison.
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
 * Add a named schema to `components.schemas`.
 *
 * @remarks
 * Adding a schema again under the same name with the same shape does
 * nothing.
 *
 * @param componentSchemas - The document's `components.schemas`, updated in
 *   place.
 * @param name - The component name.
 * @param def - The schema to add.
 * @param sourceDescription - Where the schema came from, for the error
 *   message.
 *
 * @throws Error
 * Thrown if `name` is already used by a schema with a different shape.
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
 * Get the single value a schema allows through `const` or a one-value
 * `enum`.
 *
 * @returns The value, or `undefined` if the schema allows more than one.
 */
function singleLiteralValue(schema: SchemaObject | undefined): unknown {
  // SchemaObject types `const` and `enum` as `any`.
  const constValue = schema?.const as unknown;
  const enumValues = schema?.enum as unknown[] | undefined;
  return (
    constValue ??
    (Array.isArray(enumValues) && enumValues.length === 1
      ? enumValues[0]
      : undefined)
  );
}

/**
 * Fill in `discriminator.mapping` on discriminated unions that don't have
 * one.
 *
 * @remarks
 * Client generators use the mapping to tell a union's variants apart. Call
 * this after `applyGeneratedResponseSchemas`, which generates these unions
 * from TypeScript types that have a `discriminator` JSDoc tag.
 *
 * @param componentSchemas - The document's `components.schemas`, updated in
 *   place. `$ref` entries are skipped, and `undefined` is a no-op.
 *
 * @throws Error
 * Thrown if a variant isn't a `$ref` to a component schema, or if its
 * discriminator property isn't a single string literal, such as a `const`
 * or a one-value `enum`.
 *
 * @example
 * ```ts
 * applyDiscriminatorMappings(document.components.schemas);
 * ```
 */
export function applyDiscriminatorMappings(
  componentSchemas: ComponentsObject['schemas']
): void {
  if (!componentSchemas) {
    return;
  }
  for (const [schemaName, schema] of Object.entries(componentSchemas)) {
    if (
      isReferenceObject(schema) ||
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
      const literalValue = singleLiteralValue(
        variantSchema?.properties?.[propertyName] as SchemaObject | undefined
      );
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
 * Convert a Joi schema to JSON Schema, adding the definitions of its
 * `.id()`'d schemas to `componentSchemas`.
 *
 * @returns The converted schema, without its `schemas` property.
 *
 * @throws Error
 * Thrown if an `.id()` is already used by a schema with a different shape.
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
 * Get an object schema's definition, following a `$ref` into
 * `componentSchemas`.
 *
 * @remarks
 * A converted object schema is a `$ref` when the whole Joi schema has an
 * `.id()`. Call this after `convertJoiSchema`, which adds the target.
 */
function resolveObjectSchema(
  schema: SchemaObject,
  componentSchemas: Record<string, SchemaObject>
): SchemaObject {
  if (!schema.$ref) return schema;
  const parts = schema.$ref.split('/');
  // convertJoiSchema adds a `$ref`'s target before returning it, so this
  // lookup can't miss.
  /* c8 ignore next */
  return componentSchemas[parts[parts.length - 1]] ?? {};
}

// Bounded negated-class quantifier, so no backtracking.
// eslint-disable-next-line sonarjs/super-linear-regex
const PATH_PARAM_RE = /\{([^}]+)\}/g;

/**
 * Build the parameters for the `{name}` segments of `docPath`.
 *
 * @remarks
 * A param's schema comes from `paramsSchema` when it covers that param, and
 * is `{ type: 'string' }` otherwise.
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

/** Build the parameters for a route's `request.query` schema. */
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

/** Build the parameters for a route's `request.headers` schema. */
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
 * Build an operation's responses from a route's `responses`.
 *
 * @remarks
 * A response's `schema` becomes its `application/json` content as-is.
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
 * Merge the responses of two routes registered for the same operation.
 *
 * @remarks
 * When both document the same status, `incoming` replaces `existing`.
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
 * Merge two schemas for the same parameter.
 *
 * @returns `prior` if both have the same shape, otherwise a `oneOf` of the
 *   two. A `oneOf` in `prior` is extended.
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
 * Merge the parameters of two routes registered for the same operation.
 *
 * @remarks
 * Parameters match by name and location. A merged parameter is required if
 * either one is, since a client can't tell which route will handle its
 * request. Different schemas are merged with `mergeParameterSchema`.
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
            // The parameter builders above always set `schema`.
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
 * Merge the request bodies of two routes registered for the same operation.
 *
 * @returns `existing` if it already includes `incoming`'s schema, otherwise
 *   a body whose schema is a `oneOf` of both.
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
  // Every requestBody built here has a schema.
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
 * Build an OpenAPI 3.1 document from registered routes.
 *
 * @remarks
 * Each route's Joi schemas become its parameters and request body. Routes
 * registered more than once for the same method and path become one
 * operation: their parameters, request bodies, tags and security are merged,
 * the last summary is used, and earlier summaries are listed in
 * `description`.
 *
 * @param routeRegistry - The routes to document: `routeRegistry`, one from
 *   `createRouteRegistry()`, or a filtered copy of either.
 * @param options - The document's title and version, plus optional servers,
 *   security schemes and common responses.
 * @returns The OpenAPI document.
 *
 * @throws Error
 * Thrown if two different Joi schemas use the same `.id()`.
 *
 * @example
 * ```ts
 * const document = buildOpenApiDocument(routeRegistry, {
 *   title: 'Widgets API',
 *   version: '1.0.0',
 * });
 * ```
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
    /** The document's `info.title`. */
    title: string;
    /** The document's `info.version`: the API's version. */
    version: string;
    /** URLs for the document's `servers` list. */
    servers?: string[];
    /** Security schemes to add as-is to `components.securitySchemes`. */
    securitySchemes?: Record<string, SecuritySchemeObject>;
    /**
     * Responses to add to every operation, such as the errors an app-wide error
     * handler can return.
     *
     * @remarks
     * A route's own entry for the same status takes precedence.
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

    // Either level may be missing for an operation not seen yet.
    const pathsForDocPath = paths[route.docPath] as
      Record<string, OperationObject> | undefined;
    const existing = pathsForDocPath?.[route.method];
    const operationKey = `${route.docPath} ${route.method}`;

    // Merge with securitySeen, not existing?.security: the emitted operation
    // omits a public-only `[{}]`, and reading that back would drop `'public'`
    // when a later route adds a scheme.
    const security = mergeSecurity(
      securitySeen.get(operationKey),
      route.security
    );
    securitySeen.set(operationKey, security);
    // `[{}]` alone means no security requirement, so it's omitted.
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
      // mergeSecurity never maps a scheme to `undefined`, so this matches
      // openapi3-ts's type.
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
