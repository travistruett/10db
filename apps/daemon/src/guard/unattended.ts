import {
  Approval,
  approvalOf,
  JudgeKind,
  LimitName,
  SkipKind,
  type SkipKind as SkipKindValue,
} from '@10db/contracts';
import { skipMessage } from '../trust';
import type { GuardVerdict } from './judge';

// Trust line §5 (T4 calls 2–6, 23): in a lane nobody watches, every guard ask is answered at once by
// a table over its kind and the session's judge: handed to the judge that runs (a bare allow, so the
// permission mode decides), allowed, or skipped with a message the agent carries on from.

type ValueOf<T> = T[keyof T];

/** Why the guard asks: each is a card in an attended session. */
export const AskKind = {
  WebOrMcp: 'web_or_mcp',
  UnknownTool: 'unknown_tool',
  MonitorSocket: 'monitor_socket',
  MonitorNoCommand: 'monitor_no_command',
  ReadOutside: 'read_outside',
  SecretRead: 'secret_read',
  ConfigWrite: 'config_write',
  EditorConfigWrite: 'editor_config_write',
  HomeRcWrite: 'home_rc_write',
  UnreadEditPath: 'unread_edit_path',
  EndlessLoop: 'endless_loop',
  UnreadHazard: 'unread_hazard',
  PassGit: 'pass_git',
} as const;
export type AskKind = ValueOf<typeof AskKind>;

export const UnattendedOutcome = { ToJudge: 'to_judge', Skip: 'skip', Allow: 'allow' } as const;
export type UnattendedOutcome = ValueOf<typeof UnattendedOutcome>;

const O = UnattendedOutcome;

/** A judge that runs and reads the session's policy; `tendb` has no values until T5 (call 23). */
const judgeRuns = (judge: JudgeKind): boolean => {
  switch (judge) {
    case JudgeKind.Native:
      return true;
    case JudgeKind.Rules:
    case JudgeKind.Tendb:
      return false;
  }
};

/** What an ask of this kind becomes in an unattended lane on this judge. */
export function unattendedOutcome(kind: AskKind, judge: JudgeKind): UnattendedOutcome {
  switch (kind) {
    case AskKind.WebOrMcp:
    case AskKind.UnknownTool:
    case AskKind.MonitorSocket:
    case AskKind.EndlessLoop:
      return judgeRuns(judge) ? O.ToJudge : O.Skip;
    // Agent-written config runs before no approval (call 6): project hooks load in no sandboxed
    // session, `.mcp.json` by an approved hash, and definitions are copied cleaned.
    case AskKind.ConfigWrite:
      return O.Allow;
    // A Read runs in Claude Code's own process, where the kernel doesn't reach (call 5); the
    // classifier knows nothing of claims (call 3).
    case AskKind.MonitorNoCommand:
    case AskKind.ReadOutside:
    case AskKind.SecretRead:
    case AskKind.EditorConfigWrite:
    case AskKind.HomeRcWrite:
    case AskKind.UnreadEditPath:
    case AskKind.UnreadHazard:
    case AskKind.PassGit:
      return O.Skip;
  }
}

/** The limit a skipped ask would have crossed; null when it names none. */
export function limitOfAsk(kind: AskKind): LimitName | null {
  switch (kind) {
    case AskKind.WebOrMcp:
    case AskKind.MonitorSocket:
      return LimitName.SendsDataOut;
    case AskKind.SecretRead:
      return LimitName.ReadsSecrets;
    case AskKind.UnknownTool:
    case AskKind.MonitorNoCommand:
    case AskKind.ReadOutside:
    case AskKind.ConfigWrite:
    case AskKind.EditorConfigWrite:
    case AskKind.HomeRcWrite:
    case AskKind.UnreadEditPath:
    case AskKind.EndlessLoop:
    case AskKind.UnreadHazard:
    case AskKind.PassGit:
      return null;
  }
}

