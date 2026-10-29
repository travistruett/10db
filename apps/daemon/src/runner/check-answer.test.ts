import { DomainError } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { RunnerNotStartedError } from './check-answer';

describe('RunnerNotStartedError', () => {
  it('is a conflict, so a check answered before the runner exists answers 409', () => {
    const error = new RunnerNotStartedError();
    expect(error).toBeInstanceOf(DomainError);
    expect(error.code).toBe('conflict');
  });
});
