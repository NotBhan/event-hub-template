/**
 * HTTP errors that carry a status code.
 *
 * Services throw these; endpoints translate them into responses. Anything that
 * is not an `HttpError` is treated as an unexpected fault and reported as a 500
 * without leaking internals to the client.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(400, message, details);
    this.name = 'BadRequestError';
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message = 'You must sign in to continue') {
    super(401, message);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends HttpError {
  constructor(message = 'You do not have permission to do that') {
    super(403, message);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends HttpError {
  constructor(message = 'Not found') {
    super(404, message);
    this.name = 'NotFoundError';
  }
}

/** The requested quantity exceeds remaining inventory. */
export class ConflictError extends HttpError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(409, message, details);
    this.name = 'ConflictError';
  }
}

export class TooManyRequestsError extends HttpError {
  constructor(message = 'Too many requests. Please try again shortly.') {
    super(429, message);
    this.name = 'TooManyRequestsError';
  }
}

/** Everything relevant is sold out. */
export class SoldOutError extends ConflictError {
  constructor(message = 'Those tickets are no longer available') {
    super(message);
    this.name = 'SoldOutError';
  }
}
