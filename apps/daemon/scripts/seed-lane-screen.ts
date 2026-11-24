import { crc32, deflateSync } from 'node:zlib';
import { resolve } from 'node:path';
import { EvidenceKind, ScreenKind, ScreenTheme, WorkstreamId } from '@10db/contracts';
import { createStore, getWorkstream, insertEvidence, openDatabase } from '@10db/db';
import { z } from 'zod';
import { createEventBus, createStateStore } from '../src/events';
import { keepScreen } from '../src/pictures';

/**
 * Seeds one lane screenshot and its browser evidence on a workstream's task, for the end-to-end loop check.
 * A lane writes the same two rows through `browser_screenshot`; the e2e daemon runs no browser, so the rows
 * are written straight into the database of a daemon that runs no browser. Usage: seed-lane-screen.ts <data dir> <json>
 */
const Seed = z.object({
  workstreamId: WorkstreamId,
  url: z.string().min(1),
  title: z.string().min(1),
  note: z.string().min(1),
});

const WIDTH = 480;
const HEIGHT = 360;

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}

/** A small solid PNG (8-bit RGB), enough for a real picture the daemon serves and the drawer decodes. */
function solidPng(): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(WIDTH * 3, 0x80)]);
  const pixels = Buffer.concat(Array.from({ length: HEIGHT }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const [dataDir, json] = process.argv.slice(2);
if (!dataDir || !json) throw new Error('usage: seed-lane-screen.ts <data dir> <json>');
const seed = Seed.parse(JSON.parse(json));
const state = createStateStore(
  createStore(openDatabase(resolve(dataDir, '10db.sqlite'))),
  createEventBus(),
);
const { taskId } = getWorkstream(state.db, seed.workstreamId);
const screen = keepScreen(state, dataDir, {
  taskId,
  turnId: null,
  kind: ScreenKind.Lane,
  route: '/greeting',
  viewport: { width: WIDTH, height: HEIGHT },
  theme: ScreenTheme.Default,
  keptSha: null,
  lane: { url: seed.url, title: seed.title, note: seed.note, sentSessionId: null },
  png: solidPng(),
});
if (screen === null) throw new Error('the lane screen was not kept');
state.write((ctx) =>
  insertEvidence(ctx, {
    workstreamId: seed.workstreamId,
    kind: EvidenceKind.Browser,
    command: null,
    exitCode: null,
    logPath: null,
    commitShas: [],
    screenId: screen.id,
    summary: `Screenshot of ${seed.url} (${seed.title}): ${seed.note}`,
  }),
);
