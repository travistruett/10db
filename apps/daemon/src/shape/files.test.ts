import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EventType,
  InvalidError,
  ScreenName,
  ShapeMessageAuthor,
  ShapeMessageKind,
  ShapeOrigin,
  StartShapeInput,
  type ShapeFileDto,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pngImage } from '../../test/png';
import {
  createScreens,
  INLINE_CONVERSATION_MAX_BYTES,
  inlineBytesSpent,
  type ScreenOutcome,
} from '../screens';
import type { FakeShapeTurn } from '../sessions';
import { jpegOfSize } from '../../test/jpeg';
import { pngOfSize } from '../../test/png';
import { webpImage } from '../../test/webp';
import { readImageSize } from '../screens';
import { must } from './conversation-fixture';
import { createServiceFixture, type ServiceFixture } from './service-fixture';

// Shape spec §5.4 Dropped files and §5.6 Starting from a terminal.

let f: ServiceFixture;
beforeEach(() => {
  f = createServiceFixture();
});
afterEach(async () => {
  await f.close();
});

const shapeId = () => f.c.shape.id;
// Whole images with a real size: the daemon reads it to know which can be sent as a block.
const PNG = pngOfSize(100, 80);
const JPEG = jpegOfSize(100, 80);
const WEBP = webpImage('lossy', 100, 80);
const PDF = Buffer.from('%PDF-1.7\n%%EOF');

const drop = (name: string, bytes: Uint8Array, mediaType = ''): ShapeFileDto =>
  f.service.addFile(shapeId(), { name, mediaType, bytes });

/** The turn the next message runs, as the session sees it. */
async function nextTurn(text = 'Here you go', id = shapeId()): Promise<FakeShapeTurn> {
  const seen: { turn: FakeShapeTurn | null } = { turn: null };
  f.adapter.shapeBehaviour = (turn) => {
    seen.turn = turn;
    return Promise.resolve({ text: 'ok' });
  };
  f.service.send(id, text);
  await f.service.settled(id);
  return must(seen.turn, 'a turn');
}

describe('what a session may read of the dropped files', () => {
  it('is its own conversation’s files directory, and no other conversation’s', async () => {
    const own = drop('brief.md', Buffer.from('# The brief'));
    const other = join(f.filesDir, 'shp_other', 'files', 'secret.md');
    mkdirSync(join(f.filesDir, 'shp_other', 'files'), { recursive: true });
    writeFileSync(other, 'another project’s document');
    await nextTurn('Read this');
    const { spec } = must(f.adapter.shapeSessions[0], 'a session');
    const read = (file_path: string) => spec.preToolUse({ toolName: 'Read', input: { file_path } });
    expect(read(own.storedPath)).toEqual({ decision: 'allow' });
    expect(read(other)).toMatchObject({ decision: 'deny' });
    expect(
      spec.preToolUse({ toolName: 'Glob', input: { pattern: '*', path: f.filesDir } }),
    ).toMatchObject({ decision: 'deny' });
  });
});

describe('a dropped text file', () => {
  it('is copied under the conversation’s files directory and listed', () => {
    const file = drop('brief.md', Buffer.from('# The brief'), 'text/markdown');
    expect(file).toMatchObject({ name: 'brief.md', mediaType: 'text/markdown', size: 11 });
    expect(file.storedPath.startsWith(join(f.filesDir, shapeId(), 'files'))).toBe(true);
    expect(readFileSync(file.storedPath, 'utf8')).toBe('# The brief');
    expect(f.service.view(shapeId()).files.map((x) => x.name)).toEqual(['brief.md']);
  });

  it('reaches the session as a line naming the path, with the next message, once', async () => {
    const file = drop('brief.md', Buffer.from('# The brief'));
    const first = await nextTurn('Read this');
    expect(first.message).toContain(`[file] ${file.storedPath}`);
    expect(first.message.indexOf('[file]')).toBeLessThan(first.message.indexOf('Read this'));
    expect(first.images).toEqual([]);
    const second = await nextTurn('And?');
    expect(second.message).not.toContain('[file]');
  });

  it('reaches a resumed session after the daemon restarts between the drop and the next turn', async () => {
    await nextTurn('Hello');
    const resumeId = must(f.adapter.shapeSessions[0], 'a session').spec.sessionId;
    const file = drop('brief.md', Buffer.from('# The brief'));
    await f.restart();
    const turn = await nextTurn('Read the doc I dropped');
    const session = must(f.adapter.shapeSessions[1], 'a resumed session');
    expect(session.spec.sessionId).not.toBe(resumeId);
    expect(session.spec.resumeProviderSessionId).not.toBeNull();
    expect(turn.message).toContain(`[file] ${file.storedPath}`);
  });

  it('is not told again after a restart once a turn has carried it', async () => {
    await nextTurn('Hello');
    drop('brief.md', Buffer.from('# The brief'));
    await nextTurn('Read this');
    await f.restart();
    const turn = await nextTurn('And?');
    expect(
      must(f.adapter.shapeSessions[1], 'a resumed session').spec.resumeProviderSessionId,
    ).not.toBeNull();
    expect(turn.message).not.toContain('[file]');
  });

  it('keeps two files of one name apart', () => {
    const a = drop('brief.md', Buffer.from('one'));
    const b = drop('brief.md', Buffer.from('two'));
    expect(a.storedPath).not.toBe(b.storedPath);
    expect(readFileSync(a.storedPath, 'utf8')).toBe('one');
    expect(readFileSync(b.storedPath, 'utf8')).toBe('two');
  });

  it('is stored under its base name, whatever path the browser reported', () => {
    const file = drop('../../etc/notes.txt', Buffer.from('x'));
    expect(file.name).toBe('notes.txt');
    expect(file.storedPath.startsWith(join(f.filesDir, shapeId(), 'files'))).toBe(true);
  });
});

