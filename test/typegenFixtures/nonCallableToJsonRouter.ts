import express from 'express';

import { defineRoute } from '../../src/index.ts';

// A `toJSON` property that isn't callable, so the schema comes from the
// type's own shape.
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
