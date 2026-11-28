import { isInsideClaudeCodeBookkeeping } from '../git';

/** What a guardrail file does for the builder: the thing a change to it could loosen. */
export const GuardrailKind = {
  GitGuard: 'git_guard',
  CodexRules: 'codex_rules',
  SandboxProfile: 'sandbox_profile',
  JudgePolicy: 'judge_policy',
  TrustGrant: 'trust_grant',
  StandingApproval: 'standing_approval',
  McpServers: 'mcp_servers',
  Hooks: 'hooks',
  CiWorkflows: 'ci_workflows',
} as const;
export type GuardrailKind = (typeof GuardrailKind)[keyof typeof GuardrailKind];

export interface GuardrailRow {
  readonly kind: GuardrailKind;
  /** How a card names it: "git guard", as in "A change to your git guard is ready". */
  readonly label: string;
  matches(rel: string): boolean;
}

/** A directory row matches the directory itself and everything under it. */
function directory(dir: string): (rel: string) => boolean {
  return (rel) => rel === dir || rel.startsWith(`${dir}/`);
}

function file(path: string): (rel: string) => boolean {
  return (rel) => rel === path;
}

/** Lefthook's accepted config names at the repository root, its local overrides included. */
const LEFTHOOK_CONFIG = /^\.?lefthook(-local)?\.ya?ml$/;

function anyOf(...tests: readonly ((rel: string) => boolean)[]): (rel: string) => boolean {
  return (rel) => tests.some((test) => test(rel));
}

/**
 * The paths whose change the builder alone owns, as repository-relative paths with `/` separators. A file has
 * one kind: the first row that matches, so a specific file listed before `.claude/**` keeps its own kind.
 */
export const GUARDRAIL_PATHS: readonly GuardrailRow[] = [
  { kind: GuardrailKind.GitGuard, label: 'git guard', matches: directory('.claude/hooks') },
  { kind: GuardrailKind.CodexRules, label: 'Codex rules', matches: directory('.codex/rules') },
  {
    kind: GuardrailKind.StandingApproval,
    label: 'standing approvals',
    matches: file('.claude/settings.json'),
  },
  {
    kind: GuardrailKind.JudgePolicy,
    label: 'judge policy',
    matches: file('.claude/settings.local.json'),
  },
  {
    kind: GuardrailKind.SandboxProfile,
    label: 'sandbox profile',
    matches: file('.codex/config.toml'),
  },
  { kind: GuardrailKind.TrustGrant, label: 'trust grants', matches: file('.10db/mcp-hosts.json') },
  { kind: GuardrailKind.McpServers, label: 'MCP servers', matches: file('.mcp.json') },
  {
    kind: GuardrailKind.Hooks,
    label: 'hooks',
    matches: anyOf(directory('.git/hooks'), directory('.claude'), directory('.codex'), (rel) =>
      LEFTHOOK_CONFIG.test(rel),
    ),
  },
  {
    kind: GuardrailKind.CiWorkflows,
    label: 'CI workflows',
    matches: anyOf(directory('.github/workflows'), directory('.github/rulesets')),
  },
];

/**
 * The guardrail a path belongs to, or null. Claude Code's own bookkeeping matches no row: it writes there
 * unasked and never reads it back as config.
 */
export function guardrailOf(rel: string): { kind: GuardrailKind; label: string } | null {
  if (isInsideClaudeCodeBookkeeping(rel)) return null;
  const row = GUARDRAIL_PATHS.find((candidate) => candidate.matches(rel));
  return row ? { kind: row.kind, label: row.label } : null;
}

/** Every path of `paths` that is a guardrail, in order, with its kind and label. */
export function guardrailHits(
  paths: readonly string[],
): { path: string; kind: GuardrailKind; label: string }[] {
  const hits: { path: string; kind: GuardrailKind; label: string }[] = [];
  for (const path of paths) {
    const found = guardrailOf(path);
    if (found) hits.push({ path, ...found });
  }
  return hits;
}
