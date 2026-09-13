import { createRouteRegistry } from './defineRoute.ts';

/**
 * The library's default, process-wide route registry -- most apps only
 * need one (this is what an app would otherwise wire up by hand, e.g.
 * `export const { defineRoute, routeRegistry } = createRouteRegistry();`
 * in its own registry.ts), so `defineRoute`/`routeRegistry` are exported
 * bound to this instance directly. Call createRouteRegistry() instead for
 * an isolated instance -- every test in this repo does, and so should an
 * app that genuinely needs more than one registry in one process.
 */
export const { defineRoute, routeRegistry } = createRouteRegistry();
