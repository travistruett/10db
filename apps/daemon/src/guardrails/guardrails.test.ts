import { BuilderOwns } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { GUARDRAIL_PATHS, GuardrailKind, guardrailHits, guardrailOf } from './paths';
import { OwnershipQuestion, ownershipTest } from './ownership';

describe('the guardrail path list', () => {
  it('answers each row its kind and label, the first matching row winning', () => {
    const cases: [string, GuardrailKind, string][] = [
      ['.claude/hooks/git-guard.mjs', GuardrailKind.GitGuard, 'git guard'],
      ['.codex/rules/default.rules', GuardrailKind.CodexRules, 'Codex rules'],
      ['.claude/settings.json', GuardrailKind.StandingApproval, 'standing approvals'],
      ['.claude/settings.local.json', GuardrailKind.JudgePolicy, 'judge policy'],
      ['.codex/config.toml', GuardrailKind.SandboxProfile, 'sandbox profile'],
      ['.10db/mcp-hosts.json', GuardrailKind.TrustGrant, 'trust grants'],
      ['.mcp.json', GuardrailKind.McpServers, 'MCP servers'],
      ['.git/hooks/pre-push', GuardrailKind.Hooks, 'hooks'],
      ['lefthook.yml', GuardrailKind.Hooks, 'hooks'],
      ['lefthook-local.yml', GuardrailKind.Hooks, 'hooks'],
      ['.lefthook.yaml', GuardrailKind.Hooks, 'hooks'],
      ['.claude/agents/implementer.md', GuardrailKind.Hooks, 'hooks'],
      ['.codex/agents/implementer.toml', GuardrailKind.Hooks, 'hooks'],
      ['.github/workflows/ci.yml', GuardrailKind.CiWorkflows, 'CI workflows'],
      ['.github/rulesets/main.json', GuardrailKind.CiWorkflows, 'CI workflows'],
    ];
    for (const [path, kind, label] of cases) {
      expect(guardrailOf(path), path).toEqual({ kind, label });
    }
    expect(GUARDRAIL_PATHS.map((row) => row.kind)).toEqual([
      GuardrailKind.GitGuard,
      GuardrailKind.CodexRules,
      GuardrailKind.StandingApproval,
      GuardrailKind.JudgePolicy,
      GuardrailKind.SandboxProfile,
      GuardrailKind.TrustGrant,
      GuardrailKind.McpServers,
      GuardrailKind.Hooks,
      GuardrailKind.CiWorkflows,
    ]);
  });

  it('matches a directory row on the directory itself and what is under it, not a sibling', () => {
    expect(guardrailOf('.claude/hooks')?.kind).toBe(GuardrailKind.GitGuard);
    expect(guardrailOf('.claude/hooks-old/x')?.kind).toBe(GuardrailKind.Hooks);
    expect(guardrailOf('.github/workflows-notes.md')).toBeNull();
  });

  it('answers null for ordinary paths, instructions, secrets and Claude Code bookkeeping', () => {
    for (const path of [
      'src/app.ts',
      'AGENTS.md',
      '.env',
      '.git/config',
      'apps/daemon/lefthook.yml',
      '.claude/.cc-writes/x.tmp',
      '.claude/hooks/.claude/.cc-writes/x.tmp',
    ]) {
      expect(guardrailOf(path), path).toBeNull();
    }
  });

  it('reports each hit with its path, kind and label', () => {
    expect(guardrailHits(['src/a.ts', '.mcp.json', '.github/workflows/ci.yml'])).toEqual([
      { path: '.mcp.json', kind: GuardrailKind.McpServers, label: 'MCP servers' },
      { path: '.github/workflows/ci.yml', kind: GuardrailKind.CiWorkflows, label: 'CI workflows' },
    ]);
    expect(guardrailHits(['src/a.ts'])).toEqual([]);
  });
});

describe('the ownership test', () => {
  const no = { yes: false, confidence: 1 };

  it('keeps Guardrails for a path hit whatever the judge reads', () => {
    const result = ownershipTest({
      guardrailHits: 1,
      judged: {
        [OwnershipQuestion.OneWayDoor]: no,
        [OwnershipQuestion.ProductAndTaste]: no,
        [OwnershipQuestion.Promise]: no,
      },
      floor: 0.8,
    });
    expect(result.owns).toEqual([BuilderOwns.Guardrails]);
    expect(result.doubt).toEqual([]);
  });

  it('adds an owner for a yes at the floor, and treats a yes below it or no answer as doubt', () => {
    const result = ownershipTest({
      guardrailHits: 0,
      judged: {
        [OwnershipQuestion.OneWayDoor]: { yes: true, confidence: 0.8 },
        [OwnershipQuestion.ProductAndTaste]: { yes: true, confidence: 0.79 },
        [OwnershipQuestion.Promise]: null,
      },
      floor: 0.8,
    });
    expect(result.owns).toEqual([BuilderOwns.OneWayDoor]);
    expect(result.doubt).toEqual([OwnershipQuestion.ProductAndTaste, OwnershipQuestion.Promise]);
  });

  it('removes nothing for a confident no', () => {
    const result = ownershipTest({
      guardrailHits: 0,
      judged: { [OwnershipQuestion.Promise]: no },
      floor: 0.8,
    });
    expect(result).toEqual({ owns: [], doubt: [] });
  });
});
