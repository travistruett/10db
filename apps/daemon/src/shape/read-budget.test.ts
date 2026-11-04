import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { ShapeMessageKind, type ShapeMessageDto } from '@10db/contracts';
import { listShapeMessages } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pngOfSize } from '../../test/png';
import { INLINE_CONVERSATION_MAX_BYTES } from '../screens';
import type { FakeShapeTurn } from '../sessions';
import { must } from './conversation-fixture';
import {
  READ_CHARGE_MAX_BYTES,
  READ_RESERVE_BYTES,
  measuredMediaBytes,
  largestReadMeasured,
  readBytesSpent,
  readCountedLine,
} from './read-budget';
import { createServiceFixture, type ServiceFixture } from './service-fixture';

// Shape spec §5.4: a picture or PDF Claude pulls in with Read is a tool result a resumed session resends, beside
// the pictures the daemon sends itself. The preToolUse hook counts it and refuses what would pass the total.

const MB = 1024 * 1024;
/** The API's request limit, and base64's growth of what a picture weighs on the wire. */
const REQUEST_LIMIT = 32_000_000;
const onTheWire = (bytes: number): number => Math.ceil((bytes * 4) / 3);
/** What inline pictures and Read pictures may add together, and how many 1 MiB Reads a session with no inline picture holds. */
const POOL = INLINE_CONVERSATION_MAX_BYTES + READ_RESERVE_BYTES;
const EMPTY_ROOM = Math.floor(POOL / READ_CHARGE_MAX_BYTES);
/** A base64 string of this many decoded bytes, as a Read's result carries a picture. */
const base64Of = (bytes: number): string => Buffer.alloc(bytes, 7).toString('base64');
const imageResult = (bytes: number) => ({
  type: 'image',
  file: { base64: base64Of(bytes), type: 'image/png', originalSize: 9_000_000 },
});

let f: ServiceFixture;
beforeEach(() => {
  f = createServiceFixture();
});
afterEach(async () => {
  await f.close();
});

const shapeId = () => f.c.shape.id;
const wholePng = (bytes: number): Buffer => {
  const base = pngOfSize(100, 80);
  return pngOfSize(100, 80, bytes - base.length - 12);
};
const drop = (name: string, bytes: Uint8Array) =>
  f.service.addFile(shapeId(), { name, mediaType: '', bytes });
// 2880 x 1800 is over the 2000 px side cap, so it goes as a path line.
const retina = (bytes: number): Buffer => {
  const base = pngOfSize(2880, 1800);
  return pngOfSize(2880, 1800, bytes - base.length - 12);
};
/**
 * A picture the size of the allowance that goes as a path: charged 1 MiB measured or not, so these tests'
 * counts of Reads don't depend on a measurement. The ones about a larger file drop their own.
 */
const dropBig = () => drop('big.png', retina(MB));

async function nextTurn(text = 'Here you go'): Promise<FakeShapeTurn> {
  const seen: { turn: FakeShapeTurn | null } = { turn: null };
  f.adapter.shapeBehaviour = (turn) => {
    seen.turn = turn;
    return Promise.resolve({ text: 'ok' });
  };
  f.service.send(shapeId(), text);
  await f.service.settled(shapeId());
  return must(seen.turn, 'a turn');
}

const readInput = (input: Record<string, unknown>, n = 0, agentId?: string) =>
  must(f.adapter.shapeSessions[n], 'a session').spec.preToolUse({
    toolName: 'Read',
    input,
    ...(agentId === undefined ? {} : { agentId, agentType: 'scope' }),
  });
const read = (path: string, n = 0, agentId?: string) => readInput({ file_path: path }, n, agentId);
const readPages = (path: string, pages: unknown, n = 0, agentId?: string) =>
  readInput({ file_path: path, pages }, n, agentId);
const reasonOf = (answer: ReturnType<typeof read>): string =>
  answer.decision === 'deny' ? answer.reason : '';
const spent = () => readBytesSpent(listShapeMessages(f.c.store.db, shapeId()));

