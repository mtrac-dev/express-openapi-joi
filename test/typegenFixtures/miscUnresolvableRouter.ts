import express from 'express';

import { defineRoute } from '../../src/index.ts';
import type { RouteDef } from '../../src/index.ts';
import { widgetsPrefix as importedPrefix } from './basicRouter.ts';

export interface Thing {
  ok: boolean;
}

const router = express.Router();

// prefix is an identifier reference to something NOT declared as a local
// const in THIS file (it's imported) -- resolveStringExpression's
// "identifier not found in constMap" branch.
defineRoute.withResponses<{ 200: Thing }>()(router, {
  method: 'get',
  path: '/',
  prefix: importedPrefix,
  summary: 'Uses an imported (not locally-const) identifier as prefix',
  responses: { 200: { description: 'OK' } },
  handler: (_req, res) => {
    res.status(200).json({ ok: true });
  },
});

// No `prefix` property at all -- getObjectLiteralStringProp's "prop not
// found" branch, and resolveDocPathAndMethod's `prefix ?? ''` branch with
// prefix genuinely absent, not just unresolvable.
defineRoute.withResponses<{ 200: Thing }>()(router, {
  method: 'get',
  path: '/no-prefix-at-all',
  summary: 'Has no prefix property, relying on path alone',
  responses: { 200: { description: 'OK' } },
  handler: (_req, res) => {
    res.status(200).json({ ok: true });
  },
});

function computePath(): string {
  return '/computed';
}

// path itself can't be statically resolved -- resolveDocPathAndMethod's
// `routePath === undefined` branch.
defineRoute.withResponses<{ 200: Thing }>()(router, {
  method: 'get',
  path: computePath(),
  prefix: '/misc',
  summary: 'Has an unresolvable path',
  responses: { 200: { description: 'OK' } },
  handler: (_req, res) => {
    res.status(200).json({ ok: true });
  },
});

// A template expression whose OWN span isn't statically resolvable --
// resolveStringExpression's template-expression branch, span-unresolvable
// case.
defineRoute.withResponses<{ 200: Thing }>()(router, {
  method: 'get',
  path: '/',
  prefix: `/misc/${computePath()}`,
  summary: 'Has a template prefix whose span is unresolvable',
  responses: { 200: { description: 'OK' } },
  handler: (_req, res) => {
    res.status(200).json({ ok: true });
  },
});

const routeDef: RouteDef<
  '/variable-def',
  object,
  undefined,
  undefined,
  [],
  { 200: Thing }
> = {
  method: 'get',
  path: '/variable-def',
  prefix: '/misc',
  summary: 'Passes a variable instead of an inline object literal',
  responses: { 200: { description: 'OK' } },
  handler: (_req, res) => {
    res.status(200).json({ ok: true });
  },
};

// The def argument isn't an inline object literal --
// processWithResponsesCall's "defArg isn't an ObjectLiteralExpression"
// branch.
defineRoute.withResponses<{ 200: Thing }>()(router, routeDef);

export default router;
