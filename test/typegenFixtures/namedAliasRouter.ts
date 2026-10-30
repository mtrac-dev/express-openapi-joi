import express from 'express';

import { defineRoute } from '../../src/index.ts';

export interface NamedAliasThing {
  ok: boolean;
}

// A type alias rather than an interface: an interface doesn't satisfy
// `Record<number, unknown>` without an index signature.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
type NamedResponses = {
  200: NamedAliasThing;
};

const router = express.Router();

defineRoute.withResponses<NamedResponses>()(router, {
  method: 'get',
  path: '/',
  prefix: '/named-alias',
  summary: 'Uses a named type alias instead of an inline literal',
  responses: { 200: { description: 'OK' } },
  handler: (_req, res) => {
    res.status(200).json({ ok: true });
  },
});

export default router;
