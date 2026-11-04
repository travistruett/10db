#!/usr/bin/env node
// Keeps one GitHub issue open while the latest run of any workflow on main has failed, and closes
// it once they pass. A failed workflow on main blocks no pull request, so nothing else raises it.
// A workflow that never runs on main, such as the tag-triggered release, is not watched: a person
// approves each release and sees its run.
// Usage: REPOSITORY=<owner>/<repo> GH_TOKEN=<token> node scripts/report-main-failures.mjs
// Exit 0: the issue matches main. Exit 1: GitHub failed. Exit 2: bad environment.
import { spawnSync } from 'node:child_process';

const ISSUE_TITLE = 'Workflows are failing on main';
const PASSED = 'success';
const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);
// Wide enough for main's cancelled CI runs: a run's conclusion decides only when it is one of the
// above, and pushes close together cancel each other in long streaks.
const RUNS_PER_WORKFLOW = 100;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

const repository = process.env.REPOSITORY ?? '';
if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
  process.stderr.write(`REPOSITORY must be <owner>/<repo>, got "${repository}"\n`);
  process.exit(2);
}

function gh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: MAX_RESPONSE_BYTES });
  if (result.status !== 0) {
    process.stderr.write(`gh ${args[0]} failed: ${result.stderr ?? String(result.error)}\n`);
    process.exit(1);
  }
  return result.stdout;
}

/** What's wrong with a workflow on main, or undefined when nothing is. */
function failureOf(workflow) {
  const query = `branch=main&status=completed&per_page=${String(RUNS_PER_WORKFLOW)}`;
  const { workflow_runs: runs } = JSON.parse(
    gh(['api', `repos/${repository}/actions/workflows/${String(workflow.id)}/runs?${query}`]),
  );
  // `branch=main` also matches pull requests from a fork's main.
  const ownRuns = runs.filter(
    (run) => run.event !== 'pull_request' && run.head_repository?.full_name === repository,
  );
  const [newest] = ownRuns;
  if (newest === undefined) return undefined;
  const latest = ownRuns.find((run) => run.conclusion === PASSED || FAILED.has(run.conclusion));
  if (latest === undefined) {
    const line = `- [${workflow.name}](${newest.html_url}): no recent run finished`;
    return { name: workflow.name, line };
  }
  if (latest.conclusion === PASSED) return undefined;
  return { name: workflow.name, line: `- [${workflow.name}](${latest.html_url})` };
}

const { workflows } = JSON.parse(gh(['api', `repos/${repository}/actions/workflows?per_page=100`]));
const failures = workflows
  .filter((workflow) => workflow.state === 'active' && workflow.path.startsWith('.github/'))
  .flatMap((workflow) => failureOf(workflow) ?? []);

const issues = JSON.parse(
  gh([
    'issue',
    'list',
    '--repo',
    repository,
    '--state',
    'open',
    '--limit',
    '200',
    '--json',
    'number,title,body',
  ]),
);
const issue = issues.find((candidate) => candidate.title === ISSUE_TITLE);

if (failures.length === 0) {
  if (issue !== undefined) {
    const comment = 'Every workflow on main passes.';
    gh(['issue', 'close', String(issue.number), '--repo', repository, '--comment', comment]);
  }
  process.exit(0);
}

const body = `The latest run of these workflows on main failed:

${failures.map(({ line }) => line).join('\n')}

This issue is rewritten hourly and closes by itself when they pass.
`;
if (issue === undefined) {
  gh(['issue', 'create', '--repo', repository, '--title', ISSUE_TITLE, '--body', body]);
} else if (issue.body.trim() !== body.trim()) {
  const number = String(issue.number);
  // Editing an issue notifies nobody. The comment goes first: the body is what says a workflow was
  // already announced, so a failed comment is sent again by the next run.
  const added = failures.filter(({ name }) => !issue.body.includes(`[${name}](`));
  if (added.length > 0) {
    const comment = `Also failing now: ${added.map(({ name }) => name).join(', ')}.`;
    gh(['issue', 'comment', number, '--repo', repository, '--body', comment]);
  }
  gh(['issue', 'edit', number, '--repo', repository, '--body', body]);
}
