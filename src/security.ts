/** The name of a security scheme in `components.securitySchemes`. */
// An alias of `string` that names what the value is at each use.
// eslint-disable-next-line sonarjs/redundant-type-aliases
export type SecurityScheme = string;

/**
 * One entry in a route's `security` list.
 *
 * @remarks
 * A scheme name, or `'public'` when no credentials are needed. The document
 * writes `'public'` as `{}`.
 *
 * @typeParam TScheme - The scheme names allowed.
 */
// `TScheme & {}` keeps 'public' visible in editor hints; `TScheme | 'public'`
// collapses to plain `string` when TScheme is `string`.
export type SecurityRequirement<TScheme extends string = SecurityScheme> =
  'public' | (TScheme & {});

/**
 * An OpenAPI security requirement object, mapping scheme names to scopes.
 *
 * @typeParam TScheme - The scheme names allowed.
 */
export type SecurityRequirementObject<TScheme extends string = SecurityScheme> =
  Partial<Record<TScheme, string[]>>;

const SECURES_WITH = Symbol('securesWith');

type TaggedMiddleware<T> = T & { [SECURES_WITH]?: SecurityScheme };

/**
 * Tag a middleware with the security scheme it enforces.
 *
 * @remarks
 * Every route using the middleware then documents that scheme. Use it for
 * middleware that always enforces one scheme; for conditional checks, set
 * `security` on the route instead.
 *
 * @param fn - The middleware to tag.
 * @param scheme - The scheme's name in `components.securitySchemes`.
 * @returns `fn` itself, now tagged.
 *
 * @example
 * ```ts
 * const requireApiKey = securedBy(apiKeyMiddleware, 'ApiKeyAuth');
 * ```
 */
export function securedBy<T extends (...args: never[]) => unknown>(
  fn: T,
  scheme: SecurityScheme
): T {
  const tagged = fn as TaggedMiddleware<T>;
  tagged[SECURES_WITH] = scheme;
  return tagged;
}

/**
 * Get the schemes tagged with `securedBy` on a list of middleware.
 *
 * @param middleware - The middleware to inspect.
 * @returns The tagged scheme names, in order.
 */
export function inferSecurity(
  middleware: readonly unknown[] = []
): SecurityScheme[] {
  return middleware
    .map(
      (mw) =>
        (mw as TaggedMiddleware<unknown> | null | undefined)?.[SECURES_WITH]
    )
    .filter((scheme): scheme is SecurityScheme => Boolean(scheme));
}

function toRequirementObject(
  requirement: SecurityRequirement
): SecurityRequirementObject {
  return requirement === 'public' ? {} : { [requirement]: [] };
}

/**
 * Add `security` entries to an OpenAPI security requirement list.
 *
 * @param existing - The current requirement list, if any.
 * @param addition - The entries to add. `'public'` becomes `{}`.
 * @returns A new list, without duplicates.
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
