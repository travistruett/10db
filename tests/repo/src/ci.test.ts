import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';
import { z } from 'zod';
import { createThrowawayRepo, fakeGithubToken, SANDBOXED, type ThrowawayRepo } from './fixtures';
import { COMMENT_MARKER } from './test-report';
import { readRepoFile, repoRoot } from './workspace';
import {
  parseWorkflow,
  readWorkflow,
  WorkflowShapeError,
  workflowCheckNames,
  workflowJobNames,
  workflowPaths,
} from './workflows';

const CI = '.github/workflows/ci.yml';

/** The part of a pnpm-lock.yaml document that says which Playwright the desktop e2e step runs. */
const LockfileDocument = z.object({
  importers: z.record(
    z.string(),
    z.object({
      devDependencies: z.record(z.string(), z.object({ version: z.string() })).optional(),
    }),
  ),
});

/** pnpm writes the lock of pnpm itself and the workspace's lock as two YAML documents in one file. */
function lockedPlaywrightVersion(): string {
  const versions = parseAllDocuments(readRepoFile('pnpm-lock.yaml')).map((document) => {
    const lock = LockfileDocument.parse(document.toJS());
    return lock.importers['apps/desktop']?.devDependencies?.['@playwright/test']?.version;
  });
  return versions.find((version) => version !== undefined) ?? '';
}

/** The jobs that run scripts/gate.sh, and the jobs among them that run in the Playwright image. */
const GATE_JOBS = ['gate-static', 'gate-test', 'gate-e2e'];
const CONTAINER_JOBS = ['gate-test', 'gate-e2e'];
/** The informational jobs that comment on a pull request, which no ruleset may require. */
const REPORT_JOBS = ['test-report', 'test-report-post'];
const Permissions = z.record(z.string(), z.string());
const StepMinutes = z.number().positive();

function containerOf(job: string): { image?: string | undefined; options?: string | undefined } {
  const container = readWorkflow(CI).jobs[job]?.container;
  return typeof container === 'string' ? { image: container } : (container ?? {});
}

// actionlint and zizmor fail when a repository has no workflow, so the throwaway repo needs one.
const PROBE_WORKFLOW = `name: probe
on: workflow_dispatch
permissions: {}
jobs:
  probe:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      - run: echo ok
`;

