import express from 'express';

import { defineRoute } from '../../src/index.ts';

export interface Thing {
  ok: boolean;
}

function computePrefix(): string {
  return '/computed';
}

const router = express.Router();

defineRoute.withResponses<{ 200: Thing }>()(router, {
  method: 'get',
  path: '/',
  // A function call can't be evaluated statically, so this call is logged and
  // skipped.
  prefix: computePrefix(),
  summary: 'Uses a prefix that cannot be statically resolved',
  responses: { 200: { description: 'OK' } },
  handler: (_req, res) => {
    res.status(200).json({ ok: true });
  },
});

export default router;
