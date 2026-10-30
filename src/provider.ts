import type {
  ParamsDictionary,
  RequestHandler,
} from 'express-serve-static-core';
import type { ParsedQs } from 'qs';

type ProvidedLocals<L extends object> = L & Record<string, unknown>;

/**
 * A middleware that adds `L` to `res.locals`.
 *
 * @remarks
 * Pass providers as a route's `middleware`, and `res.locals` in its handler is
 * typed from them.
 *
 * @typeParam L - The properties the middleware adds to `res.locals`.
 * @typeParam P - The `req.params` type.
 * @typeParam ResBody - The response body type.
 * @typeParam ReqQuery - The `req.query` type.
 *
 * @example
 * ```ts
 * const loadUser: Provider<{ user: User }> = async (req, res, next) => {
 *   res.locals.user = await findUser(req.get('authorization'));
 *   next();
 * };
 * ```
 */
export type Provider<
  L extends object,
  P = ParamsDictionary,
  ResBody = unknown,
  ReqQuery = ParsedQs,
> = RequestHandler<P, ResBody, never, ReqQuery, ProvidedLocals<L>>;

/**
 * The `res.locals` type provided by an array of `Provider`s.
 *
 * @typeParam T - The array of provider types.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- L is what's being inferred, so there's no narrower bound.
export type ProviderLocals<T extends Provider<any>[]> = T extends Provider<
  infer L
>[]
  ? L
  : never;
