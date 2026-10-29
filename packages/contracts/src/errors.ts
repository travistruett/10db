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

/** A task that has run, or is running, can't be removed from the board; its workstream is cancelled instead. */
export class TaskStartedError extends DomainError {
  override readonly name = 'TaskStartedError';
  constructor(title: string, workstreamId: string | null) {
    super(
      'conflict',
      workstreamId === null
        ? `Task ${title} is finished and can't be removed`
        : `Task ${title} has started; cancel its workstream ${workstreamId} instead (POST /workstreams/${workstreamId}/cancel)`,
    );
  }
}

/** A task that open tasks wait on can't be removed: they would wait for ever. */
export class TaskHasDependentsError extends DomainError {
  override readonly name = 'TaskHasDependentsError';
  constructor(title: string, dependents: readonly string[]) {
    super(
      'conflict',
      `Task ${title} can't be removed while ${dependents.join(', ')} wait${dependents.length === 1 ? 's' : ''} on it; remove ${dependents.length === 1 ? 'that task' : 'those tasks'} first`,
    );
  }
}
