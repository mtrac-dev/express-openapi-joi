import type { Schema, ValidationError, ValidationOptions } from 'joi';
import type express from 'express';

const BODY_QUERY_OPTIONS: ValidationOptions = {
  abortEarly: false,
  stripUnknown: true,
};
const PARAM_HEADER_OPTIONS: ValidationOptions = {
  abortEarly: false,
  allowUnknown: true,
  stripUnknown: false,
};

function validationErrorResponse(
  res: express.Response,
  error: ValidationError
) {
  res.status(400).json({ message: error.message, details: error.details });
}

/**
 * Validates req.body against the given Joi schema, replacing it with the
 * validated (and possibly coerced/defaulted) value on success. Ends the
 * request with 400 on failure.
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
      validationErrorResponse(res, result.error);
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
      validationErrorResponse(res, result.error);
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
      validationErrorResponse(res, error);
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
      validationErrorResponse(res, error);
      return;
    }
    next();
  };
}
