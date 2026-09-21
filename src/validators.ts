// Joi ships as CJS with no static named exports Node's ESM loader can see
// -- `import { ValidationError } from 'joi'` throws at runtime under ESM
// even though it typechecks, since the .d.ts's named export doesn't
// reflect what the real module namespace object exposes. Destructuring
// off the default import works identically under both ESM and CJS.
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
 * Validates req.body against the given Joi schema, replacing it with the
 * validated (and possibly coerced/defaulted) value on success. Forwards
 * Joi's own ValidationError to `next` on failure, rather than responding
 * itself -- how that's turned into an HTTP response (status, body shape,
 * logging) is an app-wide concern, not something a per-field validator
 * should own. See `validationErrorHandler` for a ready-made one, or write
 * your own Express error-handling middleware that checks `err instanceof
 * ValidationError` (re-exported from 'joi').
 *
 * Checks `result.error` before ever reading `result.value` (rather than
 * destructuring both up front) -- Joi's own ValidationResult<T> types the
 * error branch's `value` as `any`, which would otherwise widen `value`'s
 * type for the whole union before the narrowing check ever runs.
 */
export function bodyValidator<T>(
  schema: Schema<T>,
  options: ValidationOptions = BODY_QUERY_OPTIONS
): express.RequestHandler {
  return (req, res, next) => {
    const result = schema.validate(req.body, options);
    if (result.error) {
      next(result.error);
      return;
    }
    req.body = result.value;
    next();
  };
}

/**
 * Same idea as bodyValidator, but for req.query. Express 5 turned
 * `req.query` into a getter-only computed property (no plain assignment
 * allowed, unlike Express 4) -- overriding it via defineProperty instead
 * works identically on both, since Express's own getter is declared
 * `configurable: true` specifically so it can be replaced.
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
 * Validates req.params against the given Joi schema. Unlike body/query,
 * this only validates -- req.params isn't replaced with the validated
 * value, since Express's own param parsing already owns that shape.
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

/** Same idea as paramValidator, but for req.headers. */
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
 * A ready-made terminal error handler for apps with no validation-error
 * formatting of their own: responds 400 with `{ message, details }` for
 * any Joi ValidationError forwarded by the validators above, and forwards
 * anything else to whatever error-handling middleware comes after it (or
 * Express's own default one, if none does). Mount it after your routes --
 * `app.use(validationErrorHandler)` -- or skip it entirely and write your
 * own that checks `err instanceof ValidationError` for a custom shape
 * (e.g. one matching an app-wide error envelope already used for every
 * other kind of error).
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
