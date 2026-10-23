import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createThrowawayRepo, fakeGithubToken, type ThrowawayRepo } from './fixtures';
import { readRepoFile, repoRoot } from './workspace';
import { readWorkflow, workflowJobNames, workflowPaths } from './workflows';

const CI = '.github/workflows/ci.yml';

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
  it('has the five required checks as jobs', () => {
    expect(workflowJobNames(CI)).toEqual([
      'gate',
      'desktop',
      'policy',
      'dependency-review',
      'cargo-deny',
    ]);
  });

  it('skips Rust in the Ubuntu gate job, where the runner has cargo but no Tauri libraries', () => {
    expect(readWorkflow(CI).jobs['gate']?.env?.['GATE_SKIP_RUST']).toBe('1');
  });

  it('re-runs every job when a PR title is edited, so policy lints the title that gets merged', () => {
    const parsed = readWorkflow(CI);
    expect(parsed.on['pull_request']).toEqual({
      types: ['opened', 'synchronize', 'reopened', 'edited'],
    });
    const skipsOnEvent = Object.entries(parsed.jobs).filter(([, job]) =>
      (job.if ?? '').includes('github.event.action'),
    );
    expect(skipsOnEvent.map(([name]) => name)).toEqual([]);
  });

  it('installs every mise tool the gate tests spawn, so the required gate check can run them', () => {
    // The gate runs the whole tests/repo project: the hook and policy tests call gitleaks,
    // actionlint and zizmor. mise-action creates shims only for installed tools, so a missing one
    // exits 127 on the runner. Rust is skipped in this job (GATE_SKIP_RUST) and cargo-deny runs in
    // its own job; every other pinned tool belongs here.
    const notNeeded = new Set(['rust', 'cargo-deny']);
    const pinned = [...readRepoFile('mise.toml').matchAll(/^([\w-]+) = /gm)]
      .map((match) => match[1] ?? '')
      .filter((name) => !['min_version', 'lockfile'].includes(name) && !notNeeded.has(name));
    const miseStep = readWorkflow(CI).jobs['gate']?.steps?.find((step) =>
      step.uses?.startsWith('jdx/mise-action@'),
    );
    const installArgs = miseStep?.with?.['install_args'];
    const installed = typeof installArgs === 'string' ? installArgs.split(/\s+/) : [];
    expect(installed.sort()).toEqual(pinned.sort());
  });

  it('installs with a frozen lockfile, then WebKit for the e2e step, then runs the gate', () => {
    const text = readRepoFile(CI);
    expect(text).toContain(
      '      - run: pnpm install --frozen-lockfile\n      - run: pnpm --filter @10db/desktop exec playwright install --with-deps webkit\n      - run: bash scripts/gate.sh\n',
    );
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

  it('fails on a secret committed inside the range, with gitleaks reporting it', () => {
    const { token, body } = fakeGithubToken();
    repo.stage('config.ts', `export const token = '${token}';\n`);
    repo.commit('feat(repo): add config');
    const result = policy(base, repo.gitOutput('rev-parse', 'HEAD'));
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    // gitleaks' own finding text, so a missing gitleaks (a non-zero exit too) can't pass this.
    expect(output).toContain('leaks found: 1');
    expect(output).not.toContain(body);
  });

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
