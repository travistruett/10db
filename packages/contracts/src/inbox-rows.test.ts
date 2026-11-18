import { describe, expect, it } from 'vitest';
import { PASS_RETRY_TURN_CHOICE, PASS_SIGN_OFF_CHOICE, type PassCheckDetail } from './passes';
import { mintId, type PassId } from './ids';
import type { InboxListState } from './inbox-page';
import {
  compareRowSort,
  inboxRowKey,
  inboxRowSort,
  isDismissable,
  readyPassOf,
  type InboxRowCard,
  type InboxRowSort,
  type SortCard,
} from './inbox-rows';

const project = mintId('Project');
const card = (over: Partial<InboxRowCard> = {}): InboxRowCard => ({
  id: mintId('InboxItem'),
  kind: 'question',
  projectId: project,
  title: 'T',
  body: 'B',
  options: [{ label: 'A', description: '' }],
  detail: null,
  ...over,
});
const flag = (over: Partial<InboxRowCard> = {}): InboxRowCard =>
  card({ kind: 'flag', options: [], ...over });
const passDetail = (passId: PassId): PassCheckDetail => ({
  passId,
  taskId: mintId('Task'),
  workstreamId: mintId('Workstream'),
  turnId: mintId('PassTurn'),
  keptSha: 'a'.repeat(40),
  keptBaseSha: 'b'.repeat(40),
  turnFiles: [],
  pageFiles: [],
});
const pass = mintId('Pass');
const ready = (passId: PassId, title: string): InboxRowCard =>
  card({
    kind: 'check',
    title,
    body: '',
    options: [{ label: PASS_SIGN_OFF_CHOICE, description: '' }],
    detail: passDetail(passId),
  });

describe('inboxRowKey', () => {
  const question = card();
  const elsewhere = mintId('Project');
  const failedTurn = flag({
    title: 'Turn failed',
    options: [{ label: PASS_RETRY_TURN_CHOICE, description: '' }],
    detail: { passId: pass },
  });
  const builderCheck = card({ kind: 'check', options: [], detail: { head: 'c'.repeat(40) } });
  it.each<{ name: string; card: InboxRowCard; key: string }>([
    { name: 'a question, its id', card: question, key: question.id },
    {
      name: 'a flag with no options, its text',
      card: flag(),
      key: `flags:${JSON.stringify([project, 'flag', 'T', 'B'])}`,
    },
    {
      name: 'the same flag in another project, another key',
      card: flag({ projectId: elsewhere }),
      key: `flags:${JSON.stringify([elsewhere, 'flag', 'T', 'B'])}`,
    },
    { name: "a failed turn's flag, its id", card: failedTurn, key: failedTurn.id },
    {
      name: 'a move report with no options, its text and its kind, apart from a flag of that text',
      card: card({ kind: 'playbook_move_report', options: [] }),
      key: `flags:${JSON.stringify([project, 'playbook_move_report', 'T', 'B'])}`,
    },
    { name: 'a Ready page, its pass', card: ready(pass, 'Ready: A'), key: `pass:${pass}` },
    { name: 'a check of any other detail, its id', card: builderCheck, key: builderCheck.id },
    {
      name: 'a question with the same text as a flag, its id',
      card: question,
      key: question.id,
    },
  ])('$name', ({ card: c, key }) => {
    expect(inboxRowKey(c)).toBe(key);
  });

  it('keys flags of one text alike whichever card is asked, and different text apart', () => {
    expect(inboxRowKey(flag())).toBe(inboxRowKey(flag()));
    expect(inboxRowKey(flag({ body: 'docs/b.md' }))).not.toBe(inboxRowKey(flag()));
  });

  it('keys two Ready pages of a pass alike and names the pass', () => {
    expect(inboxRowKey(ready(pass, 'Ready: A'))).toBe(inboxRowKey(ready(pass, 'Ready: B')));
    expect(inboxRowKey(ready(mintId('Pass'), 'Ready: C'))).not.toBe(`pass:${pass}`);
    expect(readyPassOf(ready(pass, 'Ready: A'))).toBe(pass);
    expect(readyPassOf(card())).toBeNull();
    expect(readyPassOf(failedTurn)).toBeNull();
  });
});

