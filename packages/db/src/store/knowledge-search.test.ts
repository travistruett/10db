import {
  matchesSearch,
  searchTerms,
  SearchMatch,
  type DecisionId,
  type ProjectId,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { insertDecision } from './decisions';
import { insertSource } from './knowledge';
import { findRecords, searchDecisionIds, searchDecisions } from './knowledge-search';
import type { Store } from './store';
import { createTestStore, seedProject } from './test-support';

let store: Store;
let close: () => void;
let projectId: ProjectId;
beforeEach(() => {
  ({ store, close } = createTestStore());
  projectId = seedProject(store).id;
});
afterEach(() => {
  close();
});

const record = (question: string): DecisionId =>
  store.write((ctx) =>
    insertDecision(ctx, {
      projectId,
      question,
      choice: 'x',
      rationale: 'y',
      decidedBy: 'me',
      scope: 'project',
      area: null,
      sourceId: insertSource(ctx, 'builder', {}),
    }),
  ).value;

const typed = (query: string): DecisionId[] =>
  searchDecisionIds(store.db, { projectId, query, limit: 10, match: SearchMatch.AllPrefixes });

describe('a typed search, the same in the daemon and on the Proposals tab', () => {
  it.each([
    { name: 'a partly typed word', text: 'Never sleep', query: 'slee', hit: true },
    { name: 'the middle of a word', text: 'Never sleep', query: 'eep', hit: false },
    { name: 'every word, each partly typed', text: 'Never sleep', query: 'nev slee', hit: true },
    { name: 'a word the text lacks', text: 'Never sleep', query: 'slee queue', hit: false },
    { name: 'words of a topic key', text: 'testing.no-sleeps', query: 'no sleep', hit: true },
    { name: 'Hangul', text: '한글 검색', query: '한글', hit: true },
    { name: 'a partly typed Hangul word', text: '한글 검색', query: '검', hit: true },
    { name: 'Hangul typed decomposed', text: '한글', query: '한글'.normalize('NFD'), hit: true },
    { name: 'Cyrillic й', text: 'чай', query: 'чай', hit: true },
    { name: 'Cyrillic и is not й', text: 'чай', query: 'чаи', hit: false },
    { name: 'kana with dakuten', text: 'がくせい', query: 'がく', hit: true },
    { name: 'kana without its dakuten', text: 'がくせい', query: 'かく', hit: false },
    { name: 'an accented word typed plain', text: 'Café crème', query: 'cafe cre', hit: true },
    { name: 'a plain word typed accented', text: 'Cafe', query: 'café', hit: true },
    { name: 'a decomposed accent', text: 'Cafe', query: 'café'.normalize('NFD'), hit: true },
    { name: 'a Latin letter with two accents', text: 'Việt', query: 'viet', hit: false },
    { name: 'a stress mark on Cyrillic', text: 'заме\u{301}на', query: 'замена', hit: true },
  ])('$name', ({ text, query, hit }) => {
    record(text);
    expect(typed(query).length > 0).toBe(hit);
    expect(matchesSearch(text, query)).toBe(hit);
  });

  it('reads every Latin letter the way the tokenizer does', () => {
    const client = store.db.$client;
    client.exec(`CREATE VIRTUAL TABLE letters USING fts5(word);
      CREATE VIRTUAL TABLE letter_terms USING fts5vocab(letters, instance);`);
    const insert = client.prepare('INSERT INTO letters(rowid, word) VALUES (?, ?)');
    const codePoints = [
      ...Array.from({ length: 0x250 - 0xc0 }, (_, i) => 0xc0 + i),
      ...Array.from({ length: 0x1f00 - 0x1e00 }, (_, i) => 0x1e00 + i),
    ]
      // The tokenizer's table folds the long s, plain or dotted, to s; toLowerCase leaves it.
      .filter((cp) => /\p{L}/u.test(String.fromCodePoint(cp)) && ![0x17f, 0x1e9b].includes(cp));
    for (const cp of codePoints) insert.run(cp, String.fromCodePoint(cp));
    const indexed = z
      .array(z.object({ doc: z.number(), term: z.string() }))
      .parse(client.prepare('SELECT doc, term FROM letter_terms').all());
    const term = new Map(indexed.map((row) => [row.doc, row.term]));
    const differing = codePoints.filter((cp) => {
      const [ours] = searchTerms(String.fromCodePoint(cp));
      return ours !== term.get(cp);
    });
    expect(differing.map((cp) => String.fromCodePoint(cp))).toEqual([]);
  });

  it('never parses the text as query syntax', () => {
    record('Never sleep');
    expect(typed('***')).toEqual([]);
    expect(typed(`"unterminated (NEAR OR`)).toEqual([]);
  });
});

describe('free text from an agent or a task', () => {
  it('finds a record sharing any word, whichever others the text holds', () => {
    const id = record('Which date library?');
    const query = 'which date library should we use';
    expect(searchDecisionIds(store.db, { projectId, query, limit: 5 })).toEqual([id]);
    expect(searchDecisions(store.db, projectId, query, 5).map((d) => d.id)).toEqual([id]);
    expect(findRecords(store.db, projectId, query, 5).map((r) => r.id)).toEqual([id]);
  });

  it('ranks by how much of the text a record shares', () => {
    record('A date');
    const best = record('A date library');
    expect(searchDecisionIds(store.db, { projectId, query: 'date library', limit: 5 })[0]).toBe(
      best,
    );
  });
});
