import type express from 'express';
import type { Schema } from 'joi';

import {
  bodyValidator,
  headerValidator,
  paramValidator,
  queryValidator,
} from './validators.ts';
import { buildOpenApiDocument } from './document.ts';
import type { Provider } from './provider.ts';
import {
  inferSecurity,
  type SecurityRequirement,
  type SecurityScheme,
} from './security.ts';

/**
 * The `req.params` type for an Express path literal, read from its `:name`
 * segments.
 *
 * @remarks
 * Only string literal paths can be read. A route mounted with a RegExp path,
 * or one that inherits params through `mergeParams`, needs `params` instead.
 */
type ExtractRouteParams<Path extends string> =
  Path extends `${string}:${infer Param}/${infer Rest}`
    ? Record<Param | keyof ExtractRouteParams<`/${Rest}`>, string>
    : Path extends `${string}:${infer Param}`
      ? Record<Param, string>
      : Record<string, never>;

type ParamsFromNames<Names extends readonly string[]> = Record<
  Names[number],
  string
>;

// Compare with an empty tuple, not `undefined`: under a loose tsconfig,
// `undefined extends T` is true for most T.
type ResolvedParams<
  Path extends string,
  ParamNames extends readonly string[],
> = ParamNames extends readonly []
  ? ExtractRouteParams<Path>
  : ParamsFromNames<ParamNames>;

type InferJoi<S> = S extends Schema<infer T> ? T : never;

// The default `Responses`, for routes with no response types. Detect it with
// `keyof Responses extends never`, not `undefined`, for the same reason as
// ResolvedParams.
// eslint-disable-next-line @typescript-eslint/no-generated-empty-object-type -- an empty sentinel type
type EmptyResponses = Record<never, never>;

/**
 * Express's `res`, with `status(code)` narrowed to the body type mapped to
 * `code`.
 *
 * @remarks
 * `res.status(200).json(body)` accepts only the 200 body type. A status that
 * isn't a number literal, or a bare `res.json(body)`, accepts any of the
 * mapped body types.
 */
type TypedRouteResponse<
  ResponseMap extends Record<number, unknown>,
  Locals extends object,
> = Omit<
  express.Response<ResponseMap[keyof ResponseMap], Locals>,
  'status' | 'json' | 'send'
> & {
  json(body: ResponseMap[keyof ResponseMap]): express.Response;
  send(body: ResponseMap[keyof ResponseMap]): express.Response;
  status<S extends keyof ResponseMap & number>(
    code: S
  ): {
    json(body: ResponseMap[S]): express.Response;
    send(body: ResponseMap[S]): express.Response;
  };
};

type RouteHandler<
  Path extends string,
  ParamNames extends readonly string[],
  Body extends Schema | undefined,
  Query extends Schema | undefined,
  Locals extends object,
  Responses extends Record<number, unknown>,
> = keyof Responses extends never
  ? express.RequestHandler<
      ResolvedParams<Path, ParamNames>,
      unknown,
      InferJoi<Body>,
      InferJoi<Query>,
      Locals
    >
  : (
      // `void`, like express.RequestHandler: a `void` return type accepts an
      // async handler, but `void | Promise<void>` rejects one that returns
      // `res.json(...)`.
      req: express.Request<
        ResolvedParams<Path, ParamNames>,
        unknown,
        InferJoi<Body>,
        InferJoi<Query>,
        Locals
      >,
      res: TypedRouteResponse<Responses, Locals>,
      next: express.NextFunction
    ) => void;

/**
 * Convert an Express route path to OpenAPI path syntax.
 *
 * @remarks
 * Use this in tooling that needs the same document paths `defineRoute`
 * produces.
 *
 * @param path - An Express path, such as `/:id` or `/:id(\d+)?`.
 * @returns The path with each param written as `{name}`, or `''` for `/`.
 *
 * @example
 * ```ts
 * pathToDocSegment('/:cartId/items/:itemId?'); // '/{cartId}/items/{itemId}'
 * ```
 */
export function pathToDocSegment(path: string): string {
  // Express puts the constraint before the optional marker, as in
  // `:name(pattern)?`, so match them in that order.
  return path === '/' ? '' : path.replace(/:(\w+)(?:\([^)]*\))?\??/g, '{$1}');
}

