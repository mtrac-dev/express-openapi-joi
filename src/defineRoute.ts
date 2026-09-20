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
import { inferSecurity, type SecurityRequirement } from './security.ts';

/**
 * Extracts `:name` segments from an Express path STRING literal type into a
 * params object type -- the same trick Hono uses internally for path-param
 * inference. Only works for string literal paths. Two cases it can't see:
 * a route mounted via a RegExp path, or one whose params come from a
 * parent router's mergeParams mount rather than this router's own
 * relative path. For either, pass `params` explicitly (see below) instead
 * of relying on inference here.
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

// Checked against an empty tuple, not `undefined` -- `undefined extends T`
// can be true for surprisingly many T under a loose tsconfig, which would
// make an `undefined`-based check here unreliable across consumers with
// different strictness settings.
type ResolvedParams<
  Path extends string,
  ParamNames extends readonly string[],
> = ParamNames extends readonly []
  ? ExtractRouteParams<Path>
  : ParamsFromNames<ParamNames>;

type InferJoi<S> = S extends Schema<infer T> ? T : never;

/**
 * Translates this route's own `:name`/`:name?`/`:name(regex)` segments into
 * OpenAPI's `{name}` placeholder syntax, for deriving `docPath` from
 * `prefix + path` instead of restating the whole absolute path by hand.
 *
 * Exported (not just used internally) so a consumer's own static analysis
 * of its route files -- e.g. a build-time response-schema generator that
 * needs to resolve the same `docPath` a `prefix`-based defineRoute call
 * will produce at runtime, from its own reading of the source AST -- can
 * reuse this exact translation instead of a second, maybe-drifting copy.
 */
export function pathToDocSegment(path: string): string {
  // Express's real modifier order is constraint-then-optional
  // (`:name(pattern)?`), not the reverse -- matching `?` before the
  // constraint group would leave a dangling, un-replaced `?` in the
  // output for a segment that's both constrained and optional.
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
 * Fallback operationId for when neither an explicit one nor a usable
 * handler name is available -- built from method + docPath so the
 * operation still gets a deterministic, meaningful name instead of
 * nothing at all, which just pushes the job onto whatever a generated
 * client's own fallback does (the "much less usable" shape
 * RouteDef.operationId's own JSDoc already warns about, e.g.
 * `widgetsIdPost`).
 */
function deriveOperationId(method: string, docPath: string): string {
  const segments = docPath.split('/').filter(Boolean).map(toPascalSegment);
  return [method, ...segments].join('');
}

export interface RouteDef<
  Path extends string,
  Locals extends object,
  Body extends Schema | undefined,
  Query extends Schema | undefined,
  ParamNames extends readonly string[] = [],
