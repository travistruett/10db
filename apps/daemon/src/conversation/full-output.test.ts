import { statSync } from 'node:fs';
import {
  ConversationId,
  ConversationItemId,
  mintId,
  ToolCallView,
  type ToolCallHunk,
} from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import {
  BODY_CAP_CHARS,
  capItemBody,
  fullOutputDir,
  readFullOutput,
  writeFullOutput,
} from './full-output';

// Sessions spec §5.2, §6.2: what a view's tail, an edit's hunk cap or the 32 KB body cap cut off is
// kept on disk under a path made of ids only.

const NOW = '2026-11-13T10:00:00.000Z';
const hunk = (n: number, size: number): ToolCallHunk => ({
  oldStart: n * 100 + 1,
  oldLines: 1,
  newStart: n * 100 + 1,
  newLines: 1,
  before: 'a'.repeat(size),
  after: 'b'.repeat(size),
});
const edit = (hunks: ToolCallHunk[]): ToolCallView => ({
  kind: 'edit',
  id: 'toolu_1',
  harnessTool: 'Edit',
  status: 'done',
  title: 'a.ts',
  startedAt: NOW,
  durationMs: 5,
  parentId: null,
  refusal: null,
  deniedBy: null,
  limit: null,
  soft: null,
  path: 'a.ts',
  change: 'update',
  movePath: null,
  hunks,
  addedLines: hunks.length,
  removedLines: hunks.length,
  truncated: false,
});

describe('capItemBody', () => {
  it('keeps a body whose JSON is at most the cap as it is', () => {
    const text = 'x'.repeat(BODY_CAP_CHARS - JSON.stringify({ text: '' }).length);
    expect(JSON.stringify({ text }).length).toBe(BODY_CAP_CHARS);
    expect(capItemBody('agent_message', { text })).toEqual({ body: { text }, full: null });
  });

  it('keeps the first 30,000 characters of a longer text, and the whole of it as full text', () => {
    const text = 'y'.repeat(40_000);
    expect(capItemBody('agent_message', { text })).toEqual({
      body: { text: 'y'.repeat(30_000) },
      full: { text },
    });
  });

  it('keeps the hunks of an edit that fit under the cap, marked truncated, and its patch whole', () => {
    const hunks = Array.from({ length: 10 }, (_, n) => hunk(n, 5_000));
    const capped = capItemBody('tool_call', edit(hunks));
    expect(JSON.stringify(capped.body).length).toBeLessThanOrEqual(BODY_CAP_CHARS);
    expect(capped.body).toMatchObject({ truncated: true, addedLines: 10, removedLines: 10 });
    const view = ToolCallView.parse(capped.body);
    const kept = view.kind === 'edit' ? view.hunks : [];
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(10);
    expect(capped.full?.patch?.split('\n').filter((l) => l.startsWith('+'))).toHaveLength(10);
  });
});

describe('the files on disk', () => {
  it('writes the output, the patch and the text, mode 600, and reads them back', () => {
    const dir = tempDir('full-output');
    try {
      const conversationId = mintId('Conversation');
      const itemId = mintId('ConversationItem');
      expect(
        writeFullOutput(dir.path, conversationId, itemId, {
          output: 'all of it',
          patch: '@@ -1 +1 @@\n-a\n+b\n',
          text: 'long text',
        }),
      ).toBe(true);
      expect(readFullOutput(dir.path, conversationId, itemId)).toEqual({
        output: 'all of it',
        patch: '@@ -1 +1 @@\n-a\n+b\n',
        text: 'long text',
      });
      const folder = fullOutputDir(dir.path, conversationId, itemId);
      expect(folder).toBe(`${dir.path}/conversations/${conversationId}/items/${itemId}`);
      expect(statSync(`${folder}/output.txt`).mode & 0o777).toBe(0o600);
      expect(writeFullOutput(dir.path, conversationId, mintId('ConversationItem'), {})).toBe(false);
    } finally {
      dir.cleanup();
    }
  });

  it('reads a missing folder as nulls', () => {
    const dir = tempDir('full-output');
    try {
      expect(readFullOutput(dir.path, mintId('Conversation'), mintId('ConversationItem'))).toEqual({
        output: null,
        patch: null,
        text: null,
      });
    } finally {
      dir.cleanup();
    }
  });

  it.each(['cnv_../x', 'cnv_a/b', '..'])('has no id schema that takes %s', (raw) => {
    expect(ConversationId.safeParse(raw).success).toBe(false);
    expect(ConversationItemId.safeParse(raw.replace('cnv', 'cvi')).success).toBe(false);
  });
});
