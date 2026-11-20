export type ErrorCode = 'validation' | 'not_found' | 'forbidden' | 'unauthenticated' | 'conflict' | 'unavailable';

const STATUS: Record<ErrorCode, number> = {
  validation: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unavailable: 503,
};

/** Single error type used across layers; the HTTP layer maps `code` to a status. */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }

  get status(): number {
    return STATUS[this.code];
  }

  static validation(message: string, details?: Record<string, unknown>) {
    return new AppError('validation', message, details);
  }
  static notFound(what: string) {
    return new AppError('not_found', `${what} not found`);
  }
  static forbidden(message = 'You do not have access to this resource') {
    return new AppError('forbidden', message);
  }
  static unauthenticated(message = 'Authentication required') {
    return new AppError('unauthenticated', message);
  }
  static conflict(message: string) {
    return new AppError('conflict', message);
  }
}

/** Wire format of every error response. */
export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: Record<string, unknown> };
}
