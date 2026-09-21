import express from 'express';
import Joi from 'joi';
import { expect } from 'chai';

import {
  bodyValidator,
  headerValidator,
  paramValidator,
  queryValidator,
  validationErrorHandler,
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
    app.use(validationErrorHandler);
    const request = testRequest(app);

    it('replaces req.body with the validated value on success', async () => {
      const res = await request.post('/').send({ name: 'thing' });

      expect(res.status).to.equal(200);
      expect(res.body).to.eql({ name: 'thing' });
    });

    it('forwards a ValidationError to next(), formatted 400 by validationErrorHandler', async () => {
      const res = await request.post('/').send({});

      expect(res.status).to.equal(400);
      expect(res.body).to.have.property('message');
      expect(res.body).to.have.property('details');
    });
  });

  describe('queryValidator', () => {
    const schema = Joi.object<{ q: string }>({ q: Joi.string().required() });
    const app = express();
    app.get('/', queryValidator(schema), (req, res) =>
      res.status(200).json(req.query)
    );
    app.use(validationErrorHandler);
    const request = testRequest(app);

    it('replaces req.query with the validated value on success', async () => {
      const res = await request.get('/?q=thing');

      expect(res.status).to.equal(200);
      expect(res.body).to.eql({ q: 'thing' });
    });

    it('responds 400 via validationErrorHandler on a schema violation', async () => {
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
    app.use(validationErrorHandler);
    const request = testRequest(app);

    it('passes through on a valid param', async () => {
      const res = await request.get('/9f7f9b1a-3f2f-4b3f-9b1a-3f2f4b3f9b1a');

      expect(res.status).to.equal(200);
    });

    it('responds 400 via validationErrorHandler on a schema violation', async () => {
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
    app.use(validationErrorHandler);
    const request = testRequest(app);

    it('passes through when the required header is present', async () => {
      const res = await request.get('/').set('x-tenant', 'acme');

      expect(res.status).to.equal(200);
    });

    it('responds 400 via validationErrorHandler when the required header is missing', async () => {
      const res = await request.get('/');

      expect(res.status).to.equal(400);
    });
  });

  describe('a consumer-supplied error handler', () => {
    it("can check `instanceof ValidationError` (re-exported from 'joi') for its own response shape", async () => {
      const schema = Joi.object<{ name: string }>({
        name: Joi.string().required(),
      });
      const app = express();
      app.use(express.json());
      app.post('/', bodyValidator(schema), (req, res) =>
        res.status(200).json(req.body)
      );
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const customHandler: express.ErrorRequestHandler = (
        err,
        _req,
        res,
        next
      ) => {
        if (!(err instanceof Joi.ValidationError)) {
          next(err);
          return;
        }
        res.status(422).json({ code: 'BAD_INPUT', msg: err.message });
      };
      app.use(customHandler);
      const request = testRequest(app);

      const res = await request.post('/').send({});

      expect(res.status).to.equal(422);
      expect(res.body).to.include({ code: 'BAD_INPUT' });
    });
  });

  describe('validationErrorHandler', () => {
    it('forwards a non-ValidationError to the next error handler unchanged', async () => {
      const app = express();
      app.get('/', (_req, _res, next) => {
        next(new Error('boom'));
      });
      app.use(validationErrorHandler);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const fallback: express.ErrorRequestHandler = (err, _req, res, _next) => {
        res.status(500).json({ caught: (err as Error).message });
      };
      app.use(fallback);
      const request = testRequest(app);

      const res = await request.get('/');

      expect(res.status).to.equal(500);
      expect(res.body).to.eql({ caught: 'boom' });
    });
  });
});
