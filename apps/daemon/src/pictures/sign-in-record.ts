import { Urgency, type ProjectId } from '@10db/contracts';
import {
  deleteAppSetting,
  findOpenByFoldKey,
  getAppSetting,
  setAppSetting,
  type DbReader,
} from '@10db/db';
import { z } from 'zod';
import type { StateStore } from '../events';
import { CardTier, type InboxService } from '../inbox';
import type { SignInFailure } from './sign-in';

// A picture sign-in that fails reaches the builder, and the task's updates: one Inbox card per project, and a
// record the Linear and Slack updates read to say the pictures were skipped and why. A sign-in that next
// succeeds withdraws the card and clears the record.

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
const foldKeyOf = (projectId: ProjectId): string => `pictures-sign-in:${projectId}`;

/** The project's failed sign-in, or null when its last one succeeded or none failed. */
export function signInRecordOf(db: DbReader, projectId: ProjectId): SignInRecord | null {
  const parsed = SignInRecord.safeParse(getAppSetting(db, recordKey(projectId)));
  return parsed.success ? parsed.data : null;
}

/** The card's words: the command, its exit code and the last lines of its output. */
function cardBody(record: SignInRecord): string {
  return [
    `Pictures of this project's tasks are skipped until the dev login signs in. ${record.problem}.`,
    record.command === null ? null : `Command: ${record.command}`,
    record.exitCode === null ? null : `Exit code: ${String(record.exitCode)}`,
    record.tail === ''
      ? 'It printed nothing 10db may show.'
      : `Last lines of its output:\n${record.tail}`,
    'Fix the command in Settings › App Preview. The next picture signs in again, and this card goes when one succeeds.',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

export interface SignInReporter {
  /** A sign-in failed: keeps the record and raises the project's one card (refreshed when its words change). */
  failed(projectId: ProjectId, problem: string, failure: SignInFailure | null, at: string): void;
  /** A sign-in succeeded: clears the record and withdraws the card. */
  succeeded(projectId: ProjectId): void;
}

export function createSignInReporter(deps: {
  readonly state: StateStore;
  readonly inbox: Pick<InboxService, 'flag' | 'withdraw'>;
}): SignInReporter {
  return {
    failed(projectId, problem, failure, at) {
      const record: SignInRecord = {
        problem,
        command: failure?.command ?? null,
        exitCode: failure?.exitCode ?? null,
        tail: failure?.tail ?? '',
        at,
      };
      deps.state.write((ctx) => {
        setAppSetting(ctx, recordKey(projectId), record);
      });
      const body = cardBody(record);
      const open = findOpenByFoldKey(deps.state.db, projectId, foldKeyOf(projectId));
      deps.inbox.flag({
        projectId,
        workstreamId: null,
        tier: CardTier.Ask,
        urgency: Urgency.Normal,
        closesWhen: {
          by: 'withdrawn',
          when: 'a picture sign-in succeeds (pictures/sign-in-record)',
        },
        title: 'Pictures Cannot Sign In',
        body,
        foldKey: foldKeyOf(projectId),
        // A repeat with the same words changes nothing the builder sees.
        ...(open?.body === body ? {} : { refresh: true }),
      });
    },

    succeeded(projectId) {
      if (signInRecordOf(deps.state.db, projectId) !== null)
        deps.state.write((ctx) => {
          deleteAppSetting(ctx, recordKey(projectId));
        });
      const open = findOpenByFoldKey(deps.state.db, projectId, foldKeyOf(projectId));
      if (open !== undefined) deps.inbox.withdraw(open.id);
    },
  };
}