describe('a dropped PDF', () => {
  it('reaches the session as a path to read', async () => {
    const file = drop('spec.pdf', PDF, 'application/pdf');
    const turn = await nextTurn('See the spec');
    expect(turn.message).toContain(`[file] ${file.storedPath}`);
    expect(turn.images).toEqual([]);
  });
});

describe('a dropped image', () => {
  it.each([
    { name: 'a PNG', file: 'shot.png', bytes: PNG, type: 'image/png' },
    { name: 'a JPEG', file: 'photo.jpg', bytes: JPEG, type: 'image/jpeg' },
    { name: 'a WebP', file: 'pic.webp', bytes: WEBP, type: 'image/webp' },
  ])('reaches the session as an image content block: $name', async ({ file, bytes, type }) => {
    const stored = drop(file, bytes);
    expect(stored.mediaType).toBe(type);
    const turn = await nextTurn('Like this');
    expect(turn.images).toEqual([{ mediaType: type, data: bytes.toString('base64') }]);
    expect(turn.message).toContain(stored.storedPath);
    const next = await nextTurn('Again');
    expect(next.images).toEqual([]);
  });

  it('is sent with the first message of a session that has not started', async () => {
    drop('shot.png', PNG);
    f.adapter.shapeBehaviour = () => Promise.resolve({ text: 'ok' });
    f.service.send(shapeId(), 'Look');
    await f.service.settled(shapeId());
    const session = must(f.adapter.shapeSessions[0], 'a session');
    expect(session.spec.images).toEqual([{ mediaType: 'image/png', data: PNG.toString('base64') }]);
  });
});

