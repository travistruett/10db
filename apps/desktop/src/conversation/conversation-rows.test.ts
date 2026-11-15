import { describe, expect, it } from 'vitest';
import {
  commandCall,
  editCall,
  readCall,
  subagentCall,
  toolEntry,
} from '../test/tool-call-fixtures';
import {
  ARTICLE_ROWS,
  collapseWork,
  conversationArticles,
  conversationRows,
  type ConversationRow,
} from './conversation-rows';
import type { ConversationEntry } from './entry';

const read = (id: string, parentId: string | null = null) => toolEntry(readCall({ id, parentId }));
const edit = (id: string) => toolEntry(editCall({ id }));
const deniedRead = (id: string) =>
  toolEntry(readCall({ id, path: '.env', status: 'denied', deniedBy: '10db', refusal: 'secrets' }));
const failedRead = (id: string) => toolEntry(readCall({ id, status: 'failed' }));
const deniedEdit = (id: string) =>
  toolEntry(editCall({ id, status: 'denied', deniedBy: 'builder' }));
const command = (id: string) => toolEntry(commandCall({ id }));
const subagent = (id: string) => toolEntry(subagentCall({ id }));
const nestedSubagent = (id: string, parentId: string) => toolEntry(subagentCall({ id, parentId }));
const reply = (id: string): ConversationEntry => ({ kind: 'reply', id, text: id, partial: false });
const builder = (id: string): ConversationEntry => ({ kind: 'builder', id, text: id, extra: null });

/** Each row as a short string: its kind and the ids it holds. */
function shape(rows: readonly ConversationRow[]): string[] {
  return rows.map((row) => {
    switch (row.kind) {
      case 'entry':
        return `entry ${row.entry.id}`;
      case 'tool':
        return row.nested.length === 0
          ? `tool ${row.entry.id}`
          : `tool ${row.entry.id} [${row.nested.map((n) => n.id).join(' ')}]`;
      case 'tool_group':
        return `group ${row.entries.map((e) => e.id).join(' ')}`;
      case 'edit_group':
        return `edits ${row.entries.map((e) => e.id).join(' ')}`;
      case 'work':
        return `work(${String(row.steps)}) [${shape(row.rows).join(', ')}]`;
    }
  });
}

describe('conversationRows', () => {
  it.each<[string, ConversationEntry[], string[]]>([
    [
      'three reads, a reply, then one read',
      [read('r1'), read('r2'), read('r3'), reply('t'), read('r4')],
      ['group r1 r2 r3', 'entry t', 'tool r4'],
    ],
    ['read, edit, read', [read('r1'), edit('e1'), read('r2')], ['tool r1', 'tool e1', 'tool r2']],
    [
      'three edits, then a command',
      [edit('e1'), edit('e2'), edit('e3'), command('c1')],
      ['edits e1 e2 e3', 'tool c1'],
    ],
    ['edit, read, edit', [edit('e1'), read('r1'), edit('e2')], ['tool e1', 'tool r1', 'tool e2']],
    [
      'a denied read stands alone between reads',
      [read('r1'), deniedRead('d1'), read('r2'), read('r3')],
      ['tool r1', 'tool d1', 'group r2 r3'],
    ],
    [
      'a failed read stands alone',
      [read('r1'), failedRead('f1'), read('r2')],
      ['tool r1', 'tool f1', 'tool r2'],
    ],
    [
      'a denied edit stands alone',
      [edit('e1'), edit('e2'), deniedEdit('d1')],
      ['edits e1 e2', 'tool d1'],
    ],
    [
      'a running read still folds',
      [read('r1'), toolEntry(readCall({ id: 'r2', status: 'running' }))],
      ['group r1 r2'],
    ],
    [
      'a subagent with two children, and an orphan whose parent is absent',
      [subagent('a1'), read('k1', 'a1'), read('k2', 'a1'), read('o1', 'gone')],
      ['tool a1 [k1 k2]', 'tool o1'],
    ],
    [
      "a nested subagent's calls sit under the outermost one",
      [subagent('a1'), nestedSubagent('a2', 'a1'), read('k1', 'a2')],
      ['tool a1 [a2 k1]'],
    ],
    [
      'two subagents that name each other as parents are each still drawn',
      [nestedSubagent('a1', 'a2'), nestedSubagent('a2', 'a1'), read('k1', 'a1')],
      ['tool a1', 'tool a2 [k1]'],
    ],
    [
      "a subagent's children between reads don't break the group",
      [subagent('a1'), read('r1'), read('k1', 'a1'), read('r2')],
      ['tool a1 [k1]', 'group r1 r2'],
    ],
  ])('%s', (_name, entries, expected) => {
    expect(shape(conversationRows(entries))).toEqual(expected);
  });

  it('keeps the group id of its first entry', () => {
    const [row] = conversationRows([read('first'), read('second')]);
    expect(row?.kind === 'tool_group' ? row.id : null).toBe('first');
  });
});

