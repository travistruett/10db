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

/** The text with every quote, a locale quote's `$` and backslash taken out. */
function withoutQuotes(text: string): string {
  return text.replaceAll(/\$(?=")|['"\\]/g, '');
}

/** The text with each ANSI-C `$'…'` word replaced by what it decodes to. */
function decodedAnsiC(text: string): string {
  return text.replaceAll(ANSI_C_WORD, (_, body: string) => decodeAnsiC(body).text);
}

/**
 * The text with each `$(…)`, backtick pair and `${…}` dropped with what it holds (empty or not,
 * nested ones from the inside out). Decoded text is read this way too: a shell that a decoded word
 * is fed to (`echo $'s\x24(x)'udo | sh`) expands it.
 */
function withoutExpansions(text: string): string {
  let current = text;
  for (let round = 0; round < EXPANSION_ROUNDS; round += 1) {
    const dropped = current.replaceAll(INNERMOST_EXPANSION, '');
    if (dropped === current) break;
    current = dropped;
  }
  return current;
}

/**
 * The readings of the text in which a shell may join `sudo` into one word. Each is read on its own,
 * so a reading only adds a match: dropping an expansion never hides what another reading sees.
 */
function sudoReadings(command: string): string[] {
  const dropped = withoutExpansions(command);
  return [
    command,
    withoutQuotes(command),
    withoutQuotes(decodedAnsiC(command)),
    withoutQuotes(withoutExpansions(decodedAnsiC(command))),
    withoutQuotes(dropped),
    withoutQuotes(decodedAnsiC(dropped)),
    withoutQuotes(withoutExpansions(decodedAnsiC(dropped))),
  ];
}

/**
 * Whether the command text holds `sudo` as a word in any of its readings (`sudoReadings`), so
 * `s''udo`, `s$()udo`, `s${x}udo` and `$'\x73udo'` count too. No further spelling is read (a
 * decode-and-run, a substitution that prints part of the word, base64): for those the bound is the
 * classifier plus sudo's password prompt, which a session can't answer.
 */
export function namesSudo(command: string): boolean {
  return sudoReadings(command).some((reading) => NAMES_SUDO.test(reading));
}