// The API refuses an image over about 5 MB and a request over 32 MB, and a resumed session resends every
// earlier image, so a large image goes as a path to Read (which resizes) rather than as a block.
describe('a large dropped image', () => {
  const MB = 1024 * 1024;
  const sized = (head: Buffer, bytes: number): Buffer =>
    Buffer.concat([head, Buffer.alloc(bytes - head.length)]);
  /** A whole 100×80 PNG of exactly this many bytes, which the daemon can read the size of. */
  const wholePng = (bytes: number): Buffer => pngOfSize(100, 80, bytes - PNG.length - 12);

  it('goes as a path to Read, not an image block, so the turn can end', async () => {
    const stored = drop('big.png', sized(PNG, 12 * MB));
    const turn = await nextTurn('What is this?');
    expect(turn.images).toEqual([]);
    expect(turn.message).toContain(`[file] ${stored.storedPath} (big.png)`);
    expect(turn.message).toMatch(/too large to show.*Read/);
  });

  it('does the same for a 20 MB image, whatever its type', async () => {
    drop('huge.jpg', sized(JPEG, 20 * MB));
    drop('huge.webp', sized(WEBP, 20 * MB));
    const turn = await nextTurn('Look');
    expect(turn.images).toEqual([]);
    expect(turn.message.match(/too large to show/g)).toHaveLength(2);
  });

  // The API refuses an image over 8000 px on a side however few bytes it takes, and a resumed session
  // resends it with every request, so a tall full-page screenshot goes as a path too.
  describe('over 8000 px on a side', () => {
    const png = (width: number, height: number): Buffer => {
      const head = Buffer.alloc(33);
      PNG.copy(head);
      head.writeUInt32BE(13, 8);
      head.write('IHDR', 12, 'ascii');
      head.writeUInt32BE(width, 16);
      head.writeUInt32BE(height, 20);
      return sized(head, 100_000);
    };
    const jpeg = (width: number, height: number): Buffer => {
      const sof = Buffer.from([
        0xff, 0xc0, 0, 17, 8, 0, 0, 0, 0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
      ]);
      sof.writeUInt16BE(height, 5);
      sof.writeUInt16BE(width, 7);
      // An APP0 segment first, so the frame header is not at a fixed offset.
      const app0 = Buffer.from([0xff, 0xe0, 0, 6, 0x4a, 0x46, 0x49, 0x46]);
      return sized(Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]), 100_000);
    };
    const webpLossy = (width: number, height: number): Buffer => {
      const head = Buffer.alloc(30);
      head.write('RIFF', 0, 'ascii');
      head.write('WEBP', 8, 'ascii');
      head.write('VP8 ', 12, 'ascii');
      head.set([0x9d, 0x01, 0x2a], 23);
      head.writeUInt16LE(width, 26);
      head.writeUInt16LE(height, 28);
      return sized(head, 100_000);
    };
    const webpExtended = (width: number, height: number): Buffer => {
      const head = Buffer.alloc(30);
      head.write('RIFF', 0, 'ascii');
      head.write('WEBP', 8, 'ascii');
      head.write('VP8X', 12, 'ascii');
      head.writeUIntLE(width - 1, 24, 3);
      head.writeUIntLE(height - 1, 27, 3);
      return sized(head, 100_000);
    };

    it.each([
      { name: 'a tall PNG', file: 'long.png', bytes: png(1200, 8001) },
      { name: 'a wide PNG', file: 'wide.png', bytes: png(8001, 1200) },
      { name: 'a tall JPEG', file: 'long.jpg', bytes: jpeg(1200, 12_000) },
      { name: 'a wide lossy WebP', file: 'wide.webp', bytes: webpLossy(9000, 600) },
      { name: 'an extended WebP', file: 'long.webp', bytes: webpExtended(800, 16_000) },
      { name: 'a tall lossless WebP', file: 'long.webp', bytes: webpImage('lossless', 1200, 8001) },
      { name: 'a wide lossless WebP', file: 'wide.webp', bytes: webpImage('lossless', 8001, 1200) },
      // Both 14-bit fields at their largest: a mask or shift off by one would read these wrong.
      {
        name: 'a lossless WebP at 16384 px',
        file: 'max.webp',
        bytes: webpImage('lossless', 16_384, 16_384),
      },
    ])('goes as a path to Read, not an image block: $name', async ({ file, bytes }) => {
      const stored = drop(file, bytes);
      const turn = await nextTurn('The whole page');
      expect(turn.images).toEqual([]);
      expect(turn.message).toContain(`[file] ${stored.storedPath} (${file})`);
      expect(turn.message).toMatch(/too large to show.*Read/);
    });

    // What the API takes up to 8000 px a side goes inline only within 2000 px: see the next describe.
    it('is named as a path while a normal image beside it is still sent inline', async () => {
      drop('long.png', png(1200, 9000));
      drop('small.png', PNG);
      const turn = await nextTurn('Both');
      expect(turn.images).toEqual([{ mediaType: 'image/png', data: PNG.toString('base64') }]);
      expect(turn.message).toMatch(/long\.png\) — too large to show inline; Read it/);
      expect(turn.message).not.toMatch(/small\.png\) — too large/);
    });

    it('is named as a path in a session that has not started, and not sent as an image', async () => {
      drop('long.png', png(1200, 9000));
      f.adapter.shapeBehaviour = () => Promise.resolve({ text: 'ok' });
      f.service.send(shapeId(), 'Look');
      await f.service.settled(shapeId());
      const { spec } = must(f.adapter.shapeSessions[0], 'a session');
      expect(spec.images ?? []).toEqual([]);
      expect(spec.prompt).toMatch(/long\.png\) — too large to show inline; Read it/);
    });
  });

  it('is not marked on a small image beside it, which is still sent inline', async () => {
    drop('big.png', sized(PNG, 6 * MB));
    drop('small.png', PNG);
    const turn = await nextTurn('Both');
    expect(turn.images).toEqual([{ mediaType: 'image/png', data: PNG.toString('base64') }]);
    expect(turn.message.match(/too large to show/g)).toHaveLength(1);
  });

  it('keeps one turn’s inline images under a total, the rest going as paths', async () => {
    for (let i = 0; i < 4; i += 1) drop(`shot${String(i)}.png`, pngOfSize(100, 80, 2 * MB - 200));
    const turn = await nextTurn('Four');
    expect(turn.images).toHaveLength(3);
    expect(turn.message.match(/too large to show/g)).toHaveLength(1);
    expect(turn.message).toMatch(/shot3\.png\) .*too large to show/);
  });

  it('keeps a whole conversation’s inline images under a total, the later ones going as paths', async () => {
    // A resumed session resends every earlier image block, so the sum across turns is what the API sees.
    const sent: number[] = [];
    const marked: number[] = [];
    for (let turnNo = 0; turnNo < 5; turnNo += 1) {
      for (let i = 0; i < 3; i += 1) drop(`t${String(turnNo)}-${String(i)}.png`, wholePng(2 * MB));
      const turn = await nextTurn(`Turn ${String(turnNo)}`);
      sent.push(turn.images.length);
      marked.push(turn.message.match(/too large to show/g)?.length ?? 0);
    }
    expect(sent.reduce((a, b) => a + b, 0) * 2 * MB).toBeLessThanOrEqual(
      INLINE_CONVERSATION_MAX_BYTES,
    );
    // base64 grows 4/3: what a resumed request carries stays well under the API's 32 MB.
    expect((INLINE_CONVERSATION_MAX_BYTES * 4) / 3).toBeLessThan(28_000_000);
    expect(sent).toEqual([3, 3, 3, 0, 0]);
    expect(marked).toEqual([0, 0, 0, 3, 3]);
  });

  it('spends what is left of the conversation total on a smaller image, then stops', async () => {
    for (let turnNo = 0; turnNo < 3; turnNo += 1)
      for (let i = 0; i < 3; i += 1) {
        drop(`a${String(turnNo)}-${String(i)}.png`, wholePng(2 * MB));
        if (i === 2) await nextTurn(`Turn ${String(turnNo)}`);
      }
    // 18 MiB spent: nothing more fits, not even a tiny image.
    drop('tiny.png', PNG);
    const turn = await nextTurn('One more');
    expect(turn.images).toEqual([]);
    expect(turn.message).toMatch(/tiny\.png\) — too large to show inline; Read it/);
  });

  /** Spends the whole conversation total: nine 2 MiB images over three turns, each told. */
  const spendTheTotal = async (): Promise<void> => {
    for (let turnNo = 0; turnNo < 3; turnNo += 1) {
      for (let i = 0; i < 3; i += 1) drop(`a${String(turnNo)}-${String(i)}.png`, wholePng(2 * MB));
      await nextTurn(`Turn ${String(turnNo)}`);
    }
  };

  it('counts what the conversation spent when a session resumes after a restart', async () => {
    await spendTheTotal();
    await f.restart();
    drop('tiny.png', PNG);
    await nextTurn('One more');
    const { spec } = must(f.adapter.shapeSessions[1], 'a resumed session');
    expect(spec.resumeProviderSessionId).not.toBeNull();
    expect(spec.images ?? []).toEqual([]);
    expect(spec.prompt).toMatch(/tiny\.png\) — too large to show inline; Read it/);
  });

  it('sends inline again from zero in a fresh session, which resends no earlier image', async () => {
    await spendTheTotal();
    // Past 70% of the context the session is let go, so the next one starts from the digest.
    f.adapter.shapeBehaviour = () => Promise.resolve({ text: 'ok', contextPercent: 71 });
    f.service.send(shapeId(), 'Full');
    await f.service.settled(shapeId());
    drop('tiny.png', PNG);
    await nextTurn('One more');
    const { spec } = must(f.adapter.shapeSessions[1], 'a fresh session');
    expect(spec.resumeProviderSessionId).toBeNull();
    expect(spec.prompt).toContain('continues in a fresh session');
    expect(spec.images).toEqual([{ mediaType: 'image/png', data: PNG.toString('base64') }]);
    expect(spec.prompt).not.toMatch(/tiny\.png\) — too large/);
  });

  it('does not spend the total on images that went as paths because the message was full', async () => {
    // Ten 1.9 MiB images: three fit a message, seven go as paths and are never resent.
    for (let i = 0; i < 10; i += 1) drop(`shot${String(i)}.png`, wholePng(1.9 * MB));
    const first = await nextTurn('Ten');
    expect(first.images).toHaveLength(3);
    // Only the 5.7 MiB that went inline counts: three more 1.9 MiB images still go inline.
    for (let i = 0; i < 3; i += 1) drop(`next${String(i)}.png`, wholePng(1.9 * MB));
    const second = await nextTurn('Three more');
    expect(second.images).toHaveLength(3);
    expect(second.message).not.toMatch(/too large to show/);
  });

  it('counts only the new session’s inline images after a digest start', async () => {
    await spendTheTotal();
    f.adapter.shapeBehaviour = () => Promise.resolve({ text: 'ok', contextPercent: 71 });
    f.service.send(shapeId(), 'Full');
    await f.service.settled(shapeId());
    // The fresh session's first turn, then a second that is resumed within it.
    drop('first.png', wholePng(2 * MB));
    const first = await nextTurn('First');
    expect(
      must(f.adapter.shapeSessions[1], 'a fresh session').spec.resumeProviderSessionId,
    ).toBeNull();
    expect(first.images).toHaveLength(1);
    for (let i = 0; i < 3; i += 1) drop(`later${String(i)}.png`, wholePng(2 * MB));
    const later = await nextTurn('Later');
    // 2 MiB sent in this session so far: the nine of the old session are not carried.
    expect(later.images).toHaveLength(3);
    expect(later.message).not.toMatch(/too large to show/);
  });

  // see_screen answers a picture in a tool result, which a resumed session resends like any image block.
  describe('beside the pictures see_screen takes', () => {
    const window = { screen: ScreenName.Board, width: 1200, height: 900 } as const;
    const drawn = (bytes: number): ScreenOutcome => {
      const image = pngImage(1200, 900);
      return {
        ok: true,
        image: {
          mediaType: 'image/png',
          data: pngImage(1200, 900, bytes - image.length - 12).toString('base64'),
          width: 1200,
          height: 900,
        },
      };
    };
    const screensOf = (outcome: ScreenOutcome) =>
      createScreens({
        state: f.state,
        filesDir: f.filesDir,
        broker: {
          request: () => Promise.resolve(outcome),
          claim: () => Promise.resolve(null),
          deliver: () => false,
          refuse: () => false,
          tokenValid: () => false,
        },
      });
    const kept = (): string[] => {
      const dir = join(f.filesDir, shapeId(), 'screens');
      return existsSync(dir) ? readdirSync(dir) : [];
    };
    const keptBytes = (): number =>
      kept().reduce(
        (sum, name) => sum + statSync(join(f.filesDir, shapeId(), 'screens', name)).size,
        0,
      );

    it('takes the screens out of what is left for dropped images', async () => {
      await nextTurn('Hello');
      const screens = screensOf(drawn(1_400_000));
      for (let n = 0; n < 12; n += 1) await screens.see(shapeId(), window);
      expect(kept()).toHaveLength(12);
      // 16.8 MB of screens leaves about 2 MB: one more image fits, and a second does not.
      drop('fits.png', wholePng(MB));
      drop('over.png', wholePng(1.5 * MB));
      const turn = await nextTurn('Both');
      expect(turn.images).toHaveLength(1);
      expect(turn.message).toMatch(/over\.png\) — too large to show inline; Read it/);
      expect(turn.message).not.toMatch(/fits\.png\) — too large/);
    });

    it('refuses a screen that would pass the total the dropped images left, saying why', async () => {
      for (let i = 0; i < 3; i += 1) drop(`a${String(i)}.png`, wholePng(2 * MB));
      await nextTurn('One');
      for (let i = 0; i < 3; i += 1) drop(`b${String(i)}.png`, wholePng(2 * MB));
      await nextTurn('Two');
      for (let i = 0; i < 2; i += 1) drop(`c${String(i)}.png`, wholePng(2 * MB));
      await nextTurn('Three');
      // 16 MiB told: a 1.5 MB screen fits once.
      const screens = screensOf(drawn(1_500_000));
      await screens.see(shapeId(), window);
      await expect(screens.see(shapeId(), window)).rejects.toThrow(
        /no room for another picture.*new conversation/,
      );
      expect(kept()).toHaveLength(1);
      expect(
        f.service.view(shapeId()).messages.filter((m) => m.kind === ShapeMessageKind.Screen),
      ).toHaveLength(1);
      expect(
        f.service
          .view(shapeId())
          .messages.some((m) => m.body.startsWith('see_screen · refused · ')),
      ).toBe(true);
    });

    describe('after a digest start, which carries no earlier picture', () => {
      /** Keeps these screens, then moves the conversation on to a session started from the digest. */
      const rollOverWith = async (count: number): Promise<void> => {
        await nextTurn('Hello');
        const screens = screensOf(drawn(1_500_000));
        for (let n = 0; n < count; n += 1) await screens.see(shapeId(), window);
        f.adapter.shapeBehaviour = () => Promise.resolve({ text: 'ok', contextPercent: 71 });
        f.service.send(shapeId(), 'Full');
        await f.service.settled(shapeId());
      };

      it('does not charge a later turn for the screens of the session before', async () => {
        await rollOverWith(8);
        drop('first.png', wholePng(2 * MB));
        const first = await nextTurn('First');
        expect(first.images).toHaveLength(1);
        await f.restart();
        for (let i = 0; i < 3; i += 1) drop(`later${String(i)}.png`, wholePng(2 * MB));
        const later = await nextTurn('Later');
        // About 2 MiB in this session, though the conversation keeps 11.4 MiB of older screens.
        expect(later.images).toHaveLength(3);
        expect(later.message).not.toMatch(/too large to show/);
      });

      it('does not refuse the screen the digest told Claude to take again', async () => {
        await rollOverWith(11);
        drop('first.png', wholePng(2 * MB));
        await nextTurn('First');
        await screensOf(drawn(1_500_000)).see(shapeId(), window);
        expect(kept()).toHaveLength(12);
      });

      it('still charges the screens the new session took', async () => {
        await rollOverWith(6);
        await nextTurn('First');
        const screens = screensOf(drawn(1_500_000));
        for (let n = 0; n < 6; n += 1) await screens.see(shapeId(), window);
        // 8.6 MiB of this session's screens leaves room for four more 2 MiB images, over two turns.
        for (let i = 0; i < 3; i += 1) drop(`a${String(i)}.png`, wholePng(2 * MB));
        expect((await nextTurn('Three')).images).toHaveLength(3);
        for (let i = 0; i < 3; i += 1) drop(`b${String(i)}.png`, wholePng(2 * MB));
        expect((await nextTurn('Three more')).images).toHaveLength(1);
      });
    });

    describe('after a fresh start with no digest, because Claude never spoke text', () => {
      it('does not charge the screens taken before that start, and takes one after it', async () => {
        // The session is let go past 70% of the context before any reply: no text, so no digest row.
        f.adapter.shapeBehaviour = () => Promise.resolve({ text: '', contextPercent: 71 });
        f.service.send(shapeId(), 'Hello');
        await f.service.settled(shapeId());
        const screens = screensOf(drawn(1_500_000));
        for (let n = 0; n < 11; n += 1) await screens.see(shapeId(), window);
        // 15.7 MiB of screens, taken by a session that is gone.
        for (let i = 0; i < 3; i += 1) drop(`new${String(i)}.png`, wholePng(2 * MB));
        const turn = await nextTurn('Again');
        const fresh = must(f.adapter.shapeSessions[1], 'a fresh session');
        expect(fresh.spec.resumeProviderSessionId).toBeNull();
        expect(
          f.service.view(shapeId()).messages.some((m) => m.kind === ShapeMessageKind.Digest),
        ).toBe(false);
        expect(turn.images).toHaveLength(3);
        // This session carries 6 MiB: the old screens would add 15.7 and 1.4 more to pass the 18.
        await screens.see(shapeId(), window);
        expect(kept()).toHaveLength(12);
        expect(inlineBytesSpent(f.state, f.filesDir, shapeId())).toBeLessThanOrEqual(
          INLINE_CONVERSATION_MAX_BYTES,
        );
      });
    });

    it('keeps nine dropped images and twelve asked-for screens under the total', async () => {
      const screens = screensOf(drawn(1_500_000));
      await spendTheTotal();
      for (let n = 0; n < 12; n += 1)
        await expect(screens.see(shapeId(), window)).rejects.toThrow(/no room/);
      drop('late.png', PNG);
      const turn = await nextTurn('More');
      expect(turn.images).toEqual([]);
      const told = f.service.view(shapeId()).files.filter((file) => file.name !== 'late.png');
      const images = told.reduce((sum, file) => sum + file.size, 0);
      expect(images + keptBytes()).toBeLessThanOrEqual(INLINE_CONVERSATION_MAX_BYTES);
    });

    it('keeps twelve screens beside twenty dropped images of any size, across turns and a restart', async () => {
      const sent: Buffer[] = [];
      const turnSent = async (text: string): Promise<FakeShapeTurn> => {
        const turn = await nextTurn(text);
        for (const image of turn.images) sent.push(Buffer.from(image.data, 'base64'));
        return turn;
      };
      for (let round = 0; round < 4; round += 1) {
        for (let i = 0; i < 3; i += 1)
          drop(`r${String(round)}-${String(i)}.png`, pngOfSize(2880, 1800, 1.9 * MB));
        drop(`s${String(round)}.png`, PNG);
        await turnSent(`Round ${String(round)}`);
        if (round === 1) await f.restart();
      }
      drop('small.webp', WEBP);
      drop('more.jpg', JPEG);
      drop('other.png', pngOfSize(120, 80));
      await turnSent('Three more');
      expect(f.service.view(shapeId()).files).toHaveLength(19);

      const screens = screensOf(drawn(1_400_000));
      for (let n = 0; n < 12; n += 1) await screens.see(shapeId(), window);
      expect(kept()).toHaveLength(12);

      // The Retina images went as paths, so they use none of the total: a small image still fits.
      drop('late.png', PNG);
      const turn = await turnSent('The twentieth');
      expect(turn.images).toEqual([{ mediaType: 'image/png', data: PNG.toString('base64') }]);
      expect(turn.message).not.toMatch(/late\.png\) — too large/);
      await turnSent('And still going');

      expect(f.service.view(shapeId()).files).toHaveLength(20);
      expect(sent).toHaveLength(8);
      expect(sent.every((bytes) => (readImageSize(bytes)?.width ?? Infinity) <= 2000)).toBe(true);
      const carried = sent.reduce((sum, bytes) => sum + bytes.length, 0) + keptBytes();
      expect(carried).toBeLessThanOrEqual(INLINE_CONVERSATION_MAX_BYTES);
    });

    it('takes screens in a conversation whose told images all went as paths for their pixels', async () => {
      // Nine long screenshots of about 2 MiB: told, but none sent as a block, so none is carried.
      for (let turnNo = 0; turnNo < 3; turnNo += 1) {
        for (let i = 0; i < 3; i += 1)
          drop(`long${String(turnNo)}-${String(i)}.png`, pngOfSize(1200, 9000, 1.9 * MB));
        const turn = await nextTurn(`Turn ${String(turnNo)}`);
        expect(turn.images).toEqual([]);
      }
      const screens = screensOf(drawn(1_400_000));
      for (let n = 0; n < 12; n += 1) await screens.see(shapeId(), window);
      expect(kept()).toHaveLength(12);
      // A small image still fits beside the twelve screens.
      drop('late.png', PNG);
      const late = await nextTurn('One more');
      expect(late.images).toEqual([{ mediaType: 'image/png', data: PNG.toString('base64') }]);
    });

    it('charges only the images that went as blocks when the message cap left some out', async () => {
      // Twenty images of 1.9 MiB at 1000 px, each within the per-image caps, dropped in one turn: only
      // three fit the 6 MiB message cap, and the other seventeen go as paths and are not carried.
      for (let i = 0; i < 20; i += 1) drop(`m${String(i)}.png`, pngOfSize(1000, 800, 1.9 * MB));
      const turn = await nextTurn('Twenty');
      expect(turn.images).toHaveLength(3);
      expect(turn.message.match(/too large to show/g)).toHaveLength(17);
      const sentBytes = turn.images.reduce((sum, image) => sum + image.data.length * 0.75, 0);
      // 5.7 MiB is carried, so 12.3 MiB remain: nine 1.4 MB (1.34 MiB) screens fit, the tenth does not.
      // Charging all twenty (38 MiB) would have refused the first.
      const screens = screensOf(drawn(1_400_000));
      for (let n = 0; n < 9; n += 1) await screens.see(shapeId(), window);
      await expect(screens.see(shapeId(), window)).rejects.toThrow(/no room for another picture/);
      expect(kept()).toHaveLength(9);
      expect(sentBytes + keptBytes()).toBeLessThanOrEqual(INLINE_CONVERSATION_MAX_BYTES);
    });

    it('does not charge an image whose size cannot be read, which went as a path', async () => {
      const whole = pngOfSize(100, 80, 1.9 * MB);
      for (let i = 0; i < 9; i += 1) drop(`cut${String(i)}.png`, whole.subarray(0, -1));
      await nextTurn('Nine');
      const screens = screensOf(drawn(1_400_000));
      for (let n = 0; n < 12; n += 1) await screens.see(shapeId(), window);
      expect(kept()).toHaveLength(12);
    });
  });

  it('is sent as a path to a session that has not started, and not as an image', async () => {
    drop('big.png', sized(PNG, 8 * MB));
    f.adapter.shapeBehaviour = () => Promise.resolve({ text: 'ok' });
    f.service.send(shapeId(), 'Look');
    await f.service.settled(shapeId());
    const session = must(f.adapter.shapeSessions[0], 'a session');
    expect(session.spec.images ?? []).toEqual([]);
    expect(session.spec.prompt).toMatch(/too large to show.*Read/);
  });
});