> {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  /** Path as passed to `router[method]` -- relative to wherever this router is mounted. */
  path: Path;
  /**
   * This router's absolute mount prefix, already using OpenAPI's `{name}`
   * placeholder syntax for any params in the prefix itself (e.g.
   * `/carts/{cartId}/items/{itemId}` for a mergeParams-derived parent
   * param that doesn't appear in this router's own relative `path` at
   * all) -- the OpenAPI document's path for this route is always `prefix +
   * path` (translating this route's own `:name`/`:name?`/`:name(regex)`
   * segments to `{name}`). Omit it for a route registered directly on
   * `app`, or on a router mounted at the absolute root -- there, `path`
   * alone is already the full path.
   */
  prefix?: string;
  /**
   * OpenAPI operationId -- generated clients (openapi-generator-cli's
   * typescript-fetch, in particular) name their methods from this. Falls
   * back, in order: (1) `handler`'s own function name, EXCEPT the literal
   * name `"handler"` (see below); (2) method + docPath (e.g. `GET
   * /widgets/{id}` -> `getWidgetsId`) when neither of those is usable.
   * Only needed explicitly when a handler is shared across registrations
   * that want different operationIds, or to get a nicer name than the
   * method+docPath fallback produces.
   *
   * The `"handler"` exclusion exists because a bare
   * `handler: (req, res) => {...}` (the everyday call style, including
   * everywhere else in this file's own examples) is NOT anonymous to JS --
   * an arrow function assigned directly as an object property infers that
   * property's own key, `"handler"`, as the function's `.name`. Without
   * this exclusion, every route defined that way would collide onto the
   * literal operationId `"handler"`. A handler assigned some OTHER way
   * that happens to infer a different name (e.g. a plain object's `get:`
   * method rather than `handler:`) isn't covered by this one check and
   * would fall through to it as if it were a real, intentional name.
   *
   * None of this is checked for uniqueness across registrations --
   * reusing the same named handler function (or the same explicit
   * operationId) for two actually-different operations produces a
   * document with a duplicate operationId, same as it always has; that's
   * on the caller, not something defineRoute guards against.
   */
  operationId?: string;
  summary?: string;
  tags?: string[];
  /** Runtime Joi validation, same as bodyValidator/etc. today. */
  request?: { body?: Body; query?: Query; params?: Schema; headers?: Schema };
  /**
   * `schema` is a plain JSON Schema object, not Joi -- unlike request
   * validation, none of today's response shapes have a runtime (Joi)
   * schema to convert, so there's nothing to derive this from
   * automatically. Without it, a generated client's method has no
   * response type to deserialize into and just discards the body
   * (returns void) -- only needed for a route whose callers actually
   * read the response body.
   *
   * Leaving this out entirely means no success status is documented at
   * all, not a fabricated one -- buildOpenApiDocument doesn't assume every
   * undocumented route is a schema-less 200. Assuming that broke a real
   * generated client the one time a route's actual success status wasn't
   * 200: a fabricated, schema-less 200 sat next to that route's real,
   * schema'd status, and the client generator picked the fabricated one.
   */
  responses?: Record<
    number,
    { description: string; schema?: Record<string, unknown> }
  >;
  /**
   * Explicit path param names, for paths ExtractRouteParams can't infer
   * from the string literal alone: an inline regex constraint
   * (`:name(...)`), an optional segment (`:name?`), or a param that comes
   * from a parent router's mergeParams mount rather than this router's
   * own relative path. Overrides inference the same way `operationId` can
   * be stated explicitly instead of relying on the handler's function
   * name. Needs `as const` at the call site (e.g. `['cartId', 'itemId']
   * as const`) for TypeScript to see it as a literal tuple rather than
   * plain `string[]`.
   */
  params?: ParamNames;
  /**
   * Which of this route's alternatives satisfy access, as OpenAPI would
   * describe it -- e.g. `['ApiKeyAuth']` (a key required), `['ApiKeyAuth',
   * 'public']` (optional), or `['public']` (a registration with no gate
   * of its own). Merged across every registration sharing a
   * docPath+method, not overwritten, since later branches often accept
   * different alternatives than the first. Middleware tagged via
   * `securedBy` (see ./security.ts) contributes to this automatically;
   * state it explicitly for anything else, the same way
   * `operationId`/`params` sometimes need to be. A route gated by
   * something deliberately not modeled as a security scheme should state
   * nothing at all, rather than claim `public` -- leaving `security`
   * unstated is how "this axis isn't documented" gets represented,
   * distinct from "verified open".
   */
  security?: SecurityRequirement[];
  /**
   * Same providers you'd pass to a provideAll()-style combinator today --
   * `Locals` is inferred from their combined Provider<L> type, so
   * res.locals is typed in `handler` without restating it. A plain
   * express.RequestHandler[] (not Provider<L>[]) still works, but Locals
   * then can't be inferred from it -- res.locals stays untyped in
   * `handler` unless you cast it there.
   */
  middleware?: Provider<Locals>[] | express.RequestHandler[];
  handler: express.RequestHandler<
    ResolvedParams<Path, ParamNames>,
    unknown,
    InferJoi<Body>,
    InferJoi<Query>,
    Locals
  >;
}

