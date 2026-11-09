import {
  AgentCopyState,
  type AgentCopy,
  type SystemCheckDto,
  type ToolName,
} from '@10db/contracts';
import { syncNeedsBuilder } from '../../shell/benchmark-sync-urgency';

export const SystemCardKind = {
  MissingTool: 'missing-tool',
  RefusedCopy: 'refused-copy',
  LoginShell: 'login-shell',
  BenchmarkKey: 'benchmark-key',
} as const;
export type SystemCardKind = (typeof SystemCardKind)[keyof typeof SystemCardKind];

/** Something the system check found that stops or degrades work until the builder fixes it. */
export type SystemCard =
  | {
      readonly kind: typeof SystemCardKind.MissingTool;
      readonly key: string;
      readonly tool: ToolName;
    }
  | {
      readonly kind: typeof SystemCardKind.RefusedCopy;
      readonly key: string;
      readonly agent: AgentCopy;
    }
  | {
      readonly kind: typeof SystemCardKind.LoginShell;
      readonly key: string;
      readonly warning: string;
    }
  | {
      readonly kind: typeof SystemCardKind.BenchmarkKey;
      readonly key: string;
      readonly message: string;
    };

/**
 * The Inbox's 10db cards: only what the builder has to act on. A copy being downloaded clears by itself and
 * is told in the header; a newer release or a version that differs has nothing to do and is told in Settings ›
 * Updates; a sync failure that a later sync clears is a note in Factory.
 */
export function systemCards(check: SystemCheckDto | undefined): SystemCard[] {
  if (!check) return [];
  const agents = check.agents ?? [];
  const cards: SystemCard[] = [];
  for (const tool of check.tools) {
    // Claude Code and Codex are 10db's own pinned copies: an install of the builder's own is never run.
    if (tool.required && tool.path === null && !agents.some((agent) => agent.tool === tool.name))
      cards.push({ kind: SystemCardKind.MissingTool, key: `tool:${tool.name}`, tool: tool.name });
  }
  for (const agent of agents) {
    if (agent.state === AgentCopyState.Refused)
      cards.push({ kind: SystemCardKind.RefusedCopy, key: `copy:${agent.tool}`, agent });
  }
  if (check.loginEnv.warning)
    cards.push({
      kind: SystemCardKind.LoginShell,
      key: 'login-shell',
      warning: check.loginEnv.warning,
    });
  if (check.benchmarkSync && syncNeedsBuilder(check.benchmarkSync))
    cards.push({
      kind: SystemCardKind.BenchmarkKey,
      key: 'benchmark-key',
      message: check.benchmarkSync.message,
    });
  return cards;
}

/** The pinned copies 10db is downloading: sessions that need one wait for it. */
export function fetchingAgents(check: SystemCheckDto | undefined): AgentCopy[] {
  return (check?.agents ?? []).filter((agent) => agent.state === AgentCopyState.Fetching);
}