describe('CI workflow', () => {
  it('has the required checks as jobs, and desktop-scope, which decides desktop', () => {
    expect(workflowJobNames(CI)).toEqual([
      ...GATE_JOBS,
      'desktop-scope',
      'desktop',
      'policy',
      'dependency-review',
      'cargo-deny',
      ...REPORT_JOBS,
    ]);
  });

  it('runs the test report on pull requests only, after a failed shard too, without blocking', () => {
    const { jobs } = readWorkflow(CI);
    expect(jobs['test-report']?.needs).toBe('gate-test');
    expect(jobs['test-report']?.if).toContain("github.event_name == 'pull_request'");
    // It must still report when a shard failed, and a chain of needs skips without !cancelled().
    expect(jobs['test-report']?.if).toContain('!cancelled()');
    expect(jobs['test-report-post']?.if).toContain('!cancelled()');
    expect(jobs['test-report']?.if).toContain("github.event.pull_request.state == 'open'");
    // 10db's checks summary reads every check, so a job must not conclude as failed: a job-level
    // continue-on-error keeps the run green, not necessarily the job's own check.
    // continue-on-error absorbs a step's own timeout, not the job's, so the steps time out first.
    for (const name of REPORT_JOBS) {
      expect(jobs[name]?.['continue-on-error']).toBeUndefined();
      const steps = jobs[name]?.steps ?? [];
      for (const step of steps) expect(step['continue-on-error']).toBe(true);
      const minutes = steps.map((step) => StepMinutes.parse(step['timeout-minutes']));
      const total = minutes.reduce((sum, value) => sum + value, 0);
      expect(total).toBeLessThan(jobs[name]?.['timeout-minutes'] ?? 0);
    }
  });

  it('never gives the write token to a job that runs code from the checkout', () => {
    const { jobs } = readWorkflow(CI);
    const writers = Object.entries(jobs).filter(
      ([, job]) => Permissions.parse(job.permissions ?? {})['pull-requests'] === 'write',
    );
    expect(writers.map(([name]) => name)).toEqual(['test-report-post']);
    const steps = jobs['test-report-post']?.steps ?? [];
    expect(steps.filter((step) => step.uses?.startsWith('actions/checkout'))).toEqual([]);
  });

  it('updates the comment the report starts with, and cannot fail a required shard', () => {
    const { jobs } = readWorkflow(CI);
    const post = jobs['test-report-post']?.steps?.find((step) => step.env?.['MARKER']);
    expect(post?.env?.['MARKER']).toBe(COMMENT_MARKER);
    const upload = jobs['gate-test']?.steps?.find((step) =>
      step.uses?.startsWith('actions/upload-artifact'),
    );
    expect(upload?.['continue-on-error']).toBe(true);
    expect(upload?.['timeout-minutes']).toBeGreaterThan(0);
    const steps = jobs['gate-test']?.steps ?? [];
    const gate = steps.findIndex((step) => step.run === 'bash scripts/gate.sh');
    expect(steps.findIndex((step) => step === upload)).toBeGreaterThan(gate);
    expect(jobs['gate-test']?.env?.['TENDB_TEST_TIMINGS']).toBe(upload?.with?.['path']);
  });

  it('runs every gate step in a required job, so splitting the gate drops none', () => {
    // Format and lint run in policy, and Rust in desktop on macOS: the Linux jobs have no Tauri
    // build libraries. A step added to gate.sh fails here until a job runs it.
    const all = /^ALL_STEPS=\(([^)]*)\)$/m.exec(readRepoFile('scripts/gate.sh'))?.[1]?.split(' ');
    const jobs = readWorkflow(CI).jobs;
    const inGateJobs = GATE_JOBS.flatMap((job) =>
      (jobs[job]?.env?.['GATE_STEPS'] ?? '').split(' ').filter(Boolean),
    );
    const runsIn = (job: string) => (jobs[job]?.steps ?? []).map((step) => step.run ?? '');
    expect(runsIn('policy')).toEqual(
      expect.arrayContaining(['pnpm -s format:check', 'pnpm -s lint']),
    );
    expect(runsIn('desktop')).toContain('make rust-check');
    // A step that may fail without failing its job no longer blocks a merge. Uploading an artifact
    // checks nothing, so it alone may fail: the check before it has already failed the job or not.
    const checks = (job: string) =>
      (jobs[job]?.steps ?? []).filter((step) => !step.uses?.startsWith('actions/upload-artifact'));
    const lenient = [...GATE_JOBS, 'policy', 'desktop'].filter((job) =>
      [jobs[job], ...checks(job)].some((part) => part?.['continue-on-error']),
    );
    expect(lenient).toEqual([]);
    // Format and lint run even after an earlier policy step failed: a fix session reads every
    // failure at once, and a pull request gets two fixes.
    const policySteps = jobs['policy']?.steps ?? [];
    const independent = policySteps.filter((step) => step.if === '${{ !cancelled() }}');
    expect(independent.map((step) => step.run)).toEqual(['pnpm -s format:check', 'pnpm -s lint']);
    expect([...inGateJobs, 'format', 'lint', 'rust'].sort()).toEqual([...(all ?? [])].sort());
  });

  it('splits the tests into shards that together run every file, and reports each failure', () => {
    // Vitest runs shard i of n only when n is the shard count, so a shard left out of the matrix
    // would silently drop its files. fail-fast off keeps one failing shard from cancelling the
    // others, which would hide their failures from a fix session.
    const job = readWorkflow(CI).jobs['gate-test'];
    const shards = job?.strategy?.matrix?.shard ?? [];
    expect(job?.strategy?.['fail-fast']).toBe(false);
    expect(shards).toEqual(shards.map((_, index) => index + 1));
    expect(shards.length).toBeGreaterThan(1);
    expect(job?.env?.['GATE_TEST_ARGS']).toBe(
      '--shard=${{ matrix.shard }}/' + String(shards.length),
    );
    expect(workflowCheckNames(CI).filter((name) => name.startsWith('gate-test'))).toEqual(
      shards.map((shard) => `gate-test-${String(shard)}`),
    );
  });

  it('runs the gate in the Playwright image of the locked Playwright version, pinned by digest', () => {
    // The image ships the browsers of one Playwright version with their system libraries, so the
    // job downloads neither, and its browsers are found only by that same version.
    const version = lockedPlaywrightVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    const tag = `v${version.replaceAll('.', '\\.')}-noble`;
    for (const job of CONTAINER_JOBS) {
      expect(containerOf(job).image).toMatch(
        new RegExp(`^mcr\\.microsoft\\.com/playwright:${tag}@sha256:[0-9a-f]{64}$`),
      );
    }
  });

  it('runs the gate as the runner user, under an init that reaps orphaned processes', () => {
    // uid 1001 owns the checkout, and git refuses a repository another user owns; the tests'
    // isolated git config can't carry a safe.directory exception. The recovery, gate runner and
    // login-env tests wait for a killed grandchild to disappear, and without an init the job
    // container's PID 1 leaves it a zombie.
    for (const job of CONTAINER_JOBS) {
      expect(containerOf(job).options).toBe('--init --user 1001');
    }
  });

  it('bounds every job, so a stalled download fails in minutes instead of holding merges for hours', () => {
    // GitHub's default is 360 minutes.
    const unbounded = Object.entries(readWorkflow(CI).jobs).filter(([, job]) => {
      const minutes = job['timeout-minutes'];
      return minutes === undefined || minutes > 30;
    });
    expect(unbounded.map(([name]) => name)).toEqual([]);
  });

  it('runs on pull requests into main only, and re-runs every job when a PR title is edited', () => {
    // Each task's pull request goes to main and runs CI there, with no integration branch in
    // between (decisions/2026-11-02-merge-queue.md, which decisions/2026-11-02-main-has-no-merge-queue.md
    // amends only by dropping the queue rule).
    const parsed = readWorkflow(CI);
    expect(parsed.on['pull_request']).toEqual({
      branches: ['main'],
      types: ['opened', 'synchronize', 'reopened', 'edited'],
    });
    const skipsOnEvent = Object.entries(parsed.jobs).filter(([, job]) =>
      (job.if ?? '').includes('github.event.action'),
    );
    expect(skipsOnEvent.map(([name]) => name)).toEqual([]);
  });

  it('keeps every pull request event out of the concurrency group of a push to main', () => {
    // An edit to a merged pull request runs with main's ref. Grouped by ref, that run cancels main's
    // own CI, as editing #541's description did.
    expect(readWorkflow(CI).concurrency).toEqual({
      group: 'ci-${{ github.event.pull_request.number || github.ref }}',
      'cancel-in-progress': true,
    });
  });

  it('runs on merge queue entries, where every required check must report', () => {
    // main has no merge queue (decisions/2026-11-02-main-has-no-merge-queue.md), so this trigger is
    // inert until a queue returns. It is kept on purpose: a queue tests each pull request
    // combined with those ahead of it, and waits for the required checks on a
    // gh-readonly-queue/main/... branch, so a check that doesn't run on merge_group never reports
    // and the entry times out.
    const parsed = readWorkflow(CI);
    expect(parsed.on['merge_group']).toEqual({ types: ['checks_requested'] });
    // No job may be limited to other events, except dependency-review (next test). desktop has an
    // `if` too, but on desktop-scope's answer from the files, never on the event.
    const limited = Object.entries(parsed.jobs)
      .filter(([name, job]) => job.if !== undefined && !REPORT_JOBS.includes(name))
      .map(([name]) => name);
    expect(limited).toEqual(['desktop', 'dependency-review']);
  });

  it('skips desktop by the files of the pull request alone, never by the event', () => {
    // A skipped required check counts as passing, so skipping on an `edited` event would replace an
    // earlier red desktop result for the same commit. desktop-scope decides from the pull request's
    // files, so a title edit decides as the last push did (see the note at the top of ci.yml).
    const { jobs } = readWorkflow(CI);
    expect(jobs['desktop']?.needs).toBe('desktop-scope');
    // !cancelled() lets desktop run when desktop-scope failed, where a plain `if` would skip it
    // with its need; only an explicit 'false' skips.
    expect(jobs['desktop']?.if).toBe(
      "${{ !cancelled() && needs.desktop-scope.outputs.desktop != 'false' }}",
    );
    expect(jobs['desktop']?.['runs-on']).toBe('macos-15');
    const scope = jobs['desktop-scope'];
    expect(scope?.['runs-on']).toBe('ubuntu-24.04');
    expect(scope?.if).toBeUndefined();
    expect(JSON.stringify(scope)).not.toContain('github.event.action');
    expect(scope?.outputs).toEqual({ desktop: '${{ steps.scope.outputs.desktop }}' });
    const step = scope?.steps?.find((candidate) => candidate.id === 'scope');
    expect(step?.run).toBe('node scripts/desktop-scope.mjs');
    expect(step?.env).toEqual({
      EVENT_NAME: '${{ github.event_name }}',
      REPOSITORY: '${{ github.repository }}',
      PR_NUMBER: '${{ github.event.pull_request.number }}',
      GH_TOKEN: '${{ github.token }}',
    });
    expect(scope?.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
  });

  it('skips dependency-review off pull_request, which a merge queue would count as passing', () => {
    // Inert while main has no queue (see above). The action diffs a pull request's base and head and
    // has no pull request on a queue entry. A job skipped by its `if` reports as skipped, and a
    // required check that is skipped counts as passing; dependency-review already ran on the pull
    // request itself.
    expect(readWorkflow(CI).jobs['dependency-review']?.if).toBe(
      "github.event_name == 'pull_request'",
    );
  });

  it('has policy diff the queue entry against its base, and lint the PR title only on pull requests', () => {
    const steps = readWorkflow(CI).jobs['policy']?.steps ?? [];
    const policy = steps.find((step) => step.run?.includes('scripts/policy.sh'));
    expect(policy?.env?.['BASE_SHA']).toBe(
      '${{ github.event.merge_group.base_sha || github.event.pull_request.base.sha || github.event.before }}',
    );
    expect(policy?.env?.['HEAD_SHA']).toBe(
      '${{ github.event.merge_group.head_sha || github.event.pull_request.head.sha || github.sha }}',
    );
    const title = steps.find((step) => step.run?.includes('commitlint'));
    expect(title?.if).toBe("github.event_name == 'pull_request'");
  });

  it('does not apply the ruleset from a workflow: make github-settings does, by hand', () => {
    for (const path of workflowPaths()) {
      expect(readRepoFile(path), path).not.toMatch(/github-settings|\/rulesets/);
    }
  });

  it('installs every mise tool the gate tests spawn, so the required test checks can run them', () => {
    // The gate runs the whole tests/repo project: the hook and policy tests call gitleaks,
    // actionlint and zizmor. mise-action creates shims only for installed tools, so a missing one
    // exits 127 on the runner. Rust runs in the desktop job and cargo-deny runs in
    // its own job; every other pinned tool belongs here.
    const notNeeded = new Set(['rust', 'cargo-deny']);
    const pinned = [...readRepoFile('mise.toml').matchAll(/^([\w-]+) = /gm)]
      .map((match) => match[1] ?? '')
      .filter((name) => !['min_version', 'lockfile'].includes(name) && !notNeeded.has(name));
    const miseStep = readWorkflow(CI).jobs['gate-test']?.steps?.find((step) =>
      step.uses?.startsWith('jdx/mise-action@'),
    );
    const installArgs = miseStep?.with?.['install_args'];
    const installed = typeof installArgs === 'string' ? installArgs.split(/\s+/) : [];
    expect(installed.sort()).toEqual(pinned.sort());
  });

  it('installs with a frozen lockfile, then runs the gate, downloading no browser or system package', () => {
    for (const job of GATE_JOBS) {
      const runs = (readWorkflow(CI).jobs[job]?.steps ?? []).map((step) => step.run ?? '');
      const install = runs.indexOf('pnpm install --frozen-lockfile');
      expect(install).toBeGreaterThanOrEqual(0);
      expect(runs[install + 1]).toBe('bash scripts/gate.sh');
      expect(runs.filter((run) => /playwright install|\bapt(-get)?\b/.test(run))).toEqual([]);
    }
  });
});

