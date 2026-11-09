import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AccountKind, mintId, type TaskFileId } from '@10db/contracts';
import type { TaskFileRow } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pngOfSize } from '../../test/png';
import { tempDir, type TempDir } from '../../test/fixtures';
import { pictureLimitsFor } from '../screens';
import { blockPictures, threadInlineBytes } from './thread-pictures';

// Workbench spec §6.3: a picture reaches a lane session as an image block when it fits the account's
// limits and what the thread's budget has left, counted as Plan counts a conversation's; otherwise as
// the path the session reads.

const MIB = 1024 * 1024;
const CLAUDE = pictureLimitsFor(AccountKind.ClaudeSubscription);
const BEDROCK = pictureLimitsFor(AccountKind.Bedrock);

let dir: TempDir;
beforeEach(() => {
  dir = tempDir('thread-pictures');
});
afterEach(() => {
  dir.cleanup();
});

/** A picture kept on disk at this size in bytes and pixels, as its row says. */
function picture(
  name: string,
  bytes: number,
  side = 800,
  inlineSent = false,
): TaskFileRow & { readonly id: TaskFileId } {
  const png = pngOfSize(side, side, Math.max(0, bytes - pngOfSize(side, side).length - 12));
  const storedPath = join(dir.path, name);
  writeFileSync(storedPath, png);
  return {
    id: mintId('TaskFile'),
    taskId: mintId('Task'),
    messageId: mintId('TaskMessage'),
    name,
    mediaType: 'image/png',
    size: png.length,
    sha256: 'a'.repeat(64),
    storedPath,
    inlineSent,
    createdAt: new Date(0).toISOString(),
  };
}

describe('blockPictures', () => {
  it.each<[string, () => TaskFileRow, number, typeof CLAUDE, boolean]>([
    [
      'a small picture with room left goes as a block',
      () => picture('a.png', MIB),
      0,
      CLAUDE,
      true,
    ],
    [
      'a picture wider than a block may be goes as its path',
      () => picture('wide.png', MIB, 3001),
      0,
      CLAUDE,
      false,
    ],
    [
      "a picture past what the thread's budget has left goes as its path",
      () => picture('late.png', MIB),
      CLAUDE.inlineMaxBytes - MIB + 1,
      CLAUDE,
      false,
    ],
    [
      'a picture that just fits what the budget has left goes as a block',
      () => picture('last.png', MIB),
      CLAUDE.inlineMaxBytes - 2 * MIB,
      CLAUDE,
      true,
    ],
    [
      "a picture over Bedrock's per-picture cap goes as its path there",
      () => picture('big.png', 4 * MIB),
      0,
      BEDROCK,
      false,
    ],
    [
      "the same picture goes as a block on the Claude API's larger cap",
      () => picture('big.png', 4 * MIB),
      0,
      CLAUDE,
      true,
    ],
  ])('%s', (_name, make, spent, limits, block) => {
    const file = make();
    expect(blockPictures([file], spent, limits).has(file.id)).toBe(block);
  });

  it("keeps a message's blocks within what one message may carry, the rest going as paths", () => {
    const files = [1, 2, 3, 4].map((n) => picture(`p${String(n)}.png`, 5 * MIB));
    const blocks = blockPictures(files, 0, CLAUDE);
    expect(files.map((f) => blocks.has(f.id))).toEqual([true, true, true, false]);
  });
});

describe('threadInlineBytes', () => {
  it('counts the pictures the live session holds as blocks, and no other', () => {
    const files = [
      picture('sent.png', MIB, 800, true),
      picture('path.png', MIB, 800, false),
      picture('wide.png', MIB, 3001, true),
    ];
    expect(threadInlineBytes(files, CLAUDE)).toBe(files[0]?.size);
  });
});
