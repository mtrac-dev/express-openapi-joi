import type express from 'express';
import type { Schema } from 'joi';

import {
  bodyValidator,
  headerValidator,
  paramValidator,
  queryValidator,
} from './validators.ts';

/**
 * Extracts `:name` segments from an Express path STRING literal type into a
 * params object type -- the same trick Hono uses internally for path-param
 * inference. Only works for string literal paths; a route mounted via a
 * RegExp path, or one whose params come from a parent router's mergeParams
 * mount (not visible in this router's own relative path), needs an explicit
 * `Params` type argument on defineRoute instead -- this utility can't see
 * either of those cases.
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
  Params,
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
  summary?: string;
  tags?: string[];
  /** Runtime Joi validation, same as bodyValidator/etc. today -- independent of the `Params` type argument above. */
  request?: { body?: Body; query?: Query; params?: Schema; headers?: Schema };
  responses?: Record<number, { description: string }>;
  middleware?: express.RequestHandler[];
  handler: express.RequestHandler<
    Params,
    unknown,
    InferJoi<Body>,
    InferJoi<Query>
  >;
}

export const routeRegistry: RouteDef<
  string,
  unknown,
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
  Params = ExtractRouteParams<Path>,
  Body extends Schema | undefined = undefined,
  Query extends Schema | undefined = undefined,
>(router: express.Router, def: RouteDef<Path, Params, Body, Query>) {
  routeRegistry.push(
    def as unknown as RouteDef<
      string,
      unknown,
      Schema | undefined,
      Schema | undefined
    >
  );

  const validators = [
    def.request?.params && paramValidator(def.request.params),
    def.request?.headers && headerValidator(def.request.headers),
    def.request?.query && queryValidator(def.request.query),
    def.request?.body && bodyValidator(def.request.body),
  ].filter((mw): mw is express.RequestHandler => Boolean(mw));

  // def.method is a union, so TS can't resolve a specific router.get/post/...
  // overload here -- the real type-safety is at the defineRoute call site
  // (handler is checked against Params/Body/Query there); this dispatch is
  // just plumbing, and Express's runtime behavior is identical regardless
  // of which named method registered the handler. Must stay a method call
  // (router[def.method](...)), not a detached reference -- Express's router
  // methods rely on `this`, which a standalone reference loses.
  const dynamicRouter = router as unknown as Record<
    string,
    (...args: unknown[]) => void
  >;
  dynamicRouter[def.method](
    def.path,
    ...(def.middleware ?? []),
    ...validators,
    def.handler
  );
}