describe('parseWorkflow', () => {
  const workflow = (job: string) =>
    `on:\n  push: {}\npermissions: {}\njobs:\n  gate:\n    runs-on: ubuntu-24.04\n${job}`;

  it.each([
    {
      name: 'a container mapping without an image',
      job: '    container:\n      options: --init\n',
      path: 'jobs.gate.container',
    },
    {
      name: 'a container image that is not a string',
      job: '    container:\n      image: 3\n',
      path: 'jobs.gate.container',
    },
    {
      name: 'a container given as a list',
      job: '    container: [mcr.microsoft.com/playwright, --init]\n',
      path: 'jobs.gate.container',
    },
    {
      name: 'a timeout that is not a number',
      job: '    timeout-minutes: soon\n',
      path: 'jobs.gate.timeout-minutes',
    },
    {
      name: 'steps that are not a list',
      job: '    steps: run\n',
      path: 'jobs.gate.steps',
    },
  ])('reports $name as a shape error at $path', ({ job, path }) => {
    const parse = () => parseWorkflow(workflow(job), 'probe.yml');
    expect(parse).toThrow(WorkflowShapeError);
    // One issue, at that path: the rest of the probe is well formed.
    expect(parse).toThrow(new RegExp(`^probe\\.yml: ${path.replaceAll('.', '\\.')}: [^;]+$`));
  });

  it('reads both container forms and keeps the keys it does not model', () => {
    const image = parseWorkflow(workflow('    container: node:26\n'), 'probe.yml');
    expect(image.jobs['gate']?.container).toBe('node:26');
    const mapping = parseWorkflow(
      workflow(
        '    timeout-minutes: 5\n    strategy:\n      matrix:\n        token: [x]\n    container:\n      image: node:26\n      options: --init\n      credentials:\n        password: ${{ secrets.P }}\n',
      ),
      'probe.yml',
    );
    const gate = mapping.jobs['gate'];
    expect(gate?.container).toEqual({
      image: 'node:26',
      options: '--init',
      credentials: { password: '${{ secrets.P }}' },
    });
    expect(gate?.['timeout-minutes']).toBe(5);
    // The secrets check reads the whole job as JSON, so an unmodeled key must survive the parse.
    expect(JSON.stringify(gate)).toContain('"strategy"');
  });
});

