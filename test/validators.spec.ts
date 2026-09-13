import express from 'express';
import Joi from 'joi';
import { expect } from 'chai';

import {
  bodyValidator,
  headerValidator,
  paramValidator,
  queryValidator,
} from '../src/validators.ts';
import { testRequest } from './helpers/request.ts';

describe('UNIT: validators', () => {
  describe('bodyValidator', () => {
    const schema = Joi.object<{ name: string }>({
      name: Joi.string().required(),
    });
    const app = express();
    app.use(express.json());
    app.post('/', bodyValidator(schema), (req, res) =>
      res.status(200).json(req.body)
    );
    const request = testRequest(app);

    it('replaces req.body with the validated value on success', async () => {
      const res = await request.post('/').send({ name: 'thing' });

      expect(res.status).to.equal(200);
      expect(res.body).to.eql({ name: 'thing' });
    });

    it('responds 400 on a schema violation', async () => {
      const res = await request.post('/').send({});

      expect(res.status).to.equal(400);
    });
  });

  describe('queryValidator', () => {
    const schema = Joi.object<{ q: string }>({ q: Joi.string().required() });
    const app = express();
    app.get('/', queryValidator(schema), (req, res) =>
      res.status(200).json(req.query)
    );
    const request = testRequest(app);

    it('replaces req.query with the validated value on success', async () => {
      const res = await request.get('/?q=thing');

      expect(res.status).to.equal(200);
      expect(res.body).to.eql({ q: 'thing' });
    });

    it('responds 400 on a schema violation', async () => {
      const res = await request.get('/');

      expect(res.status).to.equal(400);
    });
  });

  describe('paramValidator', () => {
    const schema = Joi.object<{ id: string }>({
      id: Joi.string().uuid().required(),
    });
    const app = express();
    app.get('/:id', paramValidator(schema), (req, res) =>
      res.status(200).json(req.params)
    );
    const request = testRequest(app);

    it('passes through on a valid param', async () => {
      const res = await request.get('/9f7f9b1a-3f2f-4b3f-9b1a-3f2f4b3f9b1a');

      expect(res.status).to.equal(200);
    });

    it('responds 400 on a schema violation', async () => {
      const res = await request.get('/not-a-uuid');

      expect(res.status).to.equal(400);
    });
  });

  describe('headerValidator', () => {
    const schema = Joi.object({ 'x-tenant': Joi.string().required() }).unknown(
      true
    );
    const app = express();
    app.get('/', headerValidator(schema), (_req, res) =>
      res.status(200).json({})
    );
    const request = testRequest(app);

    it('passes through when the required header is present', async () => {
      const res = await request.get('/').set('x-tenant', 'acme');

      expect(res.status).to.equal(200);
    });

    it('responds 400 when the required header is missing', async () => {
      const res = await request.get('/');

      expect(res.status).to.equal(400);
    });
  });
});