/** Why a skipped ask was skipped, in words the item lists; with a limit, the limit says it. */
function reasonOf(kind: AskKind, toolName: string, path: string | null, asked: string): string {
  const where = path ?? 'This path';
  switch (kind) {
    case AskKind.UnknownTool:
      return `${toolName} isn't a tool 10db can judge for a task nobody is watching.`;
    case AskKind.MonitorNoCommand:
      return 'Monitor needs a command to run.';
    case AskKind.ReadOutside:
      return `${where} is outside what a task reads without asking. Read it with a Bash command, which the sandbox bounds.`;
    case AskKind.EditorConfigWrite:
      return `${where} is editor config, which runs outside the sandbox when the builder opens the folder.`;
    case AskKind.HomeRcWrite:
      return `${where} is outside the checkout.`;
    case AskKind.UnreadEditPath:
      return 'The path of this edit could not be read; name it plainly.';
    case AskKind.EndlessLoop:
      return 'This starts something in the background that never ends.';
    case AskKind.UnreadHazard:
      return "10db can't read whether this changes a dependency or a migration this task hasn't claimed. Write the command out plainly, or claim the hazard first.";
    case AskKind.PassGit:
      return 'A commit, push or merge waits for the builder in a pass; nobody is here to allow it.';
    case AskKind.WebOrMcp:
    case AskKind.MonitorSocket:
    case AskKind.SecretRead:
    case AskKind.ConfigWrite:
      return asked;
  }
}

/** The skip kind each ask kind is recorded as: the same word. */
const skipKindOf = (kind: AskKind): SkipKindValue => {
  switch (kind) {
    case AskKind.WebOrMcp:
      return SkipKind.WebOrMcp;
    case AskKind.UnknownTool:
      return SkipKind.UnknownTool;
    case AskKind.MonitorSocket:
      return SkipKind.MonitorSocket;
    case AskKind.MonitorNoCommand:
      return SkipKind.MonitorNoCommand;
    case AskKind.ReadOutside:
      return SkipKind.ReadOutside;
    case AskKind.SecretRead:
      return SkipKind.SecretRead;
    case AskKind.ConfigWrite:
      return SkipKind.ConfigWrite;
    case AskKind.EditorConfigWrite:
      return SkipKind.EditorConfigWrite;
    case AskKind.HomeRcWrite:
      return SkipKind.HomeRcWrite;
    case AskKind.UnreadEditPath:
      return SkipKind.UnreadEditPath;
    case AskKind.EndlessLoop:
      return SkipKind.EndlessLoop;
    case AskKind.UnreadHazard:
      return SkipKind.UnreadHazard;
    case AskKind.PassGit:
      return SkipKind.PassGit;
  }
};

export interface UnattendedInput {
  readonly verdict: GuardVerdict;
  readonly judge: JudgeKind;
  readonly callKey: string;
  readonly approvedKeys: readonly string[];
  /** The path a file ask names, for its words. */
  readonly path: string | null;
  readonly toolName: string;
}

export interface UnattendedSkip {
  readonly kind: SkipKindValue;
  readonly limit: LimitName | null;
  readonly reason: string;
}

export interface UnattendedAnswer {
  readonly verdict: GuardVerdict;
  readonly skip: UnattendedSkip | null;
}

const BARE_ALLOW: GuardVerdict = { decision: 'allow' };

const skipped = (skip: UnattendedSkip): UnattendedAnswer => ({
  verdict: { decision: 'deny', reason: skipMessage(skip.limit, skip.reason) },
  skip,
});

/**
 * The guard's verdict as an unattended lane gets it: an ask is answered at once, by the table, and a
 * call the builder approved by its exact key goes on, on every judge. An ask with no kind is skipped
 * as a tool 10db can't judge, so nothing waits. Allows and other refusals pass unchanged.
 */
export function answerUnattended(input: UnattendedInput): UnattendedAnswer {
  const { verdict } = input;
  if (verdict.decision !== 'ask') return { verdict, skip: null };
  if (verdict.kind === undefined)
    return skipped({
      kind: SkipKind.UnknownTool,
      limit: null,
      reason: reasonOf(AskKind.UnknownTool, input.toolName, input.path, verdict.reason),
    });
  const { kind } = verdict;
  const skipKind = skipKindOf(kind);
  if (approvalOf(skipKind, false) === Approval.Exact && input.approvedKeys.includes(input.callKey))
    return { verdict: BARE_ALLOW, skip: null };
  switch (unattendedOutcome(kind, input.judge)) {
    case O.ToJudge:
    case O.Allow:
      return { verdict: BARE_ALLOW, skip: null };
    case O.Skip:
      return skipped({
        kind: skipKind,
        limit: limitOfAsk(kind),
        reason: reasonOf(kind, input.toolName, input.path, verdict.reason),
      });
  }
}
