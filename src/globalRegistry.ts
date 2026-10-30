import { createRouteRegistry } from './defineRoute.ts';

/**
 * The default registry's `defineRoute` and `routeRegistry`.
 *
 * @remarks
 * Most apps need only one registry. Use `createRouteRegistry()` for a
 * separate one.
 */
export const { defineRoute, routeRegistry } = createRouteRegistry();
