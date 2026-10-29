import type { WorkstreamId } from './ids';

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

/** An answer the card's kind can't accept as given, such as Send Back without a note. */
export class InboxAnswerRefused extends DomainError {
  override readonly name = 'InboxAnswerRefused';
  constructor(message: string) {
    super('invalid', message);
  }
}

/**
 * A task that has run, or is running, can't be removed from the board. A live workstream is
 * cancelled through its own route; one that already ended leaves the task as it is.
 */
export class TaskStartedError extends DomainError {
  override readonly name = 'TaskStartedError';
  constructor(title: string, run: { readonly id: WorkstreamId; readonly live: boolean } | null) {
    super(
      'conflict',
      run === null
        ? `Task ${title} is finished and can't be removed`
        : run.live
          ? `Task ${title} has started; cancel its workstream ${run.id} instead (POST /workstreams/${run.id}/cancel)`
          : `Task ${title} has already run (workstream ${run.id}) and can't be removed`,
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