// The API takes at most 2000 px a side when a request holds more than 20 images, and a resumed session
// resends every earlier image: a conversation's screens (up to 12) and its dropped images (up to 20) can
// together pass 20. So a dropped image never goes as a block past 2000 px, however few bytes it takes.
describe('a dropped image over 2000 px a side', () => {
  const retina = {
    png: pngOfSize(2880, 1800),
    jpg: jpegOfSize(2880, 1800),
    webp: webpImage('lossy', 2880, 1800),
  };

  it.each(Object.entries(retina))('goes as a path to Read, not a block: %s', async (ext, bytes) => {
    const stored = drop(`retina.${ext}`, bytes);
    const turn = await nextTurn('Look');
    expect(turn.images).toEqual([]);
    expect(turn.message).toContain(`[file] ${stored.storedPath} (retina.${ext}) `);
    expect(turn.message).toMatch(/too large to show.*Read/);
  });

  it('goes as a block at exactly 2000 px, and as a path at 2001, on either side', async () => {
    drop('edge.png', pngOfSize(2000, 2000));
    drop('wide.png', pngOfSize(2001, 100));
    drop('tall.jpg', jpegOfSize(100, 2001));
    const turn = await nextTurn('Edges');
    expect(turn.images).toEqual([
      { mediaType: 'image/png', data: pngOfSize(2000, 2000).toString('base64') },
    ]);
    expect(turn.message.match(/too large to show/g)).toHaveLength(2);
  });

  // A lossless WebP keeps both sizes, less one, in 14 bits each of one word: the likely form of a screenshot.
  it('goes as a block at exactly 2000 px, and as a path at 2001, for a lossless WebP too', async () => {
    drop('edge.webp', webpImage('lossless', 2000, 2000));
    drop('wide.webp', webpImage('lossless', 2001, 100));
    drop('tall.webp', webpImage('lossless', 100, 2001));
    const turn = await nextTurn('Edges');
    expect(turn.images).toEqual([
      { mediaType: 'image/webp', data: webpImage('lossless', 2000, 2000).toString('base64') },
    ]);
    expect(turn.message.match(/too large to show/g)).toHaveLength(2);
    expect(turn.message).toMatch(/wide\.webp\) — too large to show/);
    expect(turn.message).toMatch(/tall\.webp\) — too large to show/);
  });

  it('goes as a path when its size cannot be read, since a model would be sent it blind', async () => {
    drop('cut.png', PNG.subarray(0, PNG.length - 1));
    const turn = await nextTurn('Look');
    expect(turn.images).toEqual([]);
    expect(turn.message).toMatch(/cut\.png\) .*too large to show/);
  });

  it('is sent as a path to a session that has not started', async () => {
    drop('retina.png', retina.png);
    f.adapter.shapeBehaviour = () => Promise.resolve({ text: 'ok' });
    f.service.send(shapeId(), 'Look');
    await f.service.settled(shapeId());
    const session = must(f.adapter.shapeSessions[0], 'a session');
    expect(session.spec.images ?? []).toEqual([]);
    expect(session.spec.prompt).toMatch(/too large to show.*Read/);
  });

  it('keeps twenty dropped images of any size to blocks within 2000 px, across turns and a restart', async () => {
    const sent: Buffer[] = [];
    const lines: string[] = [];
    const turnWith = async (names: string[]): Promise<void> => {
      const turn = await nextTurn('More');
      for (const image of turn.images) sent.push(Buffer.from(image.data, 'base64'));
      lines.push(...turn.message.split('\n').filter((line) => names.some((n) => line.includes(n))));
    };
    for (let round = 0; round < 4; round += 1) {
      const names: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const name = `r${String(round)}-${String(i)}`;
        names.push(name);
        if (i % 2 === 0) drop(`${name}.png`, pngOfSize(2880, 1800, 1_000_000));
        else drop(`${name}.webp`, webpImage('lossless', 1200, 800));
      }
      await turnWith(names);
      if (round === 1) await f.restart();
    }
    expect(f.service.view(shapeId()).files).toHaveLength(20);
    // Eight of the twenty are small enough to be blocks, and twelve Retina ones go as paths.
    expect(sent).toHaveLength(8);
    expect(sent.every((bytes) => (readImageSize(bytes)?.width ?? Infinity) <= 2000)).toBe(true);
    expect(lines.filter((line) => line.includes('too large to show'))).toHaveLength(12);
  });
});

