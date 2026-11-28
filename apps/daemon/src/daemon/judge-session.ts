import { AccountKind, type ProjectId } from '@10db/contracts';
import { getAccountRow, getProject, getTask, getWorkstream } from '@10db/db';
import type { SessionAsker, SessionScope } from '../judge';
import { prepareProjectQuestion, type ProjectQuestionDeps } from './project-question';

/** How many session judge questions run at once: each starts a CLI on the builder's plan. */
const SESSION_JUDGE_CONCURRENCY = 2;

/** The plan logins a judge question is asked on when no Decisions account is set. */
const PLAN_KINDS: ReadonlySet<AccountKind> = new Set([
  AccountKind.ClaudeSubscription,
  AccountKind.CodexSignin,
]);

/** Waits for one of `limit` places; the wait ends at once, rejecting, when `signal` aborts. */
function createGate(limit: number): (signal: AbortSignal) => Promise<() => void> {
  let running = 0;
  const waiting: (() => void)[] = [];
  const release = (): void => {
    running -= 1;
    waiting.shift()?.();
  };
  return (signal) =>
    new Promise((resolve, reject) => {
      const take = (): void => {
        signal.removeEventListener('abort', onAbort);
        running += 1;
        resolve(release);
      };
      const onAbort = (): void => {
        const at = waiting.indexOf(take);
        if (at !== -1) waiting.splice(at, 1);
        reject(signal.reason instanceof Error ? signal.reason : new Error('Stopped'));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      if (running < limit) {
        take();
        return;
      }
      waiting.push(take);
      signal.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * The judge's session asker: a call's project (its own, its task's, or its workstream's task's) asked on its own
 * account when that is a Claude or ChatGPT/Codex plan login. Null for any other account, a project that can't be
 * found, or an account that can't take a question now. A queued question waits under the call's own signal, so
 * overload ends as the call's timeout, never a hang.
 */
export function createSessionJudge(
  deps: ProjectQuestionDeps,
): (scope: SessionScope) => SessionAsker | null {
  const enter = createGate(SESSION_JUDGE_CONCURRENCY);
  const projectOf = (scope: SessionScope): ProjectId | null => {
    if (scope.projectId !== undefined) return scope.projectId;
    if (scope.taskId !== undefined) return getTask(deps.db, scope.taskId).projectId;
    if (scope.workstreamId !== undefined)
      return getTask(deps.db, getWorkstream(deps.db, scope.workstreamId).taskId).projectId;
    return null;
  };
  return (scope) => {
    try {
      const projectId = projectOf(scope);
      if (projectId === null) return null;
      const account = getAccountRow(deps.db, getProject(deps.db, projectId).accountId);
      if (!PLAN_KINDS.has(account.kind)) return null;
      const prepared = prepareProjectQuestion(deps, projectId);
      if (prepared.kind === 'declined') return null;
      return {
        model: prepared.model,
        ask: async (prompt, opts) => {
          const leave = await enter(opts.signal);
          try {
            return await prepared.ask(prompt, opts);
          } finally {
            leave();
          }
        },
      };
    } catch {
      return null;
    }
  };
}
