import type { ToolCallView } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { streamEventLogFields, type StreamEvent } from './stream-log';

const TEXT = 'the secret plan, é';

const call: ToolCallView = {
  id: 'toolu_1',
  harnessTool: 'Bash',
  status: 'running',
  title: TEXT,
  startedAt: '2026-11-12T00:00:00.000Z',
  durationMs: null,
  parentId: null,
  refusal: null,
  deniedBy: null,
  limit: null,
  soft: null,
  kind: 'command',
  command: TEXT,
  cwd: null,
  outputTail: TEXT,
  outputBytes: 20,
  exitCode: null,
};

const rows: readonly [StreamEvent, Readonly<Record<string, string | number>>][] = [
  [
    { type: 'text_delta', itemId: 'm1:0', offset: 4, text: TEXT },
    { type: 'text_delta', itemId: 'm1:0', offset: 4, chars: TEXT.length },
  ],
  [
    { type: 'reasoning_delta', itemId: 'r1', offset: 0, text: TEXT },
    { type: 'reasoning_delta', itemId: 'r1', offset: 0, chars: TEXT.length },
  ],
  [
    { type: 'message', itemId: 'm1:0', text: TEXT },
    { type: 'message', itemId: 'm1:0', chars: TEXT.length },
  ],
  [
    { type: 'tool_call', call, appended: TEXT },
    { type: 'tool_call', callId: 'toolu_1', kind: 'command', status: 'running' },
  ],
  [
    { type: 'commands', commands: [{ name: 'compact', description: TEXT }] },
    { type: 'commands', count: 1 },
  ],
  [
    { type: 'plan_update', steps: [{ text: TEXT, status: 'pending' }] },
    { type: 'plan_update', count: 1 },
  ],
];

describe('streamEventLogFields', () => {
  it.each(rows)('%o logs ids and sizes', (event, fields) => {
    expect(streamEventLogFields(event)).toEqual(fields);
  });

  it('never logs the text', () => {
    for (const [event] of rows) {
      const fields = streamEventLogFields(event);
      expect(Object.keys(fields)).not.toContain('text');
      for (const value of Object.values(fields))
        expect(typeof value === 'string' && value.includes(TEXT)).toBe(false);
    }
  });
});