describe('refusals', () => {
  const stored = (): string[] => {
    const dir = join(f.filesDir, shapeId(), 'files');
    return existsSync(dir) ? readdirSync(dir) : [];
  };

  it.each([
    { name: 'a type that is not accepted', file: 'run.sh', bytes: Buffer.from('rm -rf /') },
    { name: 'a GIF', file: 'anim.gif', bytes: Buffer.from('GIF89a') },
    { name: 'an empty file', file: 'empty.md', bytes: Buffer.alloc(0) },
    { name: 'a PNG that is not one', file: 'fake.png', bytes: Buffer.from('not a png') },
    { name: 'a JPEG that is not one', file: 'fake.jpg', bytes: Buffer.from('not a jpeg') },
    { name: 'a WebP that is not one', file: 'fake.webp', bytes: Buffer.from('RIFF....WAVE') },
    { name: 'a PDF that is not one', file: 'fake.pdf', bytes: Buffer.from('hello') },
  ])('refuses $name with the reason, storing nothing', ({ file, bytes }) => {
    expect(() => drop(file, bytes)).toThrow(InvalidError);
    expect(() => drop(file, bytes)).toThrow(new RegExp(file.replace('.', '\\.')));
    expect(f.service.view(shapeId()).files).toEqual([]);
    expect(stored()).toEqual([]);
  });

  it('refuses a file over 20 MB', () => {
    expect(() => drop('big.pdf', Buffer.concat([PDF, Buffer.alloc(20 * 1024 * 1024)]))).toThrow(
      /20 MB/,
    );
  });

  it('refuses the twenty-first file', () => {
    for (let i = 0; i < 20; i += 1) drop(`n${String(i)}.md`, Buffer.from('x'));
    expect(() => drop('one-more.md', Buffer.from('x'))).toThrow(/at most 20 files/);
    expect(f.service.view(shapeId()).files).toHaveLength(20);
  });
});

