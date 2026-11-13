import type { LimitName } from '@10db/contracts';

/** The call a go-ahead names: the tool and the whole of what it was asked to do. */
export interface GoAheadCall {
  readonly toolName: string;
  readonly summary: string;
}

/** A call the agent's judge denied, as the session reports it. */
export interface DeniedCall extends GoAheadCall {
  readonly toolUseId: string;
  /** Claude Code's reason for the denial, or its message when it gave none. */
  readonly reason: string;
  /** Who denied it: auto mode's classifier, or one of Claude Code's own safety checks. */
  readonly by: 'classifier' | 'safety_check';
  /** The limit the reason names; null when it names none, which is the usual case. */
  readonly limit: LimitName | null;
}

/**
 * The longest call a single go-ahead names whole. A longer one is shown cut and never offered:
 * the go-ahead must carry the exact action.
 */
export const ALLOW_THIS_MAX_CHARS = 4000;

/**
 * The text in a Markdown code fence one backtick longer than the longest run of backticks inside it
 * (three at least), so nothing in the text can end the fence early.
 */
export function fenced(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

/**
 * The builder's go-ahead for one denied call. It names the exact action, as Claude Code's rule for a
 * user's explicit request for that action needs before a soft deny yields.
 */
export function goAheadText(call: GoAheadCall): string {
  return `I approve this exact ${call.toolName} call. Run it again as it was:\n\n${fenced(call.summary)}`;
}

/** What a pass's thread says about a call auto mode denied, and what the builder can do about it. */
export function deniedNoticeText(call: DeniedCall, offersAllowThis: boolean): string {
  const shown =
    call.summary.length > ALLOW_THIS_MAX_CHARS
      ? `${call.summary.slice(0, ALLOW_THIS_MAX_CHARS)} (cut)`
      : call.summary;
  const head = `Auto mode stopped this ${call.toolName} call:\n\n${fenced(shown)}\n\nIts reason: ${call.reason}`;
  if (offersAllowThis)
    return `${head}\n\nAllow this sends your go-ahead. If auto mode refuses it again, it is a line Claude Code holds whatever you say.`;
  switch (call.by) {
    case 'safety_check':
      return `${head}\n\nThis is one of Claude Code's own safety checks; only you can run it, in a terminal.`;
    case 'classifier':
      return head;
  }
}

/**
 * Whether a denied call gets Allow this: the classifier's, short enough to name whole, and known by
 * more than its tool name (a call the hook never saw has only that, which a go-ahead cannot name).
 */
export function offersAllowThis(call: DeniedCall): boolean {
  return (
    call.by === 'classifier' &&
    call.summary !== call.toolName &&
    call.summary.length <= ALLOW_THIS_MAX_CHARS
  );
}
