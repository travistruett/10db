import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EventType,
  InvalidError,
  ShapeMessageAuthor,
  ShapeMessageKind,
  ShapeOrigin,
  StartShapeInput,
  type ShapeFileDto,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    for (let i = 0; i < 4; i += 1) drop(`shot${String(i)}.png`, pngOfSize(100, 80, 2 * MB - 200));
    const turn = await nextTurn('Four');
    expect(turn.images).toHaveLength(3);
    expect(turn.message.match(/too large to show/g)).toHaveLength(1);
    expect(turn.message).toMatch(/shot3\.png\) .*too large to show/);
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
