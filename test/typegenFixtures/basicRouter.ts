import express from 'express';

import { defineRoute } from '../../src/index.ts';

export interface Widget {
  id: string;
  name: string;
}

export const widgetsPrefix = '/widgets';
const extraSuffix = 'extra';

const router = express.Router();

defineRoute.withResponses<{ 200: Widget }>()(router, {
  method: 'get',
  path: '/:id',
  prefix: widgetsPrefix,
  summary: 'Get a widget',
  responses: { 200: { description: 'The widget' } },
  handler: (req, res) => {
    res.status(200).json({ id: req.params.id, name: 'thing' });
  },
});

defineRoute.withResponses<{ 200: Widget[] }>()(router, {
  method: 'get',
  path: '/',
  prefix: `${widgetsPrefix}/${extraSuffix}`,
  summary: 'List widgets',
  responses: { 200: { description: 'The widgets' } },
  handler: (_req, res) => {
    res.status(200).json([]);
  },
});

export class SerializableThing {
  toJSON(): { code: string; msg: string } {
    return { code: 'ok', msg: 'a message' };
  }
}

defineRoute.withResponses<{ 200: SerializableThing }>()(router, {
  method: 'get',
  path: '/serializable',
  prefix: widgetsPrefix,
  summary: 'Get a serializable thing',
  responses: { 200: { description: 'The thing' } },
  handler: (_req, res) => {
    res.status(200).json(new SerializableThing());
  },
});

export default router;