describe('isDismissable', () => {
  it.each([
    { name: 'a flag with no options', kind: 'flag', options: 0, expected: true },
    { name: 'a flag with options', kind: 'flag', options: 1, expected: false },
    {
      name: 'a move report with no options',
      kind: 'playbook_move_report',
      options: 0,
      expected: true,
    },
    { name: 'a question with no options', kind: 'question', options: 0, expected: false },
    {
      name: 'a flag with no options that closes itself',
      kind: 'flag',
      options: 0,
      detail: { closesItself: true },
      expected: false,
    },
  ] as const)('$name: $expected', ({ kind, options, expected, ...rest }) => {
    const options_ = Array.from({ length: options }, () => ({ label: 'Go', description: '' }));
    const detail = 'detail' in rest ? rest.detail : null;
    expect(isDismissable({ kind, options: options_, detail })).toBe(expected);
  });
});

describe('inboxRowSort', () => {
  const id = mintId('InboxItem');
  const base: SortCard = {
    id,
    urgency: 'normal',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
    sentAt: '2026-11-03T00:00:00.000Z',
  };
  it.each<{ name: string; state: InboxListState; over: Partial<SortCard>; sort: InboxRowSort }>([
    { name: 'open', state: 'open', over: {}, sort: [1, base.createdAt, id] },
    { name: 'open, high', state: 'open', over: { urgency: 'high' }, sort: [0, base.createdAt, id] },
    { name: 'open, low', state: 'open', over: { urgency: 'low' }, sort: [2, base.createdAt, id] },
    { name: 'waiting', state: 'waiting', over: {}, sort: [0, '2026-11-03T00:00:00.000Z', id] },
    { name: 'waiting, no send', state: 'waiting', over: { sentAt: null }, sort: [1, '', id] },
    { name: 'resolved', state: 'resolved', over: {}, sort: [0, base.updatedAt, id] },
  ])('$name', ({ state, over, sort }) => {
    expect(inboxRowSort(state, { ...base, ...over })).toEqual(sort);
  });
});

describe('compareRowSort', () => {
  const lo = 'InboxItem_a';
  const hi = 'InboxItem_b';
  // Ids are branded; the comparison only reads the string.
  const sort = (rank: number, at: string, id: string): InboxRowSort => [
    rank,
    at,
    id as InboxRowSort[2],
  ];
  it.each<{
    name: string;
    state: InboxListState;
    a: InboxRowSort;
    b: InboxRowSort;
    sign: -1 | 0 | 1;
  }>([
    { name: 'open: rank first', state: 'open', a: sort(0, 'z', hi), b: sort(1, 'a', lo), sign: -1 },
    { name: 'open: then at', state: 'open', a: sort(1, 'b', lo), b: sort(1, 'a', hi), sign: 1 },
    { name: 'open: then id', state: 'open', a: sort(1, 'a', lo), b: sort(1, 'a', hi), sign: -1 },
    {
      name: 'waiting: a sent card first',
      state: 'waiting',
      a: sort(1, '', lo),
      b: sort(0, 'a', hi),
      sign: 1,
    },
    {
      name: 'resolved: the newer first',
      state: 'resolved',
      a: sort(0, 'b', lo),
      b: sort(0, 'a', hi),
      sign: -1,
    },
    {
      name: 'resolved tie: the greater id first',
      state: 'resolved',
      a: sort(0, 'a', hi),
      b: sort(0, 'a', lo),
      sign: -1,
    },
    {
      name: 'code units: Z before a',
      state: 'open',
      a: sort(1, 'Z', lo),
      b: sort(1, 'a', lo),
      sign: -1,
    },
    { name: 'equal', state: 'open', a: sort(1, 'a', lo), b: sort(1, 'a', lo), sign: 0 },
  ])('$name', ({ state, a, b, sign }) => {
    expect(Math.sign(compareRowSort(state, a, b))).toBe(sign);
  });

  it('differs from localeCompare, which puts Z after a', () => {
    expect('Z'.localeCompare('a')).toBeGreaterThan(0);
  });
});
