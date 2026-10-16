#!/usr/bin/env node
// Applies .github/repo-settings.json and every .github/rulesets/*.json to this checkout's GitHub
// repository through the gh CLI: main-protection, main-review, tags-create and tags-immutable.
// Rulesets go first (tags-immutable before tags-create), then the repository settings. A failed
// call doesn't stop the rest: the script finishes, lists every failure and exits non-zero.
// Idempotent: rulesets are matched by name and replaced, and each setting is a PUT or PATCH of the
// whole value, so a second run changes nothing. Run it by hand (`make github-settings`) with admin
// rights; CI never runs it.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

/** @param {string} path */
const readJson = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));

/**
 * Calls `gh api` and returns the parsed response, or null when the body is empty.
 * @param {'GET' | 'POST' | 'PUT' | 'PATCH'} method
 * @param {string} path
 * @param {unknown} [body]
 */
function api(method, path, body) {
  const args = ['api', '--method', method, path];
  if (body !== undefined) args.push('--input', '-');
  const out = execFileSync('gh', args, {
    input: body === undefined ? '' : JSON.stringify(body),
    encoding: 'utf8',
  });
  return out.trim() === '' ? null : JSON.parse(out);
}

/** Rulesets apply in this order; any other ruleset follows, in file name order. */
const RULESET_ORDER = ['main-protection', 'main-review', 'tags-immutable', 'tags-create'];
const rank = (/** @type {string} */ name) => {
  const index = RULESET_ORDER.indexOf(name);
  return index === -1 ? RULESET_ORDER.length : index;
};

/** @type {string[]} */
const failures = [];

/**
 * Runs one step; a thrown error is recorded and the script moves on.
 * @param {string} label
 * @param {() => void} step
 */
function attempt(label, step) {
  try {
    step();
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
    failures.push(`${label}: ${reason}`);
  }
}

const repo = execFileSync(
  'gh',
  ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
  {
    encoding: 'utf8',
  },
).trim();
const settings = readJson('.github/repo-settings.json');

/** @type {{ id: number, name: string }[] | undefined} */
let live;
attempt('list rulesets', () => {
  live = api('GET', `repos/${repo}/rulesets`) ?? [];
});
const rulesets = readdirSync(join(root, '.github/rulesets'))
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((file) => readJson(`.github/rulesets/${file}`))
  .sort((a, b) => rank(a.name) - rank(b.name));
for (const ruleset of rulesets) {
  // Without the live list a ruleset can't be matched by name, and creating it could duplicate one.
  if (live === undefined) {
    failures.push(`ruleset "${ruleset.name}": skipped, the live rulesets are unknown`);
    continue;
  }
  const id = live.find((r) => r.name === ruleset.name)?.id;
  attempt(`ruleset "${ruleset.name}"`, () => {
    if (id === undefined) api('POST', `repos/${repo}/rulesets`, ruleset);
    else api('PUT', `repos/${repo}/rulesets/${String(id)}`, ruleset);
    console.log(`${repo}: ruleset "${ruleset.name}" ${id === undefined ? 'created' : 'updated'}`);
  });
}

attempt('repository settings', () => {
  api('PATCH', `repos/${repo}`, settings.repository);
});
if (settings.vulnerabilityAlerts)
  attempt('vulnerability alerts', () => {
    api('PUT', `repos/${repo}/vulnerability-alerts`);
  });
if (settings.privateVulnerabilityReporting)
  attempt('private vulnerability reporting', () => {
    api('PUT', `repos/${repo}/private-vulnerability-reporting`);
  });
attempt('workflow permissions', () => {
  api('PUT', `repos/${repo}/actions/permissions/workflow`, settings.workflowPermissions);
});
attempt('fork pull request approval', () => {
  api(
    'PUT',
    `repos/${repo}/actions/permissions/fork-pr-contributor-approval`,
    settings.forkPullRequestApproval,
  );
});

if (failures.length > 0) {
  console.error(`${repo}: ${String(failures.length)} step(s) failed:`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`${repo}: rulesets, repository, security and Actions settings applied`);
}
