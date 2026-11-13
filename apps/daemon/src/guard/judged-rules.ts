import { JudgeKind } from '@10db/contracts';
import { decodeAnsiC } from './ansi-c';

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
 * (which settles a call before a judge sees it) but for a deploy, which the allow rule lets run, and, for a rule about shell text, when the text
 * names git, gh or `.git`: a push or a merge has no kernel bound, only closed credentials, so a
 * command that names one keeps every judged shell refusal. A command that names `sudo` keeps them
 * too, so a `sudo` in a segment the guard can't read is never handed to a judge.
 */
export function judgedRuleApplies(rule: JudgedRule, ctx: JudgedContext): boolean {
  // The builder's own allow rule wins over the deploy rule, as an allow rule does in Claude Code.
  if (rule === JudgedRule.Deploy && ctx.coveredByAllowRule) return false;
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
const ANSI_C_WORD = /\$'((?:[^'\\]|\\[\s\S])*)'/g;
/** A substitution or parameter with nothing of its own kind inside: the innermost of a nest. */
const INNERMOST_EXPANSION = /\$\([^()]*\)|\$\{[^{}]*\}|`[^`]*`/g;
/** Enough rounds for any nest a person writes; a deeper one keeps what is left as text. */
const EXPANSION_ROUNDS = 32;

/**
 * The text as the shell may join it into one word: each ANSI-C `$'…'` decoded, each `$(…)`,
 * backtick pair and `${…}` dropped with what it holds (empty or not, nested ones from the inside
 * out), then every quote, a locale quote's `$` and backslash taken out.
 */
function joinedText(command: string): string {
  let text = command.replaceAll(ANSI_C_WORD, (_, body: string) => decodeAnsiC(body).text);
  for (let round = 0; round < EXPANSION_ROUNDS; round += 1) {
    const dropped = text.replaceAll(INNERMOST_EXPANSION, '');
    if (dropped === text) break;
    text = dropped;
  }
  return text.replaceAll(/\$(?=")|['"\\]/g, '');
}

/**
 * Whether the command text holds `sudo` as a word, read as the shell may join it (`joinedText`),
 * so `s''udo`, `s$()udo`, `s${x}udo` and `$'\x73udo'` count too. A word built at run time (a
 * decode-and-run, a substitution that prints part of it) is not read: there the bound is the
 * classifier and sudo's password prompt, which a session can't answer.
 */
export function namesSudo(command: string): boolean {
  return NAMES_SUDO.test(command) || NAMES_SUDO.test(joinedText(command));
}
