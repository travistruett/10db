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
import {
  checkKnowledgeIndex,
  composeKnowledgeText,
  findRecords,
  searchDecisionIds,
  searchDecisions,
  searchPrincipleIds,
} from './knowledge-search';
import { confirmPrinciple, insertPrinciple } from './principles';
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
    ].filter((cp) => /\p{L}/u.test(String.fromCodePoint(cp)));
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

describe('text stored decomposed, found by a composed query', () => {
  // Hangul as a macOS file name holds it (jamo), and й and ё as base letter plus combining mark.
  const cases = [
    { name: 'Hangul', text: '한글 검색', query: '한글' },
    { name: 'a partly typed Hangul word', text: '한글 검색', query: '검' },
    { name: 'Cyrillic й', text: 'чай', query: 'чай' },
    { name: 'Cyrillic ё', text: 'ёлка', query: 'ёлка' },
  ];
  const savedPrinciple = (statement: string, topicKey: string, sourceQuote: string | null) =>
    store.write((ctx) =>
      insertPrinciple(ctx, {
        target: { scope: 'project', projectId },
        statement,
        kind: 'policy',
        topicKey,
        status: 'confirmed',
        sourceId: insertSource(ctx, 'builder', {}),
        sourceQuote,
        speaker: 'me',
        confirmedBy: 'me',
      }),
    ).value.id;
  const principlesFor = (query: string) =>
    searchPrincipleIds(store.db, { projectId, query, limit: 10, match: SearchMatch.AllPrefixes });

  it.each(cases)('$name is found on decisions and principles', ({ text, query }) => {
    const decomposed = text.normalize('NFD');
    expect(decomposed).not.toBe(text);
    const decision = record(decomposed);
    const principle = savedPrinciple(decomposed, 'a.key', null);
    expect(typed(query)).toEqual([decision]);
    expect(typed(query.normalize('NFD'))).toEqual([decision]);
    expect(principlesFor(query)).toEqual([principle]);
    expect(principlesFor(query.normalize('NFD'))).toEqual([principle]);
    expect(matchesSearch(decomposed, query)).toBe(true);
  });

  it('is found in the rationale, the choice, the topic key and the source quote', () => {
    const id = store.write((ctx) =>
      insertDecision(ctx, {
        projectId,
        question: 'q',
        choice: '한글'.normalize('NFD'),
        rationale: 'чай'.normalize('NFD'),
        decidedBy: 'me',
        scope: 'project',
        area: null,
        sourceId: insertSource(ctx, 'builder', {}),
      }),
    ).value;
    expect(typed('한글')).toEqual([id]);
    expect(typed('чай')).toEqual([id]);
    const keyed = savedPrinciple('x', 'чай.한글'.normalize('NFD'), '검색'.normalize('NFD'));
    expect(principlesFor('чай')).toEqual([keyed]);
    expect(principlesFor('검색')).toEqual([keyed]);
  });

  it('is found after a principle is confirmed with decomposed edits', () => {
    const proposed = store.write((ctx) =>
      insertPrinciple(ctx, {
        target: { scope: 'project', projectId },
        statement: 'plain',
        kind: 'policy',
        topicKey: 'a.key',
        status: 'proposed',
        sourceId: insertSource(ctx, 'builder', {}),
        sourceQuote: null,
        speaker: 'me',
        confirmedBy: null,
      }),
    ).value.id;
    store.write((ctx) =>
      confirmPrinciple(ctx, proposed, {
        target: { scope: 'project', projectId },
        statement: '한글'.normalize('NFD'),
        topicKey: 'чай'.normalize('NFD'),
        confirmedBy: 'me',
      }),
    );
    expect(principlesFor('한글')).toEqual([proposed]);
    expect(principlesFor('чай')).toEqual([proposed]);
  });

  it('composes rows stored before the write did, and reindexes them', () => {
    const decision = record('한글');
    const principle = savedPrinciple('чай', 'a.key', null);
    const client = store.db.$client;
    client
      .prepare('UPDATE decisions SET question = ? WHERE id = ?')
      .run('한글'.normalize('NFD'), decision);
    client
      .prepare('UPDATE principles SET statement = ? WHERE id = ?')
      .run('чай'.normalize('NFD'), principle);
    expect(typed('한글')).toEqual([]);
    expect(principlesFor('чай')).toEqual([]);

    expect(composeKnowledgeText(store.db)).toBe(2);
    expect(typed('한글')).toEqual([decision]);
    expect(principlesFor('чай')).toEqual([principle]);
    expect(checkKnowledgeIndex(store.db)).toEqual([]);
    expect(composeKnowledgeText(store.db)).toBe(0);
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
