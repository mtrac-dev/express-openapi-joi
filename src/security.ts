/**
 * A security scheme name, keyed into the `securitySchemes` map a caller
 * passes to buildOpenApiDocument (see ./document.ts) -- this library
 * doesn't define any schemes itself, since what a route is actually gated
 * by (a bearer token, an API key header, ...) is entirely up to the
 * consuming app.
 */
// Kept as its own name for what it documents at each call site, not for
// any structural distinction from `string`.
// eslint-disable-next-line sonarjs/redundant-type-aliases
export type SecurityScheme = string;

/**
 * `'public'` means "no security requirement" -- one alternative among
 * others, same as an empty `{}` entry in a real OpenAPI `security` array.
 * `(SecurityScheme & {})` rather than bare `SecurityScheme` keeps
 * `'public'` visible as its own literal in the union -- plain
 * `SecurityScheme | 'public'` collapses to just `string`, since
 * `SecurityScheme` (itself `string`) already absorbs the `'public'`
 * literal.
 */
export type SecurityRequirement = 'public' | (SecurityScheme & {});

export type SecurityRequirementObject = Partial<
  Record<SecurityScheme, string[]>
>;

const SECURES_WITH = Symbol('securesWith');

type TaggedMiddleware<T> = T & { [SECURES_WITH]?: SecurityScheme };

/**
 * Tags a middleware/provider factory's returned function with the scheme
 * it enforces, so defineRoute can auto-populate `security` for any route
 * that uses it, without the router author restating it. Only worth doing
 * for middleware whose enforcement is a simple, fixed, one-shape check
 * (e.g. a static API-key header comparison) -- a middleware whose
 * behavior varies per call (roles, optional auth, ...) can't be
 * expressed by a single fixed tag; state `security` explicitly on the
 * route instead, the same way `operationId`/`docPath` sometimes do.
 */
export function securedBy<T extends (...args: never[]) => unknown>(
  fn: T,
  scheme: SecurityScheme
): T {
  const tagged = fn as TaggedMiddleware<T>;
  tagged[SECURES_WITH] = scheme;
  return tagged;
}

/** Reads back any schemes tagged via `securedBy` among a route's own middleware. */
export function inferSecurity(
  middleware: readonly unknown[] = []
): SecurityScheme[] {
  return middleware
    .map((mw) => (mw as TaggedMiddleware<unknown>)[SECURES_WITH])
    .filter((scheme): scheme is SecurityScheme => Boolean(scheme));
}

function toRequirementObject(
  requirement: SecurityRequirement
): SecurityRequirementObject {
  return requirement === 'public' ? {} : { [requirement]: [] };
}

/**
 * Unions the security alternatives stated across every defineRoute
 * registration sharing one docPath+method (multiple registrations can
 * share a path+method when a route defers to a different handler per
 * caller) into one OpenAPI `security` array. Only what's explicitly
 * stated on each registration contributes -- a registration that states
 * nothing (most routes) contributes nothing, rather than being assumed
 * `public`, because "nothing stated" also covers routes gated by
 * something this module deliberately doesn't model as a security scheme
 * (a bespoke per-resource token check, say) -- assuming those are
 * `public` would misrepresent them as unauthenticated. A registration
 * that's genuinely open needs to say `security: ['public']` itself, same
 * as any other alternative.
 */
export function mergeSecurity(
  existing: SecurityRequirementObject[] | undefined,
  addition: SecurityRequirement[] | undefined
): SecurityRequirementObject[] {
  const combined = [
    ...(existing ?? []),
    ...(addition ?? []).map(toRequirementObject),
  ];
  const seen = new Set<string>();
  return combined.filter((requirement) => {
    const key = JSON.stringify(requirement);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