function toPascalSegment(segment: string): string {
  return segment
    .replace(/[{}]/g, '')
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

/**
 * Build an operationId from the method and document path, such as
 * `getWidgetsId` for `GET /widgets/{id}`.
 *
 * @remarks
 * Used when a route has neither an `operationId` nor a named handler.
 */
function deriveOperationId(method: string, docPath: string): string {
  const segments = docPath.split('/').filter(Boolean).map(toPascalSegment);
  return [method, ...segments].join('');
}

/**
 * The options for `defineRoute`: how to register the route, and what to
 * document about it.
 *
 * @typeParam Path - The `path` literal, used to type `req.params`.
 * @typeParam Locals - The `res.locals` type, inferred from `middleware`.
 * @typeParam Body - The `request.body` schema, used to type `req.body`.
 * @typeParam Query - The `request.query` schema, used to type `req.query`.
 * @typeParam ParamNames - The `params` names, when given.
 * @typeParam Responses - The map of status codes to body types, from
 *   `defineRoute.withResponses`.
 * @typeParam TScheme - The scheme names allowed in `security`.
 */
export interface RouteDef<
  Path extends string,
  Locals extends object,
  Body extends Schema | undefined,
  Query extends Schema | undefined,
  ParamNames extends readonly string[] = [],
  Responses extends Record<number, unknown> = EmptyResponses,
  TScheme extends string = SecurityScheme,
> {
  /** The HTTP method. */
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  /**
   * The route path, as passed to `router[method]`, relative to where the router
   * is mounted.
   */
  path: Path;
  /**
   * The path the router is mounted at, in OpenAPI syntax, such as
   * `/carts/{cartId}/items`.
   *
   * @remarks
   * The documented path is `prefix + path`. Omit it for routes on `app` or on a
   * router mounted at `/`.
   */
  prefix?: string;
  /**
   * The OpenAPI operationId, which client generators use as the method name.
   *
   * @remarks
   * Uniqueness isn't checked.
   *
   * @defaultValue
   * The handler's function name. For an inline `handler: (req, res) => ...`, a
   * name built from the method and path: `GET /widgets/{id}` becomes
   * `getWidgetsId`.
   */
  operationId?: string;
  /** A one-line summary of the operation. */
  summary?: string;
  /** Tags for grouping the operation in documentation tools. */
  tags?: string[];
  /**
   * Joi schemas to validate the request against, before `middleware` and
   * `handler` run.
   *
   * @remarks
   * `body` and `query` are replaced with the validated value, including
   * defaults and conversions. `params` and `headers` are only checked. A failed
   * check calls `next(err)` with Joi's `ValidationError`.
   */
  request?: { body?: Body; query?: Query; params?: Schema; headers?: Schema };
  /**
   * The responses to document, keyed by status code.
   *
   * @remarks
   * `schema` is a JSON Schema object for the response body. When `responses` is
   * omitted, no responses are documented; a 200 isn't assumed.
   */
  responses?: Record<
    number,
    { description: string; schema?: Record<string, unknown> }
  >;
  /**
   * The names of the path params, for typing `req.params` when they can't be
   * inferred from `path`.
   *
   * @remarks
   * Needed for params inherited through `mergeParams`, and for segments with
   * a modifier, such as `:id?` or `:id(\d+)`. Pass the list `as const`.
   *
   * @example
   * ```ts
   * params: ['cartId', 'itemId'] as const,
   * ```
   */
  params?: ParamNames;
  /**
   * The security schemes that grant access, any one of which is enough.
   *
   * @remarks
   * Use `'public'` for "no credentials" as one of the options, as in
   * `['ApiKeyAuth', 'public']`. Schemes tagged on `middleware` with `securedBy`
   * are added automatically. Leave it unset if the route's access check isn't a
   * documented scheme; unset isn't the same as `['public']`.
   */
  security?: SecurityRequirement<TScheme>[];
  /**
   * Whether the route is internal.
   *
   * @remarks
   * The library doesn't act on this. Filter on it to build a public document.
   *
   * @example
   * ```ts
   * buildOpenApiDocument(routeRegistry.filter((r) => !r.private), options);
   * ```
   */
  private?: boolean;
  /**
   * Middleware to run after validation and before `handler`.
   *
   * @remarks
   * When they're typed as `Provider<Locals>`, `res.locals` in `handler` is
   * typed from them.
   */
  middleware?: Provider<Locals>[] | express.RequestHandler[];
  /** The route handler, with `req` and `res` typed from the other options. */
  handler: RouteHandler<Path, ParamNames, Body, Query, Locals, Responses>;
}

/**
 * A registered route: a `RouteDef` plus the `docPath` that `defineRoute`
 * computes from `prefix` and `path`.
 */
export type AnyRouteDef = RouteDef<
  string,
  object,
  Schema | undefined,
  Schema | undefined,
  readonly string[],
  Record<number, unknown>
> & { docPath: string };

/**
 * Create a route registry with its own `defineRoute` and
 * `buildOpenApiDocument`.
 *
 * @remarks
 * Use it instead of the default `defineRoute` and `routeRegistry` exports
 * when you need separate registries, for example one per test.
 *
 * @typeParam TScheme - The scheme names allowed in `security`. Narrow it to
 *   make a misspelled scheme a compile error. It doesn't apply to
 *   `securedBy`.
 * @returns The registry's `defineRoute`, its `routeRegistry` array, and a
 *   `buildOpenApiDocument` that takes only the document options.
 *
 * @example
 * ```ts
 * const { defineRoute, routeRegistry, buildOpenApiDocument } =
 *   createRouteRegistry<'ApiKeyAuth' | 'BearerAuth'>();
 * ```
 */
export function createRouteRegistry<TScheme extends string = SecurityScheme>() {
  const routeRegistry: AnyRouteDef[] = [];

  /**
   * Register a route on `router`, and record it for the OpenAPI document.
   *
   * @remarks
   * Validation for `def.request` runs first, then `def.middleware`, then
   * `def.handler`.
   *
   * @param router - The `Router` or `app` to register the route on.
   * @param def - The route definition.
   *
   * @throws Error
   * Thrown if `prefix + path` is empty, or if the path contains a `*`
   * wildcard, which OpenAPI can't express.
   *
   * @example
   * ```ts
   * defineRoute(router, {
   *   method: 'get',
   *   path: '/:id',
   *   prefix: '/widgets',
   *   handler: (req, res) => {
   *     res.json({ id: req.params.id });
   *   },
   * });
   * ```
   */
  function defineRoute<
    Path extends string,
    Locals extends object = Record<string, never>,
    Body extends Schema | undefined = undefined,
    Query extends Schema | undefined = undefined,
    ParamNames extends readonly string[] = [],
    Responses extends Record<number, unknown> = EmptyResponses,
  >(
    router: express.IRouter,
    def: RouteDef<Path, Locals, Body, Query, ParamNames, Responses, TScheme>
  ) {
    const docPath = `${def.prefix ?? ''}${pathToDocSegment(def.path)}`;
    if (docPath === '') {
      // Happens only with no `prefix` and `path: '/'`.
      throw new Error(
        `defineRoute: ${def.method.toUpperCase()} ${def.path} resolves to an empty docPath -- pass \`prefix\`, or use a non-root \`path\``
      );
    }
    // JS names an inline `handler: (req, res) => {...}` "handler". Ignore that
    // name so inline handlers don't all get the operationId "handler".
    const inferredName = def.handler.name !== 'handler' ? def.handler.name : '';
    const operationId =
      def.operationId ??
      (inferredName || deriveOperationId(def.method, docPath));
    // A `*` wildcard has no OpenAPI equivalent: a generated client would send a
    // literal `*`. Bounded negated-class quantifier, so no backtracking.
    // eslint-disable-next-line sonarjs/super-linear-regex
    if (docPath.replace(/\{[^}]*\}/g, '').includes('*')) {
      throw new Error(
        `defineRoute: ${def.method.toUpperCase()} ${def.path} has a wildcard docPath (${docPath}) with no ` +
          'OpenAPI equivalent -- register it directly on the router instead'
      );
    }
    const security = [
      ...new Set([...(def.security ?? []), ...inferSecurity(def.middleware)]),
    ];

    routeRegistry.push({
      ...def,
      operationId,
      docPath,
      security,
    } as unknown as AnyRouteDef);

    const validators = [
      def.request?.params && paramValidator(def.request.params),
      def.request?.headers && headerValidator(def.request.headers),
      def.request?.query && queryValidator(def.request.query),
      def.request?.body && bodyValidator(def.request.body),
    ].filter((mw): mw is express.RequestHandler => Boolean(mw));

    // def.method is a union, so no single router method overload applies; the
    // handler's types were already checked at the call site. Call it as a
    // method, since Express's router methods use `this`. Validators run before
    // middleware, so bad input is rejected before any provider does I/O.
    const dynamicRouter = router as unknown as Record<
      string,
      (...args: unknown[]) => void
    >;
    dynamicRouter[def.method](
      def.path,
      ...validators,
      ...(def.middleware ?? []),
      def.handler
    );
  }

  /**
   * Get a `defineRoute` that checks `handler`'s responses against a map of
   * status codes to body types.
   *
   * @remarks
   * `res.status(200).json(body)` then only accepts the type mapped to 200. The
   * check is compile-time only; to document the bodies, use
   * `applyGeneratedResponseSchemas` from the `/typegen` entry point.
   *
   * It's curried so the route's other types are still inferred from `def`.
   * Passing a type argument to `defineRoute` itself would turn that inference
   * off.
   *
   * @typeParam Responses - The map of status codes to body types.
   * @returns A function that takes the same arguments as `defineRoute`.
   *
   * @example
   * ```ts
   * defineRoute.withResponses<{ 200: Widget; 404: NotFound }>()(router, {
   *   method: 'get',
   *   path: '/:id',
   *   prefix: '/widgets',
   *   responses: {
   *     200: { description: 'The widget' },
   *     404: { description: 'Not found' },
   *   },
   *   handler: (req, res) => {
   *     res.status(200).json(getWidget(req.params.id));
   *   },
   * });
   * ```
   */
  defineRoute.withResponses =
    <Responses extends Record<number, unknown>>() =>
    <
      Path extends string,
      Locals extends object = Record<string, never>,
      Body extends Schema | undefined = undefined,
      Query extends Schema | undefined = undefined,
      ParamNames extends readonly string[] = [],
    >(
      router: express.IRouter,
      def: RouteDef<Path, Locals, Body, Query, ParamNames, Responses, TScheme>
    ) => {
      defineRoute(router, def);
    };

  return {
    defineRoute,
    routeRegistry,
    buildOpenApiDocument: (
      options: Parameters<typeof buildOpenApiDocument>[1]
    ) => buildOpenApiDocument(routeRegistry, options),
  };
}