describe('start_shape', () => {
  const input = (extra: Record<string, unknown> = {}) =>
    StartShapeInput.parse({
      projectId: f.c.project.id,
      title: 'Board polish',
      summary: 'We settled on denser cards and thin scrollbars.',
      ...extra,
    });

  it('creates a conversation whose first message is the summary, authored by the builder', () => {
    const shape = f.service.startFromTerminal(input());
    expect(shape).toMatchObject({
      title: 'Board polish',
      origin: ShapeOrigin.ClaudeCode,
      state: 'listening',
      round: 0,
    });
    const messages = f.service.view(shape.id).messages;
    expect(messages.map((m) => [m.author, m.kind, m.body])).toEqual([
      [ShapeMessageAuthor.Note, ShapeMessageKind.Notice, 'From a Claude Code session'],
      [
        ShapeMessageAuthor.Builder,
        ShapeMessageKind.Text,
        'We settled on denser cards and thin scrollbars.',
      ],
    ]);
  });

  it('starts no Claude turn and lists the conversation at once', () => {
    f.events.length = 0;
    const shape = f.service.startFromTerminal(input());
    expect(f.adapter.shapeSessions).toHaveLength(0);
    expect(f.service.view(shape.id).turn).toEqual({
      running: false,
      queued: 0,
      proposing: false,
      rehearsing: false,
      waitingForUpdate: false,
    });
    expect(f.service.list(f.c.project.id).map((s) => s.id)).toContain(shape.id);
    expect(f.events.some((e) => e.type === EventType.ShapeChanged && e.entityId === shape.id)).toBe(
      true,
    );
  });

  it('keeps each inline file in the conversation’s files directory', () => {
    const shape = f.service.startFromTerminal(
      input({
        files: [
          { name: 'notes.md', content: '# Notes\nDenser cards.' },
          { name: 'list.txt', content: 'one\ntwo' },
        ],
      }),
    );
    const files = f.service.view(shape.id).files;
    expect(files.map((x) => [x.name, x.mediaType])).toEqual([
      ['notes.md', 'text/markdown'],
      ['list.txt', 'text/plain'],
    ]);
    expect(readFileSync(must(files[0], 'a file').storedPath, 'utf8')).toBe(
      '# Notes\nDenser cards.',
    );
    expect(files[0]?.storedPath.startsWith(join(f.filesDir, shape.id, 'files'))).toBe(true);
  });

  it('hands the summary and the file paths to the session with the builder’s first message', async () => {
    const shape = f.service.startFromTerminal(
      input({ files: [{ name: 'notes.md', content: '# Notes' }] }),
    );
    const turn = await nextTurn('Let’s go on', shape.id);
    const summaryId = must(
      f.service.view(shape.id).messages.find((m) => m.body.startsWith('We settled')),
      'the summary',
    ).id;
    expect(turn.message).toContain(`[m:${summaryId}] We settled on denser cards`);
    expect(turn.message).toContain(
      `[file] ${must(f.service.view(shape.id).files[0], 'file').storedPath}`,
    );
    expect(turn.message).toContain('Let’s go on');
  });

  it('refuses a file that is a path or too much text before creating anything', () => {
    expect(
      StartShapeInput.safeParse({
        projectId: f.c.project.id,
        title: 't',
        summary: 's',
        files: [{ name: '/Users/me/.ssh/config', content: 'x' }],
      }).success,
    ).toBe(false);
    expect(f.service.list(f.c.project.id).filter((s) => s.title === 't')).toEqual([]);
  });

  it('counts its files toward the conversation’s 20', () => {
    const shape = f.service.startFromTerminal(
      input({
        files: Array.from({ length: 20 }, (_, i) => ({ name: `f${String(i)}.md`, content: 'x' })),
      }),
    );
    expect(() =>
      f.service.addFile(shape.id, { name: 'more.md', mediaType: '', bytes: Buffer.from('x') }),
    ).toThrow(/at most 20 files/);
  });
});
