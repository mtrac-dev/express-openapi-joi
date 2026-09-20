import type {
  ParamsDictionary,
  RequestHandler,
} from 'express-serve-static-core';
import type { ParsedQs } from 'qs';

type ProvidedLocals<L extends object> = L & Record<string, unknown>;

/**
 * A middleware that augments res.locals with `L`, typed so defineRoute can
 * infer a route's combined Locals type from whichever providers it's given
 * -- the same shape a hand-written `provideAll()`-style helper would merge
 * for the type system, without defineRoute needing to know about it.
 */
export type Provider<
  L extends object,
  P = ParamsDictionary,
  ResBody = unknown,
  ReqQuery = ParsedQs,
> = RequestHandler<P, ResBody, never, ReqQuery, ProvidedLocals<L>>;

/**
 * Recovers the combined `Locals` type from an array of `Provider`s, e.g.
 * `ProviderLocals<typeof provideAll(userProvider(...), cartProvider())>` --
 * for a handler that needs to name that type directly (a generic helper
 * parameterized over it) rather than just letting defineRoute infer it
 * from `middleware` at the call site.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Provider<L>'s own L is the thing being inferred; there's no narrower bound to give it here.
export type ProviderLocals<T extends Provider<any>[]> = T extends Provider<
  infer L
>[]
  ? L
  : never;
