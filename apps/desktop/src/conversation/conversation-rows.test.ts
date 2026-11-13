import { describe, expect, it } from 'vitest';
import {
  commandCall,
  editCall,
  readCall,
  subagentCall,
  toolEntry,
} from '../test/tool-call-fixtures';
import { conversationRows, type ConversationRow } from './conversation-rows';
import type { ConversationEntry } from './entry';

const read = (id: string, parentId: string | null = null) => toolEntry(readCall({ id, parentId }));
const edit = (id: string) => toolEntry(editCall({ id }));
const command = (id: string) => toolEntry(commandCall({ id }));
const subagent = (id: string) => toolEntry(subagentCall({ id }));
const nestedSubagent = (id: string, parentId: string) => toolEntry(subagentCall({ id, parentId }));
const reply = (id: string): ConversationEntry => ({ kind: 'reply', id, text: id, partial: false });

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
