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
import { createScreens, INLINE_CONVERSATION_MAX_BYTES, type ScreenOutcome } from '../screens';
import type { FakeShapeTurn } from '../sessions';
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
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')]);
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

  it('is not marked on a small image beside it, which is still sent inline', async () => {
    drop('big.png', sized(PNG, 6 * MB));
    drop('small.png', PNG);
    const turn = await nextTurn('Both');
    expect(turn.images).toEqual([{ mediaType: 'image/png', data: PNG.toString('base64') }]);
    expect(turn.message.match(/too large to show/g)).toHaveLength(1);
  });

  it('keeps one turn’s inline images under a total, the rest going as paths', async () => {
    for (let i = 0; i < 4; i += 1) drop(`shot${String(i)}.png`, sized(PNG, 2 * MB));
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
      for (let i = 0; i < 3; i += 1)
        drop(`t${String(turnNo)}-${String(i)}.png`, sized(PNG, 2 * MB));
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
        drop(`a${String(turnNo)}-${String(i)}.png`, sized(PNG, 2 * MB));
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
      for (let i = 0; i < 3; i += 1)
        drop(`a${String(turnNo)}-${String(i)}.png`, sized(PNG, 2 * MB));
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
      drop('fits.png', sized(PNG, MB));
      drop('over.png', sized(PNG, 1.5 * MB));
      const turn = await nextTurn('Both');
      expect(turn.images).toHaveLength(1);
      expect(turn.message).toMatch(/over\.png\) — too large to show inline; Read it/);
      expect(turn.message).not.toMatch(/fits\.png\) — too large/);
    });

    it('refuses a screen that would pass the total the dropped images left, saying why', async () => {
      for (let i = 0; i < 3; i += 1) drop(`a${String(i)}.png`, sized(PNG, 2 * MB));
      await nextTurn('One');
      for (let i = 0; i < 3; i += 1) drop(`b${String(i)}.png`, sized(PNG, 2 * MB));
      await nextTurn('Two');
      for (let i = 0; i < 2; i += 1) drop(`c${String(i)}.png`, sized(PNG, 2 * MB));
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
