import express from 'express';

import { defineRoute } from '../../src/index.ts';

export interface Wrapper<T> {
  data: T;
}

export interface Payload {
  value: string;
}

const router = express.Router();

defineRoute.withResponses<{ 200: Wrapper<Payload> }>()(router, {
  method: 'get',
  path: '/',
  prefix: '/generic-instantiation',
  summary: 'Uses a generic instantiation directly instead of a concrete alias',
  responses: { 200: { description: 'OK' } },
  handler: (_req, res) => {
    res.status(200).json({ data: { value: 'x' } });
  },
});

export default router;