// docPath doesn't exist on RouteDef at all -- it's always derived from
// prefix+path (see defineRoute below) and resolved to a real string by
// the time defineRoute pushes an entry into routeRegistry. Added here so
// document.ts can read it directly, rather than every reader having to
// re-derive it from prefix+path itself.
export type AnyRouteDef = RouteDef<
  string,
  object,
  Schema | undefined,
  Schema | undefined,
  readonly string[]
> & { docPath: string };

/**
 * Creates an independent route registry and a `defineRoute` bound to it --
 * a fresh instance per call, not a module-level singleton, so a consumer
 * embedding this in a larger process (or a test) can keep its own registry
 * isolated instead of sharing some other part of the same process's
 * instance. buildOpenApiDocument is bound to the same registry, so a
 * caller never has to pass it explicitly.
 */
export function createRouteRegistry() {
  const routeRegistry: AnyRouteDef[] = [];

  /**
   * Registers a route (and its schemas) in one call -- both the real
   * Express registration and the metadata buildOpenApiDocument reads back
   * from routeRegistry.
   *
   * Takes `express.IRouter`, not `express.Router` -- the interface both
   * `Router` and `Application` actually extend, so this works identically
   * whether routes are declared on a per-feature router or directly on
   * `app` for a project that doesn't split routes into separate router
   * files at all.
   */
  function defineRoute<
    Path extends string,
    Locals extends object = Record<string, never>,
    Body extends Schema | undefined = undefined,
    Query extends Schema | undefined = undefined,
    ParamNames extends readonly string[] = [],
  >(
    router: express.IRouter,
    def: RouteDef<Path, Locals, Body, Query, ParamNames>
  ) {
    const docPath = `${def.prefix ?? ''}${pathToDocSegment(def.path)}`;
    if (docPath === '') {
      // Only reachable with no `prefix` and a bare `path: '/'` -- e.g. a
      // route registered directly on `app`'s own root with nothing else
      // to give the OpenAPI document a real path.
      throw new Error(
        `defineRoute: ${def.method.toUpperCase()} ${def.path} resolves to an empty docPath -- pass \`prefix\`, or use a non-root \`path\``
      );
    }
    // A bare `handler: (req, res) => {...}` (the call style used
    // everywhere else in this file's own examples) isn't anonymous to
    // JS -- it infers the object property key itself, "handler", as the
    // function's own `.name`. Treating that one specific inferred name as
    // if it were still anonymous is what keeps every route defined that
    // way from colliding onto the literal operationId "handler"; see the
    // caveat on RouteDef.operationId's own JSDoc for what this doesn't
    // cover. Falling all the way through to deriveOperationId (rather
    // than leaving operationId undefined) means a generated client still
    // gets a real, meaningful method name instead of inventing its own.
    const inferredName = def.handler.name !== 'handler' ? def.handler.name : '';
    const operationId =
      def.operationId ??
      (inferredName || deriveOperationId(def.method, docPath));
    // A bare `*` (Express's wildcard-segment syntax) outside a `{name}`
    // placeholder has no OpenAPI equivalent -- a generated client would
    // send the literal character `*` in the URL, which can never match
    // the real route. Routes that need Express's own wildcard matching
    // aren't representable here; register them directly on `router`
    // instead of through defineRoute, outside the documented surface.
    // Bounded negated-class quantifier -- no backtracking ambiguity.
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

    // def.method is a union, so TS can't resolve a specific router.get/post/...
    // overload here -- the real type-safety is at the defineRoute call site
    // (handler is checked against Locals/Body/Query there); this dispatch is
    // just plumbing, and Express's runtime behavior is identical regardless
    // of which named method registered the handler. Must stay a method call
    // (router[def.method](...)), not a detached reference -- Express's router
    // methods rely on `this`, which a standalone reference loses. Validators
    // run before middleware -- fail fast on malformed input before any
    // resource-provider I/O -- not the other way around.
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

  return {
    defineRoute,
    routeRegistry,
    buildOpenApiDocument: (
      options: Parameters<typeof buildOpenApiDocument>[1]
    ) => buildOpenApiDocument(routeRegistry, options),
  };
}