describe('the pictures a Shape session pulls in with Read', () => {
  it('and the inline pictures share a pool that fits the request limit, with room for text', () => {
    expect(onTheWire(POOL)).toBeLessThan(REQUEST_LIMIT - 1_500_000);
  });

  it('are refused, with the reason, once the ones already read would pass the total', async () => {
    // Nine 2 MiB pictures, three to a message, fill the inline budget; the other eleven go as paths to Read.
    for (let turnNo = 0; turnNo < 3; turnNo += 1) {
      for (let i = 0; i < 3; i += 1) drop(`i${String(turnNo)}-${String(i)}.png`, wholePng(2 * MB));
      expect((await nextTurn(`Turn ${String(turnNo)}`)).images).toHaveLength(3);
    }
    const files = Array.from({ length: 11 }, (_, i) => drop(`p${String(i)}.png`, wholePng(2 * MB)));
    const turn = await nextTurn('All of them');
    expect(turn.images).toHaveLength(0);
    expect(turn.message).toMatch(
      /left out to keep the conversation within the image limit; Read it/,
    );
    expect(turn.message).not.toMatch(/too large to show/);
    const paths = files.map((file) => file.storedPath);
    const answers = paths.map((path) => read(path));
    const allowed = answers.filter((a) => a.decision === 'allow').length;
    // Nothing has been measured, so each Read is charged what it can return at most: its file's 2 MiB.
    expect(allowed).toBe(Math.floor(READ_RESERVE_BYTES / (2 * MB)));
    expect(allowed).toBeLessThan(paths.length);
    const refused = answers.at(-1);
    expect(refused).toMatchObject({ decision: 'deny' });
    expect(refused?.decision === 'deny' ? refused.reason : '').toMatch(
      /pictures .*Read.*32 MB|too many pictures/i,
    );
    // What the request would carry stays under the limit, text left out.
    const charged = allowed * 2 * MB;
    expect(onTheWire(9 * 2 * MB) + onTheWire(charged)).toBeLessThan(REQUEST_LIMIT);
  });

  describe('in one message, before the session has measured any', () => {
    // Each Read of a batch passes PreToolUse before any result comes back, and only the first result is
    // unknown: resizing does not make a picture larger than its file, so the file's size bounds it.
    const measure = (path: string, bytes: number): void => {
      must(
        must(f.adapter.shapeSessions[0], 'a session').spec.postToolUse,
        'a PostToolUse hook',
      )({ toolName: 'Read', input: { file_path: path }, response: imageResult(bytes) });
    };
    const RESULT = 2.5 * MB;

    it('stay within the pool when each returns more than 1 MiB', async () => {
      // 14 MiB of the pool is spent, then seven Reads of Retina pictures come in one message.
      for (let turnNo = 0; turnNo < 3; turnNo += 1) {
        const count = turnNo === 2 ? 1 : 3;
        for (let i = 0; i < count; i += 1)
          drop(`i${String(turnNo)}-${String(i)}.png`, wholePng(2 * MB));
        expect((await nextTurn(`Turn ${String(turnNo)}`)).images).toHaveLength(count);
      }
      const inline = 7 * 2 * MB;
      const shots = Array.from({ length: 7 }, (_, i) =>
        drop(`shot${String(i)}.png`, wholePng(3 * MB)),
      );
      await nextTurn('Look at these');
      const admitted = shots.filter((shot) => read(shot.storedPath).decision === 'allow');
      expect(admitted).toHaveLength(2);
      // Then their results come back, each larger than the 1 MiB allowance.
      for (const shot of admitted) measure(shot.storedPath, RESULT);
      expect(spent()).toBe(admitted.length * RESULT);
      expect(inline + spent()).toBeLessThanOrEqual(POOL);
      expect(onTheWire(inline + spent())).toBeLessThan(REQUEST_LIMIT - 1_500_000);
    });

    it('stay within the pool even when a result is as large as its file', async () => {
      const shots = Array.from({ length: 20 }, (_, i) =>
        drop(`shot${String(i)}.png`, wholePng(3 * MB)),
      );
      await nextTurn('All of them');
      const admitted = shots.filter((shot) => read(shot.storedPath).decision === 'allow');
      expect(admitted).toHaveLength(Math.floor(POOL / (3 * MB)));
      for (const shot of admitted) measure(shot.storedPath, 3 * MB);
      expect(spent()).toBeLessThanOrEqual(POOL);
    });

    it('are refused with the way on, and fit once a result has come back', async () => {
      const shots = Array.from({ length: 2 }, (_, i) =>
        drop(`shot${String(i)}.png`, wholePng(12 * MB)),
      );
      await nextTurn('Look at these');
      const [first, second] = shots.map((shot) => shot.storedPath);
      expect(read(must(first, 'a shot'))).toEqual({ decision: 'allow' });
      const refused = read(must(second, 'a shot'));
      expect(refused).toMatchObject({ decision: 'deny' });
      expect(reasonOf(refused)).toMatch(/full file size/);
      expect(reasonOf(refused)).toMatch(/then try again/);
      measure(must(first, 'a shot'), RESULT);
      expect(read(must(second, 'a shot'))).toEqual({ decision: 'allow' });
      expect(spent()).toBe(2 * RESULT);
    });

    it('are not unlocked by a small picture, which says nothing of what a large one returns', async () => {
      const small = drop('small.png', wholePng(20_000));
      const shot = drop('shot.png', wholePng(5 * MB));
      await nextTurn('Hello');
      read(small.storedPath);
      measure(small.storedPath, 20_000);
      read(shot.storedPath);
      expect(spent()).toBe(20_000 + 5 * MB);
    });

    it('give back what a Read that failed was counted, so it can’t use up the pool', async () => {
      const shots = Array.from({ length: 2 }, (_, i) =>
        drop(`shot${String(i)}.png`, wholePng(12 * MB)),
      );
      await nextTurn('Look at these');
      const failed = must(shots[0], 'a shot').storedPath;
      read(failed);
      must(
        must(f.adapter.shapeSessions[0], 'a session').spec.toolFailed,
        'a PostToolUseFailure hook',
      )({ toolName: 'Read', input: { file_path: failed } });
      expect(spent()).toBe(0);
      expect(read(must(shots[1], 'a shot').storedPath)).toEqual({ decision: 'allow' });
      // A failure measured nothing: the next large picture is still charged its whole size.
      expect(spent()).toBe(12 * MB);
    });

    it('leave what a subagent’s failed Read did not count alone', async () => {
      const shot = drop('shot.png', wholePng(5 * MB));
      await nextTurn('Hello');
      read(shot.storedPath);
      const failed = must(f.adapter.shapeSessions[0], 'a session').spec.toolFailed;
      must(
        failed,
        'a PostToolUseFailure hook',
      )({
        toolName: 'Read',
        input: { file_path: shot.storedPath },
        agentId: 'agent-1',
        agentType: 'scope',
      });
      must(
        failed,
        'a PostToolUseFailure hook',
      )({
        toolName: 'Glob',
        input: { file_path: shot.storedPath },
      });
      expect(spent()).toBe(5 * MB);
    });
  });

  it('charge a small one by its size, so many small ones still fit', async () => {
    const small = drop('small.png', wholePng(20_000));
    await nextTurn('Hello');
    for (let i = 0; i < 50; i += 1) expect(read(small.storedPath)).toEqual({ decision: 'allow' });
  });

  it('leave a text file and a subagent’s Read uncounted', async () => {
    const doc = drop('brief.md', Buffer.from('# The brief'));
    const big = dropBig();
    await nextTurn('Hello');
    for (let i = 0; i < 20; i += 1) {
      expect(read(doc.storedPath)).toEqual({ decision: 'allow' });
      // A reviewer's result goes back to the session as text; its picture is not in this request.
      expect(read(big.storedPath, 0, 'agent-1')).toEqual({ decision: 'allow' });
    }
    expect(read(big.storedPath)).toEqual({ decision: 'allow' });
  });

  it('count a path spelled from ~ the way they count the absolute one', async () => {
    // The judge and Claude Code both expand ~, so the charge must too. The dropped files are under the temp dir.
    await f.close();
    f = createServiceFixture({ home: tmpdir() });
    const big = dropBig();
    await nextTurn('Hello');
    const spelled = `~/${relative(tmpdir(), big.storedPath)}`;
    for (let i = 0; i < EMPTY_ROOM; i += 1) expect(read(spelled)).toEqual({ decision: 'allow' });
    expect(read(spelled)).toMatchObject({ decision: 'deny' });
    expect(read(big.storedPath)).toMatchObject({ decision: 'deny' });
  });

  describe('a PDF', () => {
    // What Read returns for a PDF has no relation to its size: a small text PDF renders to pictures much
    // larger than itself. So a Read is charged by the page, and one that names no pages can't be bounded.
    const tinyPdf = () => Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(100_000)]);
    // One Read returns at most 20 pages, however much room is left.
    const room = Math.min(20, EMPTY_ROOM);

    it.each([
      ['no range', undefined],
      ['an open range', '3-'],
      ['a list of pages', '1,3'],
      ['a backwards range', '4-2'],
      ['page zero', '0'],
      ['words', 'all'],
      ['an empty value', ''],
      ['a number, not a string', 2],
      ['a range too long for one Read', '1-21'],
    ])('is refused with the way to read it when the Read has %s', async (_name, pages) => {
      const doc = drop('small.pdf', tinyPdf());
      await nextTurn('Hello');
      const answer = pages === undefined ? read(doc.storedPath) : readPages(doc.storedPath, pages);
      expect(answer).toMatchObject({ decision: 'deny' });
      expect(reasonOf(answer)).toMatch(/PDF.*pages.*32 MB/s);
      expect(reasonOf(answer)).toContain(`up to ${String(room)} pages`);
      expect(reasonOf(answer)).toMatch(/ask the builder for its text/);
      expect(spent()).toBe(0);
    });

    it('is refused once the pages asked for would pass what the pool has left', async () => {
      const doc = drop('small.pdf', tinyPdf());
      const big = dropBig();
      await nextTurn('Hello');
      for (let i = 0; i < EMPTY_ROOM - 2; i += 1) read(big.storedPath);
      expect(readPages(doc.storedPath, '1-3')).toMatchObject({ decision: 'deny' });
      expect(readPages(doc.storedPath, '1-2')).toEqual({ decision: 'allow' });
    });

    it.each([
      ['one page', '7', 1],
      ['a spaced page', ' 7 ', 1],
      ['a one-page range', '7-7', 1],
      ['a range', '2-3', 2],
      ['a spaced range', '1 - 3', 3],
    ])('is charged 1 MiB a page for %s', async (_name, pages, count) => {
      const doc = drop('small.pdf', tinyPdf());
      await nextTurn('Hello');
      expect(readPages(doc.storedPath, pages)).toEqual({ decision: 'allow' });
      expect(spent()).toBe(count * READ_CHARGE_MAX_BYTES);
    });

    it('stays under the limit however small the PDF and however many ranges are asked for', async () => {
      // A 100 kB, 400-page text PDF read 20 pages at a time would be 600 pictures.
      const doc = drop('long.pdf', tinyPdf());
      await nextTurn('Hello');
      const ranges = Array.from({ length: 400 }, (_, i) => String(i + 1));
      const answers = ranges.map((pages) => readPages(doc.storedPath, pages));
      const allowed = answers.filter((a) => a.decision === 'allow').length;
      expect(allowed).toBe(EMPTY_ROOM);
      expect(reasonOf(answers.at(-1) ?? { decision: 'allow' })).toMatch(
        /no room|what is already read/i,
      );
      expect(onTheWire(spent())).toBeLessThan(REQUEST_LIMIT - 1_500_000);
    });

    it('can be read by the page whatever the size of the file', async () => {
      const doc = drop(
        'huge.pdf',
        Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(20 * MB - 9)]),
      );
      await nextTurn('Hello');
      expect(readPages(doc.storedPath, '1')).toEqual({ decision: 'allow' });
    });

    it('is held to the 3 MiB reserve, three pages in all, when the inline budget is full', async () => {
      // Nine 2 MiB pictures, three to a message, fill the 18 MiB inline budget.
      for (let turnNo = 0; turnNo < 3; turnNo += 1) {
        for (let i = 0; i < 3; i += 1)
          drop(`i${String(turnNo)}-${String(i)}.png`, wholePng(2 * MB));
        expect((await nextTurn(`Fill ${String(turnNo)}`)).images).toHaveLength(3);
      }
      const doc = drop('small.pdf', tinyPdf());
      await nextTurn('Now the PDF');
      const pagesThatFit = READ_RESERVE_BYTES / READ_CHARGE_MAX_BYTES;
      expect(pagesThatFit).toBe(3);

      // Four pages pass the reserve; the refusal names the three that still fit.
      const tooMany = readPages(doc.storedPath, '1-4');
      expect(tooMany).toMatchObject({ decision: 'deny' });
      expect(reasonOf(tooMany)).toContain('up to 3 pages');
      expect(reasonOf(tooMany)).toContain('"1-3"');
      expect(spent()).toBe(0);

      // Three pages in all are allowed, one Read or several; the next page is refused.
      expect(readPages(doc.storedPath, '1-2')).toEqual({ decision: 'allow' });
      const oneLeft = readPages(doc.storedPath, '3-4');
      expect(oneLeft).toMatchObject({ decision: 'deny' });
      expect(reasonOf(oneLeft)).toContain('up to 1 pages');
      expect(readPages(doc.storedPath, '3')).toEqual({ decision: 'allow' });
      expect(spent()).toBe(pagesThatFit * READ_CHARGE_MAX_BYTES);
      const past = readPages(doc.storedPath, '4');
      expect(past).toMatchObject({ decision: 'deny' });
      expect(reasonOf(past)).toMatch(/No room is left for more pages/);
      expect(reasonOf(past)).not.toMatch(/up to \d+ pages/);
    });

    it('shares one total with pictures, and a subagent’s Read is left uncounted', async () => {
      const doc = drop('two.pdf', tinyPdf());
      const big = dropBig();
      await nextTurn('Hello');
      for (let i = 0; i < 5; i += 1) {
        expect(read(doc.storedPath, 0, 'agent-1')).toEqual({ decision: 'allow' });
        expect(readPages(doc.storedPath, '1-20', 0, 'agent-1')).toEqual({ decision: 'allow' });
      }
      expect(readPages(doc.storedPath, '1-20')).toEqual({ decision: 'allow' });
      // Twenty pages leave 1 MiB of the pool: one picture fits, the next does not.
      expect(read(big.storedPath)).toEqual({ decision: 'allow' });
      expect(read(big.storedPath)).toMatchObject({ decision: 'deny' });
      expect(readPages(doc.storedPath, '3')).toMatchObject({ decision: 'deny' });
    });

    it('leaves a conversation that Reads every dropped PDF under the request limit', async () => {
      // The 20 a conversation may hold: six at the 20 MB cap and fourteen small ones.
      const sized = (bytes: number) =>
        Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(bytes)]);
      const files = [
        ...Array.from({ length: 6 }, (_, i) => drop(`p${String(i)}.pdf`, sized(20 * MB - 9))),
        ...Array.from({ length: 14 }, (_, i) => drop(`s${String(i)}.pdf`, sized(100_000))),
      ];
      await nextTurn('Hello');
      // Whole, then 20 pages at a time, then a page at a time.
      for (const file of files) {
        read(file.storedPath);
        readPages(file.storedPath, '1-20');
        readPages(file.storedPath, '1');
      }
      expect(spent()).toBeLessThanOrEqual(POOL);
      expect(onTheWire(spent())).toBeLessThan(REQUEST_LIMIT - 1_500_000);
    });

    it('is not told it has room when nothing is left', async () => {
      const big = dropBig();
      const doc = drop('small.pdf', tinyPdf());
      await nextTurn('Hello');
      for (let i = 0; i < EMPTY_ROOM; i += 1) read(big.storedPath);
      const answer = read(doc.storedPath);
      expect(reasonOf(answer)).not.toMatch(/up to \d+ pages/);
      expect(reasonOf(answer)).toMatch(/ask the builder for its text/);
    });

    it('charges nothing for a PDF that is not there', async () => {
      await nextTurn('Hello');
      expect(read('/nowhere/gone.pdf').decision).not.toBe('ask');
      expect(spent()).toBe(0);
    });
  });

  it('count a path with a line break in it', () => {
    // The transcript line carries the path as Claude spelled it; a break must not hide the count.
    const line = readCountedLine('/repo/a\nb.png', 1_000);
    const message = { kind: ShapeMessageKind.Tool, body: line } as ShapeMessageDto;
    expect(readBytesSpent([message])).toBe(1_000);
  });

  it('are still counted after the daemon restarts and the session is resumed', async () => {
    const big = dropBig();
    await nextTurn('Hello');
    for (let i = 0; i < EMPTY_ROOM - 1; i += 1) read(big.storedPath);
    await f.restart();
    await nextTurn('Again');
    const resumed = must(f.adapter.shapeSessions[1], 'a resumed session');
    expect(resumed.spec.resumeProviderSessionId).not.toBeNull();
    expect(read(big.storedPath, 1)).toEqual({ decision: 'allow' });
    expect(read(big.storedPath, 1)).toMatchObject({ decision: 'deny' });
  });

  it('are not counted for a fresh session, which carries no earlier tool result', async () => {
    const big = dropBig();
    await nextTurn('Hello');
    for (let i = 0; i < EMPTY_ROOM; i += 1) read(big.storedPath);
    expect(read(big.storedPath)).toMatchObject({ decision: 'deny' });
    // Past 70% of the context the session is let go, so the next one starts from the digest.
    f.adapter.shapeBehaviour = () => Promise.resolve({ text: 'ok', contextPercent: 71 });
    f.service.send(shapeId(), 'Full');
    await f.service.settled(shapeId());
    await nextTurn('Fresh');
    const fresh = must(f.adapter.shapeSessions[1], 'a fresh session');
    expect(fresh.spec.resumeProviderSessionId).toBeNull();
    expect(read(big.storedPath, 1)).toEqual({ decision: 'allow' });
  });

  it('are not counted for a fresh session when no digest was written because Claude never spoke', async () => {
    const big = dropBig();
    // The session is let go past 70% of the context before any reply: no text, so no digest row.
    f.adapter.shapeBehaviour = () => Promise.resolve({ text: '', contextPercent: 71 });
    f.service.send(shapeId(), 'Hello');
    await f.service.settled(shapeId());
    for (let i = 0; i < EMPTY_ROOM; i += 1) read(big.storedPath);
    expect(read(big.storedPath)).toMatchObject({ decision: 'deny' });
    await nextTurn('Again');
    const fresh = must(f.adapter.shapeSessions[1], 'a fresh session');
    expect(fresh.spec.resumeProviderSessionId).toBeNull();
    expect(
      listShapeMessages(f.c.store.db, shapeId()).some((m) => m.kind === ShapeMessageKind.Digest),
    ).toBe(false);
    expect(spent()).toBe(0);
    for (let i = 0; i < EMPTY_ROOM; i += 1)
      expect(read(big.storedPath, 1)).toEqual({ decision: 'allow' });
    expect(read(big.storedPath, 1)).toMatchObject({ decision: 'deny' });
  });

  describe('with little inline picture spend', () => {
    it('are not refused on the fourth large Read while the request has room', async () => {
      const big = dropBig();
      await nextTurn('Hello');
      const answers = Array.from({ length: EMPTY_ROOM + 1 }, () => read(big.storedPath));
      expect(answers.slice(0, EMPTY_ROOM).every((a) => a.decision === 'allow')).toBe(true);
      expect(EMPTY_ROOM).toBeGreaterThan(3);
      expect(answers.at(-1)).toMatchObject({ decision: 'deny' });
    });

    it('leave Reads what inline pictures spent less of, one 2 MiB picture at a time', async () => {
      const big = dropBig();
      drop('i.png', wholePng(2 * MB));
      expect((await nextTurn('One')).images).toHaveLength(1);
      // 2 MiB of the 18 are inline: 19 MiB are left to Reads.
      const allowed = Array.from({ length: EMPTY_ROOM }, () => read(big.storedPath)).filter(
        (a) => a.decision === 'allow',
      ).length;
      expect(allowed).toBe(EMPTY_ROOM - 2);
    });

    it('leave the inline budget what Reads spent beyond their reserve', async () => {
      const big = dropBig();
      await nextTurn('Hello');
      // Sixteen Reads: 13 MiB past the 3 MiB reserve, so 5 of the 18 MiB of inline pictures are left.
      for (let i = 0; i < 16; i += 1) read(big.storedPath);
      for (let i = 0; i < 3; i += 1) drop(`i${String(i)}.png`, wholePng(2 * MB));
      const turn = await nextTurn('Pictures');
      expect(turn.images).toHaveLength(2);
    });
  });

  describe('dropped Retina screenshots, which go as paths', () => {
    const notices = (): string[] =>
      listShapeMessages(f.c.store.db, shapeId())
        .filter((m) => m.kind === ShapeMessageKind.Notice)
        .map((m) => m.body);
    const fillInline = async (): Promise<void> => {
      // Nine 2 MiB pictures, three to a message, fill the 18 MiB inline budget.
      for (let turnNo = 0; turnNo < 3; turnNo += 1) {
        for (let i = 0; i < 3; i += 1)
          drop(`i${String(turnNo)}-${String(i)}.png`, wholePng(2 * MB));
        expect((await nextTurn(`Fill ${String(turnNo)}`)).images).toHaveLength(3);
      }
    };

    it('can all be Read, four of them over 1 MiB each, with nothing said to the builder', async () => {
      const files = Array.from({ length: 4 }, (_, i) =>
        drop(`shot${String(i)}.png`, retina(MB + 200_000)),
      );
      const turn = await nextTurn('Look at these');
      expect(turn.images).toHaveLength(0);
      expect(turn.message.match(/too large to show inline; Read it/g)).toHaveLength(4);
      for (const file of files) expect(read(file.storedPath)).toEqual({ decision: 'allow' });
      expect(notices()).toEqual([]);
    });

    it('name to the builder the ones past what a session can Read, when the inline budget is full', async () => {
      await fillInline();
      const files = Array.from({ length: 4 }, (_, i) =>
        drop(`shot${String(i)}.png`, retina(MB + 200_000)),
      );
      await nextTurn('Look at these');
      // A full inline budget leaves the 3 MiB reserve, and nothing measured charges a file its size: two.
      const answers = files.map((file) => read(file.storedPath));
      expect(answers.map((a) => a.decision)).toEqual(['allow', 'allow', 'deny', 'deny']);
      const told = notices().filter((body) => /shot\d\.png/.test(body));
      expect(told).toHaveLength(1);
      expect(told[0]).toMatch(/shot2\.png, shot3\.png/);
      expect(told[0]).not.toMatch(/shot[01]\.png/);
      expect(told[0]).toMatch(/won't be able to Read/);
      // The session is out of room, not the image: a smaller copy goes as a path and is refused too.
      expect(told[0]).toMatch(/out of room for pictures/);
      expect(told[0]).toMatch(/Tell Claude which picture matters most/);
      expect(told[0]).toMatch(/new conversation/);
      expect(told[0]).not.toMatch(/smaller copy|too large/);
    });

    it('can still have a named one Read, when Claude is told to take it first', async () => {
      await fillInline();
      const files = Array.from({ length: 4 }, (_, i) =>
        drop(`shot${String(i)}.png`, retina(MB + 200_000)),
      );
      await nextTurn('Look at these');
      const answers = [files[3], files[0], files[1], files[2]].map((file) =>
        read(must(file, 'a dropped file').storedPath),
      );
      expect(answers.map((a) => a.decision)).toEqual(['allow', 'allow', 'deny', 'deny']);
    });

    it('count the pictures already Read against what a session can Read', async () => {
      const big = dropBig();
      await nextTurn('Hello');
      for (let i = 0; i < EMPTY_ROOM - 2; i += 1) read(big.storedPath);
      for (let i = 0; i < 3; i += 1) drop(`shot${String(i)}.png`, retina(MB + 200_000));
      await nextTurn('Look at these');
      const told = notices().filter((body) => /shot\d\.png/.test(body));
      expect(told).toHaveLength(1);
      expect(told[0]).toMatch(/shot1\.png, shot2\.png/);
      expect(told[0]).not.toMatch(/shot0\.png/);
    });

    describe('when the turn that names them never reaches Claude', () => {
      const shots = () =>
        Array.from({ length: 4 }, (_, i) => drop(`shot${String(i)}.png`, retina(MB + 200_000)));
      const shotNotices = () => notices().filter((body) => /shot\d\.png/.test(body));

      it('says nothing when the send fails, and says it on the retry', async () => {
        await fillInline();
        shots();
        const live = must(f.adapter.shapeSessions[0], 'the live session').handle;
        const send = live.send.bind(live);
        let failures = 1;
        (live as { send: typeof live.send }).send = (text, images) => {
          if (failures-- > 0) throw new Error('the pipe is closed');
          send(text, images);
        };
        f.service.send(shapeId(), 'Look at these');
        await f.service.settled(shapeId());
        expect(notices().filter((body) => body.includes('could not start'))).toHaveLength(1);
        expect(shotNotices()).toEqual([]);
        await nextTurn('Look again');
        expect(shotNotices()).toHaveLength(1);
        expect(shotNotices()[0]).toMatch(/shot2\.png, shot3\.png/);
      });

      it('says nothing when the session fails to start, and says it on the retry', async () => {
        await fillInline();
        shots();
        // Quitting ends the live session; the next turn resumes the conversation's session.
        await f.restart();
        const start = f.adapter.startShape.bind(f.adapter);
        let failures = 1;
        f.adapter.startShape = (spec) => {
          if (failures-- > 0) throw new Error('Claude is not available');
          return start(spec);
        };
        f.service.send(shapeId(), 'Look at these');
        await f.service.settled(shapeId());
        expect(notices().filter((body) => body.includes('could not start'))).toHaveLength(1);
        expect(shotNotices()).toEqual([]);
        await nextTurn('Look again');
        expect(shotNotices()).toHaveLength(1);
        expect(shotNotices()[0]).toMatch(/shot2\.png, shot3\.png/);
      });
    });

    describe('refused when the send-time notice could not predict it', () => {
      const shots = (n: number, from = 0) =>
        Array.from({ length: n }, (_, i) =>
          drop(`shot${String(from + i)}.png`, retina(MB + 200_000)),
        );
      const shotNotices = () => notices().filter((body) => /shot\d\.png/.test(body));

      it('names an image of an earlier turn that no Read had yet made room for', async () => {
        await fillInline();
        // Turn one drops two (2.4 of the 3 MiB fit) and Claude Reads none; turn two drops one, and the
        // send-time notice sees all the room still free for it.
        const first = shots(2);
        await nextTurn('Two');
        const [third] = shots(1, 2);
        await nextTurn('One more');
        expect(shotNotices()).toEqual([]);
        expect(read(must(first[0], 'a file').storedPath)).toEqual({ decision: 'allow' });
        expect(read(must(first[1], 'a file').storedPath)).toEqual({ decision: 'allow' });
        expect(read(must(third, 'a file').storedPath)).toMatchObject({ decision: 'deny' });
        const told = shotNotices();
        expect(told).toHaveLength(1);
        expect(told[0]).toContain('shot2.png');
        expect(told[0]).toMatch(/refused|couldn't Read/);
        expect(told[0]).toMatch(/out of room for pictures/);
        // Refused again: the builder was told already.
        read(must(third, 'a file').storedPath);
        expect(shotNotices()).toHaveLength(1);
      });

      it('names the image actually refused when Claude Reads out of the order the notice assumed', async () => {
        await fillInline();
        const files = shots(4);
        await nextTurn('Look at these');
        expect(shotNotices()).toHaveLength(1);
        expect(shotNotices()[0]).toMatch(/shot2\.png, shot3\.png/);
        // Claude takes shot2, then shot0, which fill the room; shot1 is refused though the notice never named it.
        const order = [files[2], files[0], files[1]].map((file) =>
          read(must(file, 'a file').storedPath),
        );
        expect(order.map((a) => a.decision)).toEqual(['allow', 'allow', 'deny']);
        const told = shotNotices();
        expect(told).toHaveLength(2);
        expect(told[1]).toContain('shot1.png');
        expect(told[1]).not.toMatch(/shot[023]\.png/);
      });

      it('tells apart two images with one name, naming each by the file it is kept in', async () => {
        await fillInline();
        const [first, second] = shots(2);
        await nextTurn('Two');
        // Every pasted screenshot is called this, one to a turn, so no send-time notice sees them.
        const pasted = [1, 2].map(() => drop('pasted-image.png', retina(MB + 200_000)));
        await nextTurn('A paste');
        expect(notices()).toEqual([]);
        for (const file of [first, second]) read(must(file, 'a file').storedPath);
        expect(read(must(pasted[0], 'a paste').storedPath)).toMatchObject({ decision: 'deny' });
        expect(notices()).toHaveLength(1);
        expect(notices()[0]).toContain('Read pasted-image.png:');
        // Another file, though it has the same name: the builder is told, and can tell which.
        expect(read(must(pasted[1], 'a paste').storedPath)).toMatchObject({ decision: 'deny' });
        expect(notices()).toHaveLength(2);
        expect(notices()[1]).toContain('Read pasted-image-2.png:');
      });

      it('still names a refused image when the send-time notice named another of its name', async () => {
        await fillInline();
        const pasted = [0, 1, 2, 3].map(() => drop('pasted-image.png', retina(MB + 200_000)));
        await nextTurn('Pastes');
        expect(notices()).toHaveLength(1);
        expect(notices()[0]).toMatch(/Read pasted-image-3\.png, pasted-image-4\.png:/);
        const order = [pasted[2], pasted[0], pasted[1]].map((file) =>
          read(must(file, 'a paste').storedPath),
        );
        expect(order.map((a) => a.decision)).toEqual(['allow', 'allow', 'deny']);
        expect(notices()).toHaveLength(2);
        expect(notices()[1]).toContain('Read pasted-image-2.png:');
      });

      it('names an image with a comma in its name once, however many times it is refused', async () => {
        await fillInline();
        const first = shots(2);
        await nextTurn('Two');
        const comma = drop('Mockup, final.png', retina(MB + 200_000));
        const plain = drop('final.png', retina(MB + 200_000));
        await nextTurn('Mockups');
        for (const file of first) read(file.storedPath);
        const before = notices().length;
        for (let i = 0; i < 3; i += 1)
          expect(read(comma.storedPath)).toMatchObject({ decision: 'deny' });
        expect(notices()).toHaveLength(before + 1);
        expect(notices().at(-1)).toContain('Read Mockup, final.png:');
        // The other name is the end of that one, and is another file.
        read(plain.storedPath);
        expect(notices()).toHaveLength(before + 2);
        expect(notices().at(-1)).toContain('Read final.png:');
      });

      it('does not repeat an image the send-time notice named, a comma in its name or not', async () => {
        await fillInline();
        const files = [...shots(2), drop('Mockup, final.png', retina(MB + 200_000))];
        await nextTurn('Look at these');
        expect(notices()).toHaveLength(1);
        expect(notices()[0]).toContain('Mockup, final.png');
        const answers = files.map((file) => read(file.storedPath));
        expect(answers.map((a) => a.decision)).toEqual(['allow', 'allow', 'deny']);
        expect(notices()).toHaveLength(1);
      });

      it('says nothing for a refused picture that is not a dropped file, or a subagent’s Read', async () => {
        // A real checkout: a Read outside it is denied by confinement and never reaches the pool.
        const checkout = realpathSync(mkdtempSync(join(tmpdir(), 'shape-checkout-')));
        await f.close();
        f = createServiceFixture({ checkout });
        try {
          await fillInline();
          const files = shots(2);
          await nextTurn('Look at these');
          for (const file of files) read(file.storedPath);
          const before = notices().length;
          // The same name as a dropped file, so a match by name or by basename would notice it.
          const inCheckout = join(checkout, 'shot0.png');
          writeFileSync(inCheckout, retina(MB + 200_000));
          const refused = read(inCheckout);
          expect(refused).toMatchObject({ decision: 'deny' });
          expect(reasonOf(refused)).toMatch(/Too many pictures read/);
          const later = drop('later.png', retina(MB + 200_000));
          expect(read(later.storedPath, 0, 'agent-1')).toEqual({ decision: 'allow' });
          expect(notices()).toHaveLength(before);
        } finally {
          rmSync(checkout, { recursive: true, force: true });
        }
      });
    });

    it('count at the allowance in the notice once a large Read has been measured', async () => {
      await fillInline();
      const shot = drop('first.png', retina(MB + 200_000));
      await nextTurn('This one');
      read(shot.storedPath);
      must(
        must(f.adapter.shapeSessions[0], 'a session').spec.postToolUse,
        'a PostToolUse hook',
      )({
        toolName: 'Read',
        input: { file_path: shot.storedPath },
        response: imageResult(500_000),
      });
      // 2.5 MiB of the reserve is left: two at the 1 MiB allowance, though 1.2 MiB files.
      for (let i = 0; i < 3; i += 1) drop(`shot${String(i)}.png`, retina(MB + 200_000));
      await nextTurn('Look at these');
      const told = notices().filter((body) => /shot\d\.png/.test(body));
      expect(told).toHaveLength(1);
      expect(told[0]).toContain('shot2.png');
      expect(told[0]).not.toMatch(/shot[01]\.png/);
    });
  });

  describe('once the session has measured what a Read returned', () => {
    const dropBig = () => drop('big.png', wholePng(5 * MB));
    const measure = (path: string, response: unknown, n = 0, agentId?: string): void => {
      const after = must(f.adapter.shapeSessions[n], 'a session').spec.postToolUse;
      must(
        after,
        'a PostToolUse hook',
      )({
        toolName: 'Read',
        input: { file_path: path },
        response,
        ...(agentId === undefined ? {} : { agentId, agentType: 'scope' }),
      });
    };

    it('charges the measured size in place of what it counted', async () => {
      const big = dropBig();
      await nextTurn('Hello');
      expect(read(big.storedPath)).toEqual({ decision: 'allow' });
      expect(spent()).toBe(big.size);
      measure(big.storedPath, imageResult(300_000));
      expect(spent()).toBe(300_000);
    });

    it('lets more Reads in when each returns less than the allowance', async () => {
      const big = dropBig();
      await nextTurn('Hello');
      let allowed = 0;
      for (let i = 0; i < 300; i += 1) {
        if (read(big.storedPath).decision !== 'allow') break;
        measure(big.storedPath, imageResult(100_000));
        allowed += 1;
      }
      // A Read is let in while the allowance, not yet measured, still fits in what the measured ones left.
      expect(allowed).toBe(Math.floor((POOL - READ_CHARGE_MAX_BYTES) / 100_000) + 1);
      expect(allowed).toBeGreaterThan(EMPTY_ROOM * 5);
      expect(spent()).toBe(allowed * 100_000);
    });

    it('charges more than the allowance when a Read returned more', async () => {
      const big = dropBig();
      await nextTurn('Hello');
      read(big.storedPath);
      measure(big.storedPath, imageResult(2 * MB));
      expect(spent()).toBe(2 * MB);
    });

    it('keeps what it counted when the result has no picture bytes, or is a subagent’s or not a Read the hook counted', async () => {
      const big = dropBig();
      const doc = drop('brief.md', Buffer.from('# The brief'));
      await nextTurn('Hello');
      read(big.storedPath);
      measure(big.storedPath, { type: 'parts', file: { filePath: big.storedPath, count: 3 } });
      measure(big.storedPath, imageResult(10), 0, 'agent-1');
      measure(doc.storedPath, imageResult(10));
      expect(spent()).toBe(big.size);
    });

    it('charges 0 for a Read Claude Code answered with file_unchanged, which added no bytes', async () => {
      const big = dropBig();
      await nextTurn('Hello');
      read(big.storedPath);
      expect(spent()).toBe(big.size);
      measure(big.storedPath, { type: 'file_unchanged', file: { filePath: big.storedPath } });
      expect(spent()).toBe(0);
    });

    it('keeps the allowance of a parts result, whose bytes stayed on disk, while file_unchanged gives it back', async () => {
      const big = dropBig();
      await nextTurn('Hello');
      read(big.storedPath);
      measure(big.storedPath, { type: 'parts', file: { filePath: big.storedPath, count: 3 } });
      expect(spent()).toBe(big.size);
      measure(big.storedPath, { type: 'file_unchanged', file: { filePath: big.storedPath } });
      expect(spent()).toBe(0);
    });

    it('is counted after a restart', async () => {
      const big = dropBig();
      await nextTurn('Hello');
      read(big.storedPath);
      measure(big.storedPath, imageResult(300_000));
      await f.restart();
      await nextTurn('Again');
      expect(spent()).toBe(300_000);
    });
  });

  describe('once the session has measured a Read over 1 MiB', () => {
    // Reads issued in one message all pass PreToolUse before any result is measured, so an unmeasured Read
    // is charged at the largest size this session has measured, never under the allowance.
    const BIG = 2.5 * MB;
    const dropBig = () => drop('big.png', wholePng(5 * MB));
    const measure = (path: string, bytes: number, pages?: string): void => {
      must(
        must(f.adapter.shapeSessions[0], 'a session').spec.postToolUse,
        'a PostToolUse hook',
      )({
        toolName: 'Read',
        input: pages === undefined ? { file_path: path } : { file_path: path, pages },
        response: imageResult(bytes),
      });
    };

    it('charges a later unmeasured Read at least that size', async () => {
      const big = dropBig();
      await nextTurn('Hello');
      read(big.storedPath);
      measure(big.storedPath, BIG);
      expect(spent()).toBe(BIG);
      expect(read(big.storedPath)).toEqual({ decision: 'allow' });
      expect(spent()).toBe(2 * BIG);
    });

    it('does not lower the charge when a later Read measures less', async () => {
      const big = dropBig();
      await nextTurn('Hello');
      read(big.storedPath);
      measure(big.storedPath, BIG);
      read(big.storedPath);
      measure(big.storedPath, 300_000);
      expect(spent()).toBe(BIG + 300_000);
      read(big.storedPath);
      expect(spent()).toBe(2 * BIG + 300_000);
    });

    it('still charges a file smaller than that by its own size', async () => {
      const big = dropBig();
      const small = drop('small.png', wholePng(20_000));
      await nextTurn('Hello');
      read(big.storedPath);
      measure(big.storedPath, BIG);
      read(small.storedPath);
      expect(spent()).toBe(BIG + 20_000);
    });

    it('keeps a later batch, admitted before any of its own results is measured, within the pool', async () => {
      const big = dropBig();
      await nextTurn('Hello');
      read(big.storedPath);
      measure(big.storedPath, BIG);
      // Twenty Reads in one message: all pass PreToolUse, then their results come back.
      const admitted = Array.from({ length: 20 }, () => read(big.storedPath)).filter(
        (a) => a.decision === 'allow',
      ).length;
      expect(admitted).toBe(Math.floor((POOL - BIG) / BIG));
      for (let i = 0; i < admitted; i += 1) measure(big.storedPath, BIG);
      expect(spent()).toBe((admitted + 1) * BIG);
      expect(spent()).toBeLessThanOrEqual(POOL);
      expect(onTheWire(spent())).toBeLessThan(REQUEST_LIMIT - 1_500_000);
    });

    it('replaces what each Read of a first batch was counted, though the allowance has grown by then', async () => {
      const big = dropBig();
      await nextTurn('Hello');
      // Nothing measured yet: three Reads of one message are each counted at the file's size.
      for (let i = 0; i < 3; i += 1) read(big.storedPath);
      expect(spent()).toBe(3 * big.size);
      for (let i = 0; i < 3; i += 1) measure(big.storedPath, BIG);
      expect(spent()).toBe(3 * BIG);
    });

    it('stays a whole number of bytes when a PDF’s size does not divide by its pages', async () => {
      const doc = drop(
        'three.pdf',
        Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(100_000)]),
      );
      const big = dropBig();
      await nextTurn('Hello');
      readPages(doc.storedPath, '1-3');
      measure(doc.storedPath, 10_000_000, '1-3');
      expect(largestReadMeasured(listShapeMessages(f.c.store.db, shapeId()))).toBe(3_333_334);
      // Both kinds of later Read are charged the rounded-up page, and both show in the total.
      read(big.storedPath);
      measure(big.storedPath, BIG);
      readPages(doc.storedPath, '4');
      expect(spent()).toBe(10_000_000 + BIG + 3_333_334);
      read(big.storedPath);
      expect(spent()).toBe(10_000_000 + BIG + 2 * 3_333_334);
    });

    it('charges a PDF page at the largest page measured, and measures a PDF by its pages', async () => {
      const doc = drop(
        'two.pdf',
        Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(100_000)]),
      );
      await nextTurn('Hello');
      expect(readPages(doc.storedPath, '1-3')).toEqual({ decision: 'allow' });
      measure(doc.storedPath, 9 * MB, '1-3');
      expect(spent()).toBe(9 * MB);
      expect(readPages(doc.storedPath, '4-5')).toEqual({ decision: 'allow' });
      expect(spent()).toBe(9 * MB + 6 * MB);
    });

    it('reads a measurement of a PDF written before the page count was recorded as 1 MiB a page', () => {
      const body = 'Read · /a.pdf · PDF · 6291456 bytes measured in place of 3145728';
      expect(readBytesSpent([{ kind: ShapeMessageKind.Tool, body } as ShapeMessageDto])).toBe(
        6291456 - 3145728,
      );
      expect(largestReadMeasured([{ kind: ShapeMessageKind.Tool, body } as ShapeMessageDto])).toBe(
        2 * MB,
      );
    });

    it('is forgotten with a fresh session, which carries none of those results', async () => {
      const big = dropBig();
      await nextTurn('Hello');
      read(big.storedPath);
      measure(big.storedPath, BIG);
      f.adapter.shapeBehaviour = () => Promise.resolve({ text: 'ok', contextPercent: 71 });
      f.service.send(shapeId(), 'Full');
      await f.service.settled(shapeId());
      await nextTurn('Fresh');
      expect(read(big.storedPath, 1)).toEqual({ decision: 'allow' });
      // With nothing measured in the new session, a file is charged its size again.
      expect(spent()).toBe(big.size);
    });
  });

  describe('measuredMediaBytes', () => {
    it.each([
      ['an image result', imageResult(3_000), 3_000],
      ['content blocks', [{ type: 'image', source: { type: 'base64', data: base64Of(900) } }], 900],
      ['two pictures', [imageResult(300), imageResult(600)], 900],
      ['a text result', { type: 'text', file: { content: 'x'.repeat(5_000) } }, 0],
      ['a string', 'ok', 0],
      ['nothing', undefined, 0],
    ])('finds the bytes before base64 in %s', (_name, response, bytes) => {
      expect(measuredMediaBytes(response)).toBe(bytes);
    });
  });
});
