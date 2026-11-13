import { JudgeKind } from '@10db/contracts';

/**
 * The guard's refusals and cards that a judge which runs may take over. Every other guard rule
 * (protected paths, claims, git and gh, `sudo`, `allowed_domains`, `rm -r` of `.git`) applies under
 * every judge.
 */
export const JudgedRule = {
  Deploy: 'deploy',
  UnreadShell: 'unread_shell',
  PipeIntoShell: 'pipe_into_shell',
  UnjudgedRm: 'unjudged_rm',
  OutOfProxyTool: 'out_of_proxy_tool',
  ReviewedTool: 'reviewed_tool',
  MonitorSocket: 'monitor_socket',
} as const;
export type JudgedRule = (typeof JudgedRule)[keyof typeof JudgedRule];

export interface JudgedContext {
  readonly judge: JudgeKind;
  /** An allow rule of the session settles the call before a judge sees it. */
  readonly coveredByAllowRule: boolean;
  /** The command's text names git, gh or `.git` (`namesGitOrGh`). */
  readonly namesGit: boolean;
  /** The command's text names `sudo` (`namesSudo`), which is never allowed under any judge. */
  readonly namesSudo: boolean;
}

/** Whether a judge, and not the guard's text rules, settles the call. */
function judgeRuns(judge: JudgeKind): boolean {
  switch (judge) {
    case JudgeKind.Native:
    case JudgeKind.Tendb:
      return true;
    case JudgeKind.Rules:
      return false;
  }
}

/**
 * Whether the guard applies `rule` to this call. It does on the `rules` floor, under an allow rule
 * (which settles a call before a judge sees it), and, for a rule about shell text, when the text
 * names git, gh or `.git`: a push or a merge has no kernel bound, only closed credentials, so a
 * command that names one keeps every judged shell refusal. A command that names `sudo` keeps them
 * too, so a `sudo` in a segment the guard can't read is never handed to a judge.
 */
export function judgedRuleApplies(rule: JudgedRule, ctx: JudgedContext): boolean {
  if (!judgeRuns(ctx.judge) || ctx.coveredByAllowRule) return true;
  switch (rule) {
    case JudgedRule.Deploy:
    case JudgedRule.UnreadShell:
    case JudgedRule.PipeIntoShell:
    case JudgedRule.UnjudgedRm:
      return ctx.namesGit || ctx.namesSudo;
    case JudgedRule.OutOfProxyTool:
    case JudgedRule.ReviewedTool:
    case JudgedRule.MonitorSocket:
      return false;
  }
}

const NAMES_GIT_OR_GH = /(^|[^A-Za-z0-9_-])(git|gh)([^A-Za-z0-9_-]|$)|\.git/;

/**
 * Whether the raw command text, nested scripts and here-documents included, holds `git` or `gh` as
 * a word or `.git` anywhere. It reads text, not words, so no spelling the shell parser misreads
 * hides a name from it.
 */
export function namesGitOrGh(command: string): boolean {
  return NAMES_GIT_OR_GH.test(command);
}

const NAMES_SUDO = /(^|[^A-Za-z0-9_-])sudo([^A-Za-z0-9_-]|$)/;

/**
 * Whether the raw command text holds `sudo` as a word, read with every quote and backslash taken
 * out first, so `s''udo` and `s\udo`, which a shell reads as `sudo`, count too.
 */
export function namesSudo(command: string): boolean {
  return NAMES_SUDO.test(command.replaceAll(/['"\\]/g, ''));
}
