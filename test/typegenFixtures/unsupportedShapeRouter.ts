import express from 'express';

import { defineRoute } from '../../src/index.ts';

export interface A {
  a: string;
}

export interface B {
  b: string;
}

const router = express.Router();

defineRoute.withResponses<{ 200: A | B }>()(router, {
  method: 'get',
  path: '/',
  prefix: '/unsupported-shape',
  summary: 'Uses an inline union instead of a named alias',
  responses: { 200: { description: 'OK' } },
  handler: (_req, res) => {
    res.status(200).json({ a: 'x' });
  },
});

export default router;
