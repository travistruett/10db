#!/usr/bin/env node
// Guards a release PR's notes file against a failed run of release-please losing it.
// Past GitHub's body limit the notes live in release-notes.md on their own branch. release-please
// resets that branch to main and writes the file in a second call, and every run reads the file
// before it reaches that write, so one failed write stops every later run.
// For an open release PR, a missing file gets a placeholder: the run gets past the read, rebuilds
// the notes from the commits and replaces the file.
// For a merged release PR the file is the release's only source of notes, so a missing file or a
// placeholder stops the run here: the notes can't be rebuilt, and a release would go out empty.
// Usage: REPOSITORY=<owner>/<repo> GH_TOKEN=<token> node scripts/release/restore-release-notes.mjs
// Exit 0: the notes are in place. Exit 1: GitHub failed, or a merged PR lost its notes.
// Exit 2: bad environment.
import { spawnSync } from 'node:child_process';

const NOTES_FILE = 'release-notes.md';
const OVERFLOW_LINK =
  /^This release is too large to preview in the pull request body\. View the full release notes here: \S*\/blob\/(.+)\/release-notes\.md$/m;
const PENDING_LABEL = 'autorelease: pending';
// Room for 200 pull request bodies at GitHub's limit, escaped into JSON.
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
// release-please skips a release PR whose notes have no `---` lines around their content.
const PLACEHOLDER = `---

These notes are rebuilt by the next release-please run.

---
`;

const repository = process.env.REPOSITORY ?? '';
if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
  process.stderr.write(`REPOSITORY must be <owner>/<repo>, got "${repository}"\n`);
  process.exit(2);
}
const contents = `repos/${repository}/contents/${NOTES_FILE}`;

function gh(args, input) {
  const result = spawnSync('gh', args, { encoding: 'utf8', input, maxBuffer: MAX_RESPONSE_BYTES });
  const stderr = result.error === undefined ? (result.stderr ?? '') : String(result.error);
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr };
}

function fail(what, detail = '') {
  process.stderr.write(`${what}${detail === '' ? '' : `: ${detail}`}\n`);
  process.exit(1);
}

/** The release PRs in a state that keep their notes in the file, with the branch that holds it. */
function overflowingPullRequests(state) {
  // Filtered here: gh answers --label from the search index, which lags a merge, and this runs
  // within seconds of the merge while release-please reads the pull requests themselves.
  const listed = gh([
    'pr',
    'list',
    '--repo',
    repository,
    '--state',
    state,
    '--limit',
    '200',
    '--json',
    'number,body,labels',
  ]);
  if (!listed.ok) fail(`listing the ${state} release PRs failed`, listed.stderr);
  return JSON.parse(listed.stdout)
    .filter(({ labels }) => labels.some(({ name }) => name === PENDING_LABEL))
    .flatMap(({ number, body }) => {
      const branch = OVERFLOW_LINK.exec(body)?.[1];
      return branch === undefined ? [] : [{ number, branch }];
    });
}

/** The notes on a branch, or undefined when the file isn't there. */
function readNotes(branch) {
  const path = `${contents}?ref=${encodeURIComponent(branch)}`;
  const found = gh(['api', path, '-H', 'Accept: application/vnd.github.raw']);
  if (found.ok) return found.stdout;
  if (found.stderr.includes('HTTP 404')) return undefined;
  return fail(`reading ${NOTES_FILE} failed`, found.stderr);
}

for (const { number, branch } of overflowingPullRequests('merged')) {
  const notes = readNotes(branch);
  if (notes === undefined || notes.trim() === PLACEHOLDER.trim()) {
    fail(
      `release PR #${String(number)} merged without its notes, so its release would be empty: ` +
        `put the notes in ${NOTES_FILE} on ${branch}, then rerun this workflow`,
    );
  }
}

for (const { branch } of overflowingPullRequests('open')) {
  if (readNotes(branch) !== undefined) continue;
  const request = {
    message: 'chore(repo): restore the release notes a failed run lost',
    content: Buffer.from(PLACEHOLDER).toString('base64'),
    branch,
  };
  const written = gh(['api', '-X', 'PUT', contents, '--input', '-'], JSON.stringify(request));
  if (!written.ok) fail(`restoring ${NOTES_FILE} failed`, written.stderr);
  process.stdout.write(`restored ${NOTES_FILE} on ${branch}\n`);
}
