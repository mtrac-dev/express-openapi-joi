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
  // A function call, not a literal/const/template -- resolveStringExpression
  // can't statically evaluate this, so docPath resolution should fail and
  // this call gets skipped (logged, not thrown).
  prefix: computePrefix(),
  summary: 'Uses a prefix that cannot be statically resolved',
  responses: { 200: { description: 'OK' } },
  handler: (_req, res) => {
    res.status(200).json({ ok: true });
  },
});

export default router;
