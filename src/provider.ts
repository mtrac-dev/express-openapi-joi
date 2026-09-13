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