describe('collapseWork', () => {
  const thought = (id: string): ConversationEntry => ({
    kind: 'reasoning',
    id,
    text: id,
    durationMs: null,
  });
  const notice = (id: string): ConversationEntry => ({
    kind: 'notice',
    id,
    text: id,
    tone: 'info',
  });

  it.each<[string, ConversationEntry[], string[]]>([
    [
      'a run of work between replies is one closed row; the replies stay',
      [reply('t1'), read('r1'), read('r2'), command('c1'), reply('t2')],
      ['entry t1', 'work(3) [group r1 r2, tool c1]', 'entry t2'],
    ],
    [
      'reasoning folds with the calls around it and adds no step',
      [thought('th'), command('c1'), reply('t1')],
      ['work(1) [entry th, tool c1]', 'entry t1'],
    ],
    [
      'reasoning alone is a run with no steps',
      [thought('th'), reply('t1')],
      ['work(0) [entry th]', 'entry t1'],
    ],
    [
      'a denied call and a failed call stay in view and split the run',
      [command('c1'), deniedEdit('d1'), failedRead('f1'), command('c2')],
      ['work(1) [tool c1]', 'tool d1', 'tool f1', 'work(1) [tool c2]'],
    ],
    [
      'a notice splits the run',
      [command('c1'), notice('n1'), command('c2')],
      ['work(1) [tool c1]', 'entry n1', 'work(1) [tool c2]'],
    ],
    [
      "a subagent's calls count with it",
      [subagent('a1'), read('k1', 'a1'), read('k2', 'a1')],
      ['work(3) [tool a1 [k1 k2]]'],
    ],
    [
      'a running call is work too',
      [toolEntry(commandCall({ id: 'c1', status: 'running' }))],
      ['work(1) [tool c1]'],
    ],
    ['no work, no work row', [reply('t1'), builder('b1')], ['entry t1', 'entry b1']],
  ])('%s', (_name, entries, expected) => {
    expect(shape(collapseWork(conversationRows(entries)))).toEqual(expected);
  });

  it('keeps the first row’s id for the run, so its state follows it', () => {
    const [row] = collapseWork(conversationRows([read('first'), read('second'), edit('e1')]));
    expect(row?.kind === 'work' ? row.id : null).toBe('first');
  });
});

describe('conversationArticles', () => {
  /** Each article as its speaker and the ids of its rows. */
  const articles = (entries: ConversationEntry[]) =>
    conversationArticles(conversationRows(entries)).map(
      (a) => `${a.speaker} ${shape(a.rows).join(', ')}`,
    );

  it.each<[string, ConversationEntry[], string[]]>([
    [
      'a builder message, a reply and a tool, then a builder message',
      [builder('b1'), reply('t1'), command('c1'), builder('b2')],
      ['builder entry b1', 'agent entry t1, tool c1', 'builder entry b2'],
    ],
    [
      'a conversation that opens with agent rows',
      [reply('t1'), builder('b1')],
      ['agent entry t1', 'builder entry b1'],
    ],
    [
      'two builder messages in a row',
      [builder('b1'), builder('b2')],
      ['builder entry b1', 'builder entry b2'],
    ],
  ])('%s', (_name, entries, expected) => {
    expect(articles(entries)).toEqual(expected);
  });

  it('windows a long turn in parts of at most ARTICLE_ROWS rows, each part keyed by its first row', () => {
    const replies = Array.from({ length: ARTICLE_ROWS * 2 + 1 }, (_, i) => reply(`t${String(i)}`));
    const parts = conversationArticles(conversationRows([builder('b1'), ...replies]));
    expect(parts.map((a) => [a.speaker, a.rows.length, a.id, a.continued])).toEqual([
      ['builder', 1, 'b1', false],
      ['agent', ARTICLE_ROWS, 't0', false],
      ['agent', ARTICLE_ROWS, `t${String(ARTICLE_ROWS)}`, true],
      ['agent', 1, `t${String(ARTICLE_ROWS * 2)}`, true],
    ]);
  });

  it('keys each article by its first row', () => {
    const ids = conversationArticles(
      conversationRows([builder('b1'), reply('t1'), command('c1')]),
    ).map((a) => a.id);
    expect(ids).toEqual(['b1', 't1']);
  });
});
