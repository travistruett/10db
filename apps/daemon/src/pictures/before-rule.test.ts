import { describe, expect, it } from 'vitest';
import { beforeAllowed, wroteBefore, type BeforeFacts, type ToolCall } from './before-rule';

// Workbench spec §10 (before is before the first edit), the before rule: a before is asked
// only while the task has started nothing, and kept only when the task wrote nothing before the shot
// finished.

const none: BeforeFacts = { inPass: true, turns: 0, sessions: 0, keptWorkSha: null };

describe('beforeAllowed', () => {
  it.each<{ name: string; facts: BeforeFacts; allowed: boolean }>([
    { name: 'a pass page with no turn', facts: none, allowed: true },
    { name: 'a pass page with a turn row', facts: { ...none, turns: 1 }, allowed: false },
    {
      name: "a pass page with a taken-out task's kept work",
      facts: { ...none, keptWorkSha: 'a'.repeat(40) },
      allowed: false,
    },
    {
      name: 'a pass page whose task ran sessions before the pass, with no turn',
      facts: { ...none, sessions: 2 },
      allowed: true,
    },
    {
      name: 'an ordinary task with no session',
      facts: { ...none, inPass: false },
      allowed: true,
    },
    {
      name: 'an ordinary task with a session',
      facts: { ...none, inPass: false, sessions: 1 },
      allowed: false,
    },
    {
      name: 'an ordinary task with kept work',
      facts: { ...none, inPass: false, keptWorkSha: 'a'.repeat(40) },
      allowed: false,
    },
  ])('$name', ({ facts, allowed }) => {
    expect(beforeAllowed(facts)).toBe(allowed);
  });
});

const at = (s: number): string => new Date(Date.UTC(2026, 10, 10, 12, 0, s)).toISOString();

describe('wroteBefore', () => {
  it.each<{ name: string; calls: ToolCall[]; wrote: boolean }>([
    { name: 'no call', calls: [], wrote: false },
    {
      name: 'reads only',
      calls: [
        { tool: 'Read', at: at(1) },
        { tool: 'Grep', at: at(2) },
      ],
      wrote: false,
    },
    { name: 'a Write before the shot ended', calls: [{ tool: 'Write', at: at(5) }], wrote: true },
    { name: 'an Edit before the shot ended', calls: [{ tool: 'Edit', at: at(5) }], wrote: true },
    { name: 'a MultiEdit', calls: [{ tool: 'MultiEdit', at: at(5) }], wrote: true },
    { name: 'a NotebookEdit', calls: [{ tool: 'NotebookEdit', at: at(5) }], wrote: true },
    { name: 'any Bash call', calls: [{ tool: 'Bash', at: at(5) }], wrote: true },
    { name: 'a Write as the shot ended', calls: [{ tool: 'Write', at: at(10) }], wrote: true },
    {
      name: 'the first Write after the shot ended',
      calls: [
        { tool: 'Read', at: at(3) },
        { tool: 'Write', at: at(11) },
      ],
      wrote: false,
    },
    { name: 'a Codex command', calls: [{ tool: 'command', at: at(5) }], wrote: true },
    { name: 'a Codex patch', calls: [{ tool: 'apply_patch', at: at(5) }], wrote: true },
  ])('$name', ({ calls, wrote }) => {
    expect(wroteBefore({ calls, codexStarts: [] }, at(10))).toBe(wrote);
  });

  // Codex reports a call only once it has run, so a Codex session that began before the shot ended may
  // have written with nothing reported yet.
  it.each<{ name: string; codexStarts: string[]; wrote: boolean }>([
    { name: 'a Codex session started before the shot ended', codexStarts: [at(4)], wrote: true },
    { name: 'a Codex session started as the shot ended', codexStarts: [at(10)], wrote: true },
    { name: 'a Codex session started after it', codexStarts: [at(11)], wrote: false },
  ])('$name', ({ codexStarts, wrote }) => {
    expect(wroteBefore({ calls: [], codexStarts }, at(10))).toBe(wrote);
  });
});