describe('workflowPaths', () => {
  it('finds both .yml and .yaml workflows, which GitHub runs alike', () => {
    const root = mkdtempSync(join(tmpdir(), '10db-workflows-'));
    try {
      mkdirSync(join(root, '.github/workflows'), { recursive: true });
      for (const name of ['a.yml', 'b.yaml', 'c.txt'])
        writeFileSync(join(root, '.github/workflows', name), '');
      expect(workflowPaths(root)).toEqual(['.github/workflows/a.yml', '.github/workflows/b.yaml']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.each(workflowPaths())('%s is hardened', (path) => {
  const text = readRepoFile(path);
  const parsed = readWorkflow(path);
  const jobs = Object.entries(parsed.jobs);

  it('pins every action to a full commit SHA with a version comment', () => {
    const uses = text.split('\n').filter((line) => /^\s*(- )?uses:/.test(line));
    expect(uses.length).toBeGreaterThan(0);
    expect(
      uses.filter((line) => !/uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/.test(line)),
    ).toEqual([]);
  });

  it('grants nothing at the top level and declares permissions on every job', () => {
    expect(parsed.permissions).toEqual({});
    expect(jobs.filter(([, job]) => job.permissions === undefined).map(([name]) => name)).toEqual(
      [],
    );
  });

  it('never persists checkout credentials', () => {
    const checkouts = jobs
      .flatMap(([, job]) => job.steps ?? [])
      .filter((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkouts.filter((s) => s.with?.['persist-credentials'] !== false)).toEqual([]);
  });

  it('has no pull_request_target trigger and no paths filters', () => {
    expect(Object.keys(parsed.on)).not.toContain('pull_request_target');
    expect(text).not.toMatch(/^\s+paths(-ignore)?:/m);
  });

  it('reads secrets only in jobs bound to an environment', () => {
    const leaky = jobs.filter(
      ([, job]) => /\bsecrets\b/.test(JSON.stringify(job)) && job.environment === undefined,
    );
    expect(leaky.map(([name]) => name)).toEqual([]);
  });
});

describe('scripts/policy.sh', () => {
  let repo: ThrowawayRepo;
  let base: string;
  const policy = (...args: string[]) =>
    spawnSync('/bin/bash', [resolve(repoRoot, 'scripts/policy.sh'), ...args], {
      cwd: repo.dir,
      encoding: 'utf8',
      env: repo.env,
    });

  beforeEach(() => {
    repo = createThrowawayRepo('10db-policy');
    repo.stage('README.md', '# probe\n');
    repo.stage('.github/workflows/probe.yml', PROBE_WORKFLOW);
    repo.commit('chore(repo): init');
    base = repo.gitOutput('rev-parse', 'HEAD');
  });

  afterEach(() => {
    repo.remove();
  });

  // gitleaks can't scan in a sandbox where git is Apple's shim; see SANDBOXED.
  it.skipIf(SANDBOXED)(
    'fails on a secret committed inside the range, with gitleaks reporting it',
    () => {
      const { token, body } = fakeGithubToken();
      repo.stage('config.ts', `export const token = '${token}';\n`);
      repo.commit('feat(repo): add config');
      const result = policy(base, repo.gitOutput('rev-parse', 'HEAD'));
      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).not.toBe(0);
      // gitleaks' own finding text, so a missing gitleaks (a non-zero exit too) can't pass this.
      expect(output).toContain('leaks found: 1');
      expect(output).not.toContain(body);
    },
  );

  it('passes a clean range through gitleaks, hygiene and the workflow linters', () => {
    repo.stage('notes.md', 'nothing secret here\n');
    repo.commit('docs(repo): add notes');
    const result = policy(base, repo.gitOutput('rev-parse', 'HEAD'));
    expect(`${result.stdout}${result.stderr}`).toContain('no leaks found');
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n').at(-1)).toBe('POLICY PASS');
  });

  it('ignores files the base branch deleted after the branch point', () => {
    // A pull request is checked out as the merge of its head into the base. A file that the base
    // deleted since the branch point is absent from that checkout, and a two-dot diff would still
    // list it as added by the head.
    repo.git('checkout', '-q', '-b', 'main');
    repo.git('rm', '-q', 'README.md');
    repo.commit('chore(repo): drop the readme');
    const movedBase = repo.gitOutput('rev-parse', 'HEAD');
    repo.git('checkout', '-q', 'feat/x');
    repo.stage('notes.md', 'nothing secret here\n');
    repo.commit('docs(repo): add notes');
    const head = repo.gitOutput('rev-parse', 'HEAD');
    repo.git('checkout', '-q', 'main');
    repo.git('merge', '-q', '--no-ff', '-m', 'chore(repo): merge', 'feat/x');
    const result = policy(movedBase, head);
    expect(`${result.stdout}${result.stderr}`).not.toContain('README.md');
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n').at(-1)).toBe('POLICY PASS');
  });

  it('fails instead of scanning nothing when the base commit is missing', () => {
    const result = policy('f'.repeat(40), base);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('unknown base commit');
  });
});
