import type express from 'express';
import type { Schema } from 'joi';

import {
  bodyValidator,
  headerValidator,
  paramValidator,
  queryValidator,
} from './validators.ts';
import type { Provider } from './provider.ts';

/**
 * Extracts `:name` segments from an Express path STRING literal type into a
 * params object type -- the same trick Hono uses internally for path-param
 * inference. Only works for string literal paths. Two cases it can't see:
 * a route mounted via a RegExp path, or one whose params come from a
 * parent router's mergeParams mount rather than this router's own
 * relative path. For either, cast `req.params` explicitly inside the
 * handler -- TypeScript can't mix an explicit type argument for one
 * generic parameter here with inference for the others, so there's no
 * generic-argument escape hatch, just a local cast where it's needed.
 */
type ExtractRouteParams<Path extends string> =
  Path extends `${string}:${infer Param}/${infer Rest}`
    ? Record<Param | keyof ExtractRouteParams<`/${Rest}`>, string>
    : Path extends `${string}:${infer Param}`
      ? Record<Param, string>
      : Record<string, never>;

type InferJoi<S> = S extends Schema<infer T> ? T : never;

export interface RouteDef<
  Path extends string,
  Locals extends object,
  Body extends Schema | undefined,
  Query extends Schema | undefined,
> {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  /** Path as passed to `router[method]` -- relative to wherever this router is mounted. */
  path: Path;
  /**
   * Full absolute path for the OpenAPI document, including every param --
   * this router's own mount point isn't visible from inside the router
   * file, so it can't be derived automatically. Same `{name}` placeholders
   * as the real mount path used to reach this router.
   */
  docPath: string;
  /**
   * OpenAPI operationId -- generated clients (openapi-generator-cli's
   * typescript-fetch, in particular) name their methods from this when
   * present. Without it, method names get auto-derived from path+method
   * and are much less usable (e.g. `widgetsIdPost`). Defaults to
   * `handler`'s own function name when omitted -- only needed when
   * `handler` is anonymous, or shared across registrations that want
   * different operationIds.
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
   */
  responses?: Record<
    number,
    { description: string; schema?: Record<string, unknown> }
  >;
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
    ExtractRouteParams<Path>,
    unknown,
    InferJoi<Body>,
    InferJoi<Query>,
    Locals
  >;
}

export const routeRegistry: RouteDef<
  string,
  object,
  Schema | undefined,
  Schema | undefined
>[] = [];

/**
 * Registers a route (and its schemas) in one call -- both the real Express
 * registration and the metadata a later OpenAPI-document build step reads
 * from routeRegistry. See ./document.ts.
 */
export function defineRoute<
  Path extends string,
  Locals extends object = Record<string, never>,
  Body extends Schema | undefined = undefined,
  Query extends Schema | undefined = undefined,
>(router: express.Router, def: RouteDef<Path, Locals, Body, Query>) {
  const operationId = def.operationId ?? (def.handler.name || undefined);
  routeRegistry.push({ ...def, operationId } as unknown as RouteDef<
    string,
    object,
    Schema | undefined,
    Schema | undefined
  >);

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
  // methods rely on `this`, which a standalone reference loses.
  // Validators run before middleware -- fail fast on malformed input before
  // any resource-provider I/O -- not the other way around.
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
