export type DomainErrorCode = 'not_found' | 'conflict' | 'invalid';

/** An error the API maps to an HTTP status; its message is safe to show the builder. */
export class DomainError extends Error {
  override readonly name: string = 'DomainError';
  // A declared field, not a parameter property: `erasableSyntaxOnly` rejects those.
  readonly code: DomainErrorCode;
  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export class NotFoundError extends DomainError {
  override readonly name = 'NotFoundError';
  constructor(entity: string, id: string) {
    super('not_found', `${entity} ${id} not found`);
  }
}

export class ConflictError extends DomainError {
  override readonly name = 'ConflictError';
  constructor(message: string) {
    super('conflict', message);
  }
}

export class InvalidError extends DomainError {
  override readonly name = 'InvalidError';
  constructor(message: string) {
    super('invalid', message);
  }
}
