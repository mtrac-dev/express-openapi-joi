import express from 'express';

import { defineRoute } from '../../src/index.ts';
import type { RouteDef } from '../../src/index.ts';
import { widgetsPrefix as importedPrefix } from './basicRouter.ts';

export interface Thing {
  ok: boolean;
}

const router = express.Router();

// `prefix` is an imported identifier, not a local constant, so it isn't in
// constMap.
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

// No `prefix` property.
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

// `path` can't be resolved.
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

// A template literal with a span that can't be resolved.
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

// `def` isn't an inline object literal.
defineRoute.withResponses<{ 200: Thing }>()(router, routeDef);

export default router;
