import type { HazardDef } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { sandboxedAsk } from './sandboxed-asks';

const HAZARDS: readonly HazardDef[] = [
  { name: 'deps', globs: ['package.json'], commands: ['pnpm add', 'npm install'] },
];

interface Row {
  readonly name: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly asks: boolean;
}

const ROWS: readonly Row[] = [
  {
    name: 'a plain read',
    toolName: 'Bash',
    input: { command: 'grep -n foo README.md' },
    asks: false,
  },
  {
    name: 'a hazard command',
    toolName: 'Bash',
    input: { command: 'pnpm add left-pad' },
    asks: true,
  },
  {
    name: 'a hazard command after a cd',
    toolName: 'Bash',
    input: { command: 'cd x && pnpm add y' },
    asks: true,
  },
  {
    name: 'a hazard inside sh -c',
    toolName: 'Bash',
    input: { command: "sh -c 'npm install left-pad'" },
    asks: true,
  },
  {
    name: 'a backgrounded busy loop',
    toolName: 'Bash',
    input: { command: '(while :; do :; done) &' },
    asks: true,
  },
  {
    name: 'a foreground endless loop the call itself backgrounds',
    toolName: 'Bash',
    input: { command: 'yes > /dev/null', run_in_background: true },
    asks: true,
  },
  {
    name: 'the same loop in the foreground',
    toolName: 'Bash',
    input: { command: 'yes > /dev/null' },
    asks: false,
  },
  {
    name: 'a command too deeply nested to scan',
    toolName: 'Bash',
    input: { command: `${'$('.repeat(20000)}ls${')'.repeat(20000)}` },
    asks: true,
  },
  {
    name: 'a monitor on a plain command',
    toolName: 'Monitor',
    input: { command: 'tail -f out.log', description: 'wait', timeout_ms: 1000 },
    asks: false,
  },
  {
    name: 'a monitor with a socket key',
    toolName: 'Monitor',
    input: { command: 'tail -f out.log', ws: 'wss://example.org' },
    asks: true,
  },
  {
    name: 'a monitor whose command is a hazard',
    toolName: 'Monitor',
    input: { command: 'pnpm add left-pad' },
    asks: true,
  },
  { name: 'a monitor with no command', toolName: 'Monitor', input: {}, asks: true },
  { name: 'a web fetch', toolName: 'WebFetch', input: { url: 'https://example.org' }, asks: true },
  { name: 'a web search', toolName: 'WebSearch', input: { query: 'x' }, asks: true },
  { name: 'a repo MCP tool', toolName: 'mcp__docs__search', input: {}, asks: true },
  { name: "10db's own MCP tool", toolName: 'mcp__10db__complete_step', input: {}, asks: false },
  { name: 'a file read', toolName: 'Read', input: { file_path: '/x' }, asks: false },
];

describe('sandboxedAsk', () => {
  it.each(ROWS)('$name -> asks: $asks', (row) => {
    const verdict = sandboxedAsk({ toolName: row.toolName, input: row.input }, HAZARDS);
    expect(verdict?.decision ?? null).toBe(row.asks ? 'ask' : null);
    if (verdict !== null) expect(verdict.reason.length).toBeGreaterThan(0);
  });
});
