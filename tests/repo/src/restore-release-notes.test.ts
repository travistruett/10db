import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runWithFakeGh, type GhReply } from './fake-gh';
import { repoRoot } from './workspace';

const script = join(repoRoot, 'scripts/release/restore-release-notes.mjs');
const repository = 'owner/repo';
const branch = 'release-please--branches--main--components--10db--release-notes';
const overflowBody = `This release is too large to preview in the pull request body. View the full release notes here: https://github.com/${repository}/blob/${branch}/release-notes.md`;
const contentsPath = `api repos/${repository}/contents/release-notes.md`;

const pullRequests = (
  state: 'open' | 'merged',
  bodies: readonly string[],
  label = 'autorelease: pending',
): GhReply => ({
  args: `pr list --repo ${repository} --state ${state}`,
  stdout: JSON.stringify(
    bodies.map((body, index) => ({ number: index + 85, body, labels: [{ name: label }] })),
  ),
});
const noneMerged = pullRequests('merged', []);
const noneOpen = pullRequests('open', []);
const notesFile = (notes: string): GhReply => ({ args: `${contentsPath}?ref=`, stdout: notes });
const noNotesFile: GhReply = {
  args: `${contentsPath}?ref=`,
  stderr: 'gh: Not Found (HTTP 404)',
  status: 1,
};
const written: GhReply = { args: `api -X PUT repos/${repository}/contents`, stdout: '{}' };
const realNotes = '---\n\n## [0.2.0]\n\n* a feature\n\n---\n';

const writes = (result: ReturnType<typeof runWithFakeGh>) =>
  result.calls.filter((call) => call.args.includes('PUT'));

function restoredPlaceholder() {
  const result = runWithFakeGh(
    script,
    [noneMerged, pullRequests('open', [overflowBody]), noNotesFile, written],
    { REPOSITORY: repository },
  );
  const request = z
    .object({ message: z.string(), content: z.string(), branch: z.string() })
    .parse(JSON.parse(writes(result)[0]?.stdin ?? '{}'));
  return { result, request, text: Buffer.from(request.content, 'base64').toString('utf8') };
}

describe('restore-release-notes.mjs', () => {
  const noWrite = [
    { name: 'no release PR is open', replies: [noneMerged, noneOpen] },
    {
      name: 'the release PR holds its own notes',
      replies: [noneMerged, pullRequests('open', ['---\n\n## notes\n\n---'])],
    },
    {
      name: 'the notes file is where the PR says',
      replies: [noneMerged, pullRequests('open', [overflowBody]), notesFile(realNotes)],
    },
    {
      name: 'a commit subject in the notes merely mentions a release-notes.md',
      replies: [
        noneMerged,
        pullRequests('open', ['---\n\n* see https://x.test/blob/main/release-notes.md\n\n---']),
        noNotesFile,
      ],
    },
  ];

  it.each(noWrite)('writes nothing when $name', ({ replies }) => {
    const result = runWithFakeGh(script, replies, { REPOSITORY: repository });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(writes(result)).toEqual([]);
  });

  it('writes notes release-please can parse to the branch the PR links, when the file is gone', () => {
    const { result, request, text } = restoredPlaceholder();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(request.branch).toBe(branch);
    // release-please splits a body on lines that are exactly `---`, and skips a PR with none.
    expect(text.split('\n').filter((line) => line === '---')).toHaveLength(2);
    expect(result.stdout).toContain(branch);
  });

  it.each([
    { name: 'its notes are lost', file: noNotesFile },
    { name: 'its notes are still the placeholder', file: notesFile(restoredPlaceholder().text) },
  ])('stops the run, so no empty release goes out, when a merged PR has $name', ({ file }) => {
    const result = runWithFakeGh(script, [pullRequests('merged', [overflowBody]), file, written], {
      REPOSITORY: repository,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('#85');
    expect(result.stderr).toContain(branch);
    expect(writes(result)).toEqual([]);
  });

  it('lets a merged PR already released through, without reading its notes', () => {
    const result = runWithFakeGh(
      script,
      [pullRequests('merged', [overflowBody], 'autorelease: tagged'), noNotesFile, noneOpen],
      { REPOSITORY: repository },
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('lists PRs without --label, which gh answers from a search index that lags a merge', () => {
    const result = runWithFakeGh(script, [noneMerged, noneOpen], { REPOSITORY: repository });
    expect(
      result.calls.map((call) => call.args).filter((args) => args.includes('--label')),
    ).toEqual([]);
  });

  it('still finds the link when something added a line to the PR body', () => {
    const edited = `${overflowBody}\n\nA note someone added.`;
    const result = runWithFakeGh(
      script,
      [noneMerged, pullRequests('open', [edited]), noNotesFile, written],
      { REPOSITORY: repository },
    );
    expect(result.stderr).toBe('');
    expect(writes(result)).toHaveLength(1);
  });

  it('lets real notes through when a commit subject quotes the placeholder', () => {
    const quoting = `${realNotes}\n* These notes are rebuilt by the next release-please run.\n`;
    const result = runWithFakeGh(
      script,
      [pullRequests('merged', [overflowBody]), notesFile(quoting), noneOpen],
      { REPOSITORY: repository },
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('lets a merged PR with its real notes through', () => {
    const result = runWithFakeGh(
      script,
      [pullRequests('merged', [overflowBody]), notesFile(realNotes), noneOpen],
      { REPOSITORY: repository },
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('fails without writing when GitHub answers something other than not found', () => {
    const result = runWithFakeGh(
      script,
      [
        noneMerged,
        pullRequests('open', [overflowBody]),
        { ...noNotesFile, stderr: 'gh: Bad Gateway (HTTP 502)' },
        written,
      ],
      { REPOSITORY: repository },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('HTTP 502');
    expect(writes(result)).toEqual([]);
  });

  it('fails when the write is refused', () => {
    const result = runWithFakeGh(
      script,
      [
        noneMerged,
        pullRequests('open', [overflowBody]),
        noNotesFile,
        { ...written, stderr: 'gh: Forbidden (HTTP 403)', status: 1 },
      ],
      { REPOSITORY: repository },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('HTTP 403');
  });

  it('refuses a missing repository name', () => {
    const result = runWithFakeGh(script, [], {});
    expect(result.status).toBe(2);
    expect(result.calls).toEqual([]);
  });
});
