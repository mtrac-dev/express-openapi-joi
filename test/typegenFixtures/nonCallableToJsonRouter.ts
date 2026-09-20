import express from 'express';

import { defineRoute } from '../../src/index.ts';

// A literal `toJSON` PROPERTY, not a method -- exercises
// generateResponseSchema's fallback for a `toJSON` that isn't callable
// (checked via the type checker's call signatures, not by name, so this
// isn't specific to any one shape).
export interface NonCallableToJson {
  toJSON: string;
  other: number;
}

const router = express.Router();

defineRoute.withResponses<{ 200: NonCallableToJson }>()(router, {
  method: 'get',
  path: '/',
  prefix: '/non-callable-tojson',
  summary: 'Has a toJSON property that is not a function',
  responses: { 200: { description: 'OK' } },
  handler: (_req, res) => {
    res.status(200).json({ toJSON: 'not-a-function', other: 1 });
  },
});

export default router;
