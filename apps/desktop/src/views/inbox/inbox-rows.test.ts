import type { InboxItemDto, PassCheckDetail, PassId } from '@10db/contracts';
import { mintId, PASS_RETRY_TURN_CHOICE, PASS_SIGN_OFF_CHOICE } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { inboxItemDto } from '../../test/fixtures';
import { sendDto } from '../../test/people-fixtures';
import { inboxRows, openCount, splitInbox } from './inbox-rows';

const project = mintId('Project');
const flag = (title: string, body: string, overrides: Partial<InboxItemDto> = {}): InboxItemDto =>
  inboxItemDto({ kind: 'flag', title, body, options: [], projectId: project, ...overrides });
const question = inboxItemDto({ projectId: project });

/** A Ready page's `check` item of the pass. */
const ready = (passId: PassId, title: string): InboxItemDto => {
  const detail: PassCheckDetail = {
    passId,
    taskId: mintId('Task'),
    workstreamId: mintId('Workstream'),
    turnId: mintId('PassTurn'),
    keptSha: 'a'.repeat(40),
    keptBaseSha: 'b'.repeat(40),
    turnFiles: [],
    pageFiles: [],
  };
  return inboxItemDto({
    kind: 'check',
    title,
    body: '',
    options: [{ label: PASS_SIGN_OFF_CHOICE, description: '' }],
    projectId: project,
    detail,
  });
};

describe('inboxRows', () => {
  const a = flag('Write outside every claim', 'docs/a.md');
  const a2 = flag('Write outside every claim', 'docs/a.md');
  const b = flag('Write outside every claim', 'docs/b.md');
  const elsewhere = flag('Write outside every claim', 'docs/a.md', {
    projectId: mintId('Project'),
  });
  const withOptions = flag('Batch failed', 'gate', {
    options: [
      { label: 'Retry', description: '' },
      { label: 'Ship anyway', description: '' },
    ],
  });
  const withOptions2 = { ...withOptions, id: mintId('InboxItem') };
  const sameAsQuestion = inboxItemDto({
    projectId: project,
    title: question.title,
    body: question.body,
  });

  const pass = mintId('Pass');
  const settings = ready(pass, 'Ready: Settings');
  const people = ready(pass, 'Ready: People');
  const elsewhereReady = ready(mintId('Pass'), 'Ready: Billing');
  const failedTurn = inboxItemDto({
    kind: 'flag',
    title: 'Turn failed: Settings',
    body: 'The session was refused',
    options: [{ label: PASS_RETRY_TURN_CHOICE, description: '' }],
    projectId: project,
    detail: { passId: pass },
  });
  const builderCheck = inboxItemDto({
    kind: 'check',
    title: 'Ready for you to check: Badge',
    options: [],
    projectId: project,
    detail: { head: 'c'.repeat(40) },
  });
  const builderCheck2 = { ...builderCheck, id: mintId('InboxItem') };

  it.each<{ name: string; items: InboxItemDto[]; rows: InboxItemDto[][] }>([
    { name: 'nothing', items: [], rows: [] },
    {
      name: "a pass's Ready pages, in one row at the first",
      items: [settings, question, people],
      rows: [[settings, people], [question]],
    },
    {
      name: 'Ready pages of different passes, apart',
      items: [settings, elsewhereReady],
      rows: [[settings], [elsewhereReady]],
    },
    {
      name: "a failed turn's flag, apart from its pass's Ready pages",
      items: [settings, failedTurn, people],
      rows: [[settings, people], [failedTurn]],
    },
    {
      name: 'checks of tasks outside a pass, apart',
      items: [builderCheck, builderCheck2],
      rows: [[builderCheck], [builderCheck2]],
    },
    { name: 'one flag', items: [a], rows: [[a]] },
    {
      name: 'identical flags, in one row at the first',
      items: [a, question, a2],
      rows: [[a, a2], [question]],
    },
    { name: 'flags about different paths, apart', items: [a, b], rows: [[a], [b]] },
    {
      name: 'identical flags of different projects, apart',
      items: [a, elsewhere],
      rows: [[a], [elsewhere]],
    },
    {
      name: 'flags that ask for a choice, apart',
      items: [withOptions, withOptions2],
      rows: [[withOptions], [withOptions2]],
    },
    {
      name: 'identical questions, apart',
      items: [question, sameAsQuestion],
      rows: [[question], [sameAsQuestion]],
    },
  ])('groups $name', ({ items, rows }) => {
    expect(inboxRows(items).map((row) => row.items)).toEqual(rows);
  });

  it('keys a card by its id, and identical flags by their text, which outlives any one of them', () => {
    expect(inboxRows([question])[0]?.key).toBe(question.id);
    const [both] = inboxRows([a, a2]);
    const [later] = inboxRows([a2]);
    expect(both?.key).toBe(later?.key);
    expect(both?.key).not.toBe(inboxRows([b])[0]?.key);
  });

  it('keys a pass by its id and names it on the row, whichever page is Ready', () => {
    const [both] = inboxRows([settings, people]);
    const [later] = inboxRows([people]);
    expect(both?.key).toBe(later?.key);
    expect(both?.passId).toBe(pass);
    expect(inboxRows([question])[0]?.passId).toBeNull();
  });
});

describe('splitInbox: what needs the builder and what waits on someone', () => {
  const sent = (over: Record<string, unknown> = {}) =>
    inboxItemDto({ assignees: ['mark'], send: sendDto({ state: 'sent', heldBy: null, ...over }) });

  it.each([
    ['a sent card', sent(), 'connected', 'waiting'],
    ['a draft', inboxItemDto({ send: sendDto({ state: 'draft' }) }), 'connected', 'open'],
    [
      'a failed send',
      inboxItemDto({ send: sendDto({ state: 'failed', error: 'x' }) }),
      'connected',
      'open',
    ],
    ['a card with no send', inboxItemDto(), 'connected', 'open'],
    [
      'a send the timer returned',
      sent({ returnedAt: '2026-10-13T20:00:00.000Z', returnedReason: 'timer' }),
      'connected',
      'open',
    ],
    [
      'a send whose recipients disagree',
      sent({ returnedAt: '2026-10-13T20:00:00.000Z', returnedReason: 'disagreed' }),
      'connected',
      'open',
    ],
    ['a sent card while Slack is refused', sent(), 'refused', 'open'],
    ['a sent card while the token is gone', sent(), 'none', 'open'],
    ['a sent card while Slack is off', sent(), 'off', 'open'],
    ['a sent card while Slack is unreachable', sent(), 'unreachable', 'open'],
    ['a sent card before the connection is known', sent(), undefined, 'open'],
  ] as const)('%s is in %s', (_name, item, connection, where) => {
    const split = splitInbox([item], connection);
    expect(split.waiting.length === 1 ? 'waiting' : 'open').toBe(where);
  });

  it('counts Open without a card still being triaged, and shows it in the list', () => {
    const pending = inboxItemDto({ routedBy: 'triage_pending' });
    const plain = inboxItemDto();
    const split = splitInbox([pending, plain], 'connected');
    expect(split.open).toHaveLength(2);
    expect(openCount(split.open)).toBe(1);
  });
});
