import { tmpdir } from 'node:os';
import { relative } from 'node:path';
import { ShapeMessageKind, type ShapeMessageDto } from '@10db/contracts';
import { listShapeMessages } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pngOfSize } from '../../test/png';
import { INLINE_CONVERSATION_MAX_BYTES } from '../screens';
import type { FakeShapeTurn } from '../sessions';
import { must } from './conversation-fixture';
import {
  READ_PICTURE_CHARGE_MAX_BYTES,
  READ_PICTURES_MAX_BYTES,
  readPictureBytesSpent,
  readPictureLine,
} from './read-budget';
import { createServiceFixture, type ServiceFixture } from './service-fixture';

// Shape spec §5.4: a picture Claude pulls in with Read is a tool result a resumed session resends, beside
// the pictures the daemon sends itself. The preToolUse hook counts it and refuses what would pass the total.

const MB = 1024 * 1024;
/** The API's request limit, and base64's growth of what a picture weighs on the wire. */
const REQUEST_LIMIT = 32_000_000;
const onTheWire = (bytes: number): number => Math.ceil((bytes * 4) / 3);

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
const spent = () => readPictureBytesSpent(listShapeMessages(f.c.store.db, shapeId()));

describe('the pictures a Shape session pulls in with Read', () => {
  it('fits the request limit beside a full inline budget', () => {
    expect(
      onTheWire(INLINE_CONVERSATION_MAX_BYTES) + onTheWire(READ_PICTURES_MAX_BYTES),
    ).toBeLessThan(REQUEST_LIMIT - 1_500_000);
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
    expect(turn.message).toMatch(/too large to show inline; Read it/);
    const paths = files.map((file) => file.storedPath);
    const answers = paths.map((path) => read(path));
    const allowed = answers.filter((a) => a.decision === 'allow').length;
    // Each Read is charged what Claude Code can return for it, at most the per-picture charge.
    expect(allowed).toBe(Math.floor(READ_PICTURES_MAX_BYTES / READ_PICTURE_CHARGE_MAX_BYTES));
    expect(allowed).toBeLessThan(paths.length);
    const refused = answers.at(-1);
    expect(refused).toMatchObject({ decision: 'deny' });
    expect(refused?.decision === 'deny' ? refused.reason : '').toMatch(
      /pictures .*Read.*32 MB|too many pictures/i,
    );
    // What the request would carry stays under the limit, text left out.
    const charged = allowed * READ_PICTURE_CHARGE_MAX_BYTES;
    expect(onTheWire(9 * 2 * MB) + onTheWire(charged)).toBeLessThan(REQUEST_LIMIT);
  });

  it('charge a small one by its size, so many small ones still fit', async () => {
    const small = drop('small.png', wholePng(20_000));
    await nextTurn('Hello');
    for (let i = 0; i < 50; i += 1) expect(read(small.storedPath)).toEqual({ decision: 'allow' });
  });

  it('leave a text file and a subagent’s Read uncounted', async () => {
    const doc = drop('brief.md', Buffer.from('# The brief'));
    const big = drop('big.png', wholePng(5 * MB));
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
    const big = drop('big.png', wholePng(5 * MB));
    await nextTurn('Hello');
    const spelled = `~/${relative(tmpdir(), big.storedPath)}`;
    const room = Math.floor(READ_PICTURES_MAX_BYTES / READ_PICTURE_CHARGE_MAX_BYTES);
    for (let i = 0; i < room; i += 1) expect(read(spelled)).toEqual({ decision: 'allow' });
    expect(read(spelled)).toMatchObject({ decision: 'deny' });
    expect(read(big.storedPath)).toMatchObject({ decision: 'deny' });
  });

  describe('a PDF', () => {
    // What Read returns for a PDF has no relation to its size: a small text PDF renders to pictures much
    // larger than itself. So a Read is charged by the page, and one that names no pages can't be bounded.
    const tinyPdf = () => Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(100_000)]);
    const room = Math.floor(READ_PICTURES_MAX_BYTES / READ_PICTURE_CHARGE_MAX_BYTES);

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
      ['more pages than the total holds', '1-4'],
    ])('is refused with the way to read it when the Read has %s', async (_name, pages) => {
      const doc = drop('small.pdf', tinyPdf());
      await nextTurn('Hello');
      const answer = pages === undefined ? read(doc.storedPath) : readPages(doc.storedPath, pages);
      expect(answer).toMatchObject({ decision: 'deny' });
      expect(reasonOf(answer)).toMatch(/PDF.*pages.*32 MB/s);
      expect(reasonOf(answer)).toContain(`up to ${String(room)} pages`);
      expect(reasonOf(answer)).toMatch(/ask the builder for its text/);
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
      expect(spent()).toBe(count * READ_PICTURE_CHARGE_MAX_BYTES);
    });

    it('stays under the limit however small the PDF and however many ranges are asked for', async () => {
      // A 100 kB, 400-page text PDF read 20 pages at a time would be 600 pictures.
      const doc = drop('long.pdf', tinyPdf());
      await nextTurn('Hello');
      const ranges = Array.from({ length: 400 }, (_, i) => String(i + 1));
      const answers = ranges.map((pages) => readPages(doc.storedPath, pages));
      const allowed = answers.filter((a) => a.decision === 'allow').length;
      expect(allowed).toBe(room);
      expect(reasonOf(answers.at(-1) ?? { decision: 'allow' })).toMatch(
        /no room|what is already read/i,
      );
      expect(onTheWire(INLINE_CONVERSATION_MAX_BYTES) + onTheWire(spent())).toBeLessThan(
        REQUEST_LIMIT,
      );
    });

    it('can be read by the page whatever the size of the file', async () => {
      const doc = drop(
        'huge.pdf',
        Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(20 * MB - 9)]),
      );
      await nextTurn('Hello');
      expect(readPages(doc.storedPath, '1')).toEqual({ decision: 'allow' });
    });

    it('shares one total with pictures, and a subagent’s Read is left uncounted', async () => {
      const doc = drop('two.pdf', tinyPdf());
      const big = drop('big.png', wholePng(5 * MB));
      await nextTurn('Hello');
      for (let i = 0; i < 5; i += 1) {
        expect(read(doc.storedPath, 0, 'agent-1')).toEqual({ decision: 'allow' });
        expect(readPages(doc.storedPath, '1-20', 0, 'agent-1')).toEqual({ decision: 'allow' });
      }
      expect(readPages(doc.storedPath, '1-2')).toEqual({ decision: 'allow' });
      // Two pages leave 1 MiB: one picture fits, the next does not.
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
      expect(spent()).toBeLessThanOrEqual(READ_PICTURES_MAX_BYTES);
      expect(onTheWire(INLINE_CONVERSATION_MAX_BYTES) + onTheWire(spent())).toBeLessThan(
        REQUEST_LIMIT,
      );
    });

    it('is not told it has room when nothing is left', async () => {
      const big = drop('big.png', wholePng(5 * MB));
      const doc = drop('small.pdf', tinyPdf());
      await nextTurn('Hello');
      for (let i = 0; i < room; i += 1) read(big.storedPath);
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
    const line = readPictureLine('/repo/a\nb.png', 1_000);
    const message = { kind: ShapeMessageKind.Tool, body: line } as ShapeMessageDto;
    expect(readPictureBytesSpent([message])).toBe(1_000);
  });

  it('are still counted after the daemon restarts and the session is resumed', async () => {
    const big = drop('big.png', wholePng(5 * MB));
    await nextTurn('Hello');
    const room = Math.floor(READ_PICTURES_MAX_BYTES / READ_PICTURE_CHARGE_MAX_BYTES);
    for (let i = 0; i < room - 1; i += 1) read(big.storedPath);
    await f.restart();
    await nextTurn('Again');
    const resumed = must(f.adapter.shapeSessions[1], 'a resumed session');
    expect(resumed.spec.resumeProviderSessionId).not.toBeNull();
    expect(read(big.storedPath, 1)).toEqual({ decision: 'allow' });
    expect(read(big.storedPath, 1)).toMatchObject({ decision: 'deny' });
  });

  it('are not counted for a fresh session, which carries no earlier tool result', async () => {
    const big = drop('big.png', wholePng(5 * MB));
    await nextTurn('Hello');
    const room = Math.floor(READ_PICTURES_MAX_BYTES / READ_PICTURE_CHARGE_MAX_BYTES);
    for (let i = 0; i < room; i += 1) read(big.storedPath);
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
});
