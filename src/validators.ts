// Joi is CommonJS, so `import { ValidationError } from 'joi'` type-checks but
// is undefined under ESM. Use the default import.
import Joi from 'joi';
import type { Schema, ValidationOptions } from 'joi';
import type express from 'express';

const { ValidationError } = Joi;

const BODY_QUERY_OPTIONS: ValidationOptions = {
  abortEarly: false,
  stripUnknown: true,
};
const PARAM_HEADER_OPTIONS: ValidationOptions = {
  abortEarly: false,
  allowUnknown: true,
  stripUnknown: false,
};

/**
 * Create middleware that validates `req.body` against `schema`.
 *
 * @remarks
 * On success, `req.body` is replaced with the validated value, including
 * defaults and conversions. On failure, Joi's `ValidationError` is passed to
 * `next` for the app's error handler, such as `validationErrorHandler`.
 */
export function bodyValidator<T>(
  schema: Schema<T>,
  options: ValidationOptions = BODY_QUERY_OPTIONS
): express.RequestHandler {
  return (req, res, next) => {
    const result = schema.validate(req.body, options);
    // Check `error` before reading `value`: Joi types the error branch's
    // `value` as `any`, so destructuring first would widen it.
    if (result.error) {
      next(result.error);
      return;
    }
    req.body = result.value;
    next();
  };
}

/**
 * Create middleware that validates `req.query` against `schema`, and replaces
 * it with the validated value.
 *
 * @remarks
 * Express 5 makes `req.query` a getter, so the value is set with
 * `Object.defineProperty`, which also works on Express 4.
 */
export function queryValidator<T>(
  schema: Schema<T>,
  options: ValidationOptions = BODY_QUERY_OPTIONS
): express.RequestHandler {
  return (req, res, next) => {
    const result = schema.validate(req.query, options);
    if (result.error) {
      next(result.error);
      return;
    }
    Object.defineProperty(req, 'query', {
      value: result.value,
      configurable: true,
      enumerable: true,
    });
    next();
  };
}

/**
 * Create middleware that validates `req.params` against `schema`.
 *
 * @remarks
 * `req.params` isn't replaced with the validated value.
 */
export function paramValidator<T>(
  schema: Schema<T>,
  options: ValidationOptions = PARAM_HEADER_OPTIONS
): express.RequestHandler {
  return (req, res, next) => {
    const { error } = schema.validate(req.params, options);
    if (error) {
      next(error);
      return;
    }
    next();
  };
}

/**
 * Create middleware that validates `req.headers` against `schema`.
 *
 * @remarks
 * `req.headers` isn't replaced with the validated value.
 */
export function headerValidator<T>(
  schema: Schema<T>,
  options: ValidationOptions = PARAM_HEADER_OPTIONS
): express.RequestHandler {
  return (req, res, next) => {
    const { error } = schema.validate(req.headers, options);
    if (error) {
      next(error);
      return;
    }
    next();
  };
}

/**
 * Respond `400 { message, details }` to a Joi `ValidationError`, and pass any
 * other error on.
 *
 * @remarks
 * Mount it after your routes.
 *
 * @example
 * ```ts
 * app.use(validationErrorHandler);
 * ```
 */
export const validationErrorHandler: express.ErrorRequestHandler = (
  err,
  _req,
  res,
  next
) => {
  if (!(err instanceof ValidationError)) {
    next(err);
    return;
  }
  res.status(400).json({ message: err.message, details: err.details });
};
