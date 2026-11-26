import type { ProjectId } from '@10db/contracts';
import { deleteAppSetting, getAppSetting, setAppSetting, type DbReader } from '@10db/db';
import { z } from 'zod';
import type { StateStore } from '../events';

// A picture sign-in that fails leaves a record the Linear and Slack updates read to say the pictures were
// skipped and why; a sign-in that next succeeds clears it. The builder's card is `inbox/sign-in-card.ts`.

const SignInRecord = z.object({
  problem: z.string(),
  command: z.string().nullable(),
  exitCode: z.number().nullable(),
  tail: z.string(),
  at: z.string(),
});

/** The latest failed picture sign-in of a project. */
export type SignInRecord = z.infer<typeof SignInRecord>;

const recordKey = (projectId: ProjectId): string => `pictures-sign-in.${projectId}`;

/** The project's failed sign-in, or null when its last one succeeded or none failed. */
export function signInRecordOf(db: DbReader, projectId: ProjectId): SignInRecord | null {
  const parsed = SignInRecord.safeParse(getAppSetting(db, recordKey(projectId)));
  return parsed.success ? parsed.data : null;
}

export interface SignInReporter {
  /** A sign-in failed: keeps the record. `command` is null when the command never ran. */
  failed(
    projectId: ProjectId,
    command: string | null,
    failure: {
      readonly problem: string;
      readonly exitCode: number | null;
      readonly output: string;
    },
    at: string,
  ): void;
  /** A sign-in succeeded: clears the record. */
  succeeded(projectId: ProjectId): void;
}

export function createSignInReporter(deps: { readonly state: StateStore }): SignInReporter {
  return {
    failed(projectId, command, failure, at) {
      const record: SignInRecord = {
        problem: failure.problem,
        command,
        exitCode: failure.exitCode,
        tail: failure.output,
        at,
      };
      deps.state.write((ctx) => {
        setAppSetting(ctx, recordKey(projectId), record);
      });
    },

    succeeded(projectId) {
      if (signInRecordOf(deps.state.db, projectId) !== null)
        deps.state.write((ctx) => {
          deleteAppSetting(ctx, recordKey(projectId));
        });
    },
  };
}
