import { mintId, PREVIEW_CHARS, ToolCallView, type ShapeMessageDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import type { ConversationEntry } from '../../conversation';
import { shapeMessageDto } from '../../test/shape-fixtures';
import { planEntries } from './plan-entries';

const shapeId = mintId('Shape');
const msg = (overrides: Partial<ShapeMessageDto>) => shapeMessageDto(shapeId, overrides);
const SCREEN = JSON.stringify({
  screen: 'board',
  width: 1200,
  height: 900,
  name: '0001.png',
  mediaType: 'image/png',
});

/** An entry as its kind and the field that says the most about it. */
function summary(entry: ConversationEntry): string {
  switch (entry.kind) {
    case 'builder':
    case 'reply':
    case 'reasoning':
      return `${entry.kind} ${entry.text}`;
    case 'notice':
      return `notice ${entry.tone} ${entry.text}`;
    case 'divider':
      return `divider ${entry.text}`;
    case 'tool':
      return `tool ${entry.call.status} ${entry.call.title}`;
    case 'custom':
      return 'custom';
  }
}

const one = (m: ShapeMessageDto) => planEntries([m]).map(summary);

describe('planEntries', () => {
  it.each<[string, ShapeMessageDto, string[]]>([
    [
      'a text note',
      msg({ author: 'note', kind: 'text', body: 'Resumed' }),
      ['notice info Resumed'],
    ],
    ["the builder's text", msg({ author: 'builder', body: 'Hi' }), ['builder Hi']],
    ["Plan's text", msg({ author: 'claude', body: '# Plan' }), ['reply # Plan']],
    [
      'a tool line',
      msg({ author: 'claude', kind: 'tool', body: 'propose_plan · 1 goal, 3 loose · passed' }),
      ['tool done propose_plan · 1 goal, 3 loose · passed'],
    ],
    ['a screenshot', msg({ author: 'claude', kind: 'screen', body: SCREEN }), ['custom']],
    ['a screenshot that does not parse', msg({ author: 'claude', kind: 'screen', body: '{' }), []],
    [
      'Propose',
      msg({ author: 'builder', kind: 'propose', body: '' }),
      ['notice info You pressed Propose.'],
    ],
    [
      'Propose, as the daemon stores it, by a note',
      msg({ author: 'note', kind: 'propose', body: 'Propose' }),
      ['notice info You pressed Propose.'],
    ],
    ['an edit note by a note', msg({ author: 'note', kind: 'edit', body: 'x' }), []],
    [
      'a rehearsal',
      msg({ author: 'claude', kind: 'rehearse', body: 'Rehearsing' }),
      ['notice info Rehearsing'],
    ],
    [
      'an event',
      msg({ author: 'claude', kind: 'event', body: 'Reopened' }),
      ['notice info Reopened'],
    ],
    [
      'a notice',
      msg({ author: 'claude', kind: 'notice', body: 'Heads up' }),
      ['notice info Heads up'],
    ],
    ['an edit note', msg({ author: 'claude', kind: 'edit', body: 'x' }), []],
    ['a digest', msg({ author: 'claude', kind: 'digest', body: 'x' }), []],
    ['an empty tool line', msg({ author: 'claude', kind: 'tool', body: '' }), []],
  ])('%s', (_name, message, expected) => {
    expect(one(message)).toEqual(expected);
  });

  /** The one tool call `body` maps to. */
  function callOf(body: string): ToolCallView {
    const [entry] = planEntries([msg({ author: 'claude', kind: 'tool', body })]);
    if (entry?.kind !== 'tool') throw new Error('not a tool entry');
    return entry.call;
  }

  it('maps a tool line to an other call, the whole line its title and preview', () => {
    const m = msg({
      author: 'claude',
      kind: 'tool',
      body: 'propose_plan · 1 goal, 3 loose · passed',
    });
    const [entry] = planEntries([m]);
    expect(entry?.kind === 'tool' ? entry.call : null).toMatchObject({
      id: m.id,
      kind: 'other',
      status: 'done',
      title: 'propose_plan · 1 goal, 3 loose · passed',
      harnessTool: '10db.plan',
      name: '10db.plan',
      inputPreview: 'propose_plan · 1 goal, 3 loose · passed',
      startedAt: m.createdAt,
      durationMs: null,
      parentId: null,
      deniedBy: null,
      refusal: null,
    });
  });

  it('cuts a long line in its preview and keeps it whole in its title', () => {
    const line = `see_screen · ${'x'.repeat(300)}`;
    const call = callOf(line);
    expect(call.title).toBe(line);
    expect(call.kind === 'other' ? call.inputPreview : null).toHaveLength(PREVIEW_CHARS);
  });

  it.each([
    [
      'with a reason',
      'Bash · refused · writes outside the checkout',
      'writes outside the checkout',
    ],
    ['with none', 'propose_plan · refused', null],
  ])('reads a refused line %s as stopped by 10db', (_name, body, refusal) => {
    expect(callOf(body)).toMatchObject({ status: 'denied', deniedBy: '10db', refusal });
  });

  it('names a line with no separator by the whole line', () => {
    expect(callOf('see_screen')).toMatchObject({ title: 'see_screen', inputPreview: 'see_screen' });
  });

  it('builds every tool call the contract accepts', () => {
    for (const body of [
      'propose_plan · 1 goal, 3 loose · passed',
      `see_screen · ${'x'.repeat(300)}`,
      'Bash · refused · writes outside the checkout',
      'propose_plan · refused',
      'see_screen',
    ])
      expect(() => ToolCallView.parse(callOf(body))).not.toThrow();
  });
});
