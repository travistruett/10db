import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';
import { z } from 'zod';
import { createThrowawayRepo, fakeGithubToken, type ThrowawayRepo } from './fixtures';
import { readRepoFile, repoRoot } from './workspace';
import {
  parseWorkflow,
  readWorkflow,
  WorkflowShapeError,
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

function gateContainer(): { image?: string | undefined; options?: string | undefined } {
  const container = readWorkflow(CI).jobs['gate']?.container;
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
  it('has the five required checks as jobs', () => {
    expect(workflowJobNames(CI)).toEqual([
      'gate',
      'desktop',
      'policy',
      'dependency-review',
      'cargo-deny',
    ]);
  });

  it('skips Rust in the Linux gate job, which has no Tauri build libraries', () => {
    expect(readWorkflow(CI).jobs['gate']?.env?.['GATE_SKIP_RUST']).toBe('1');
  });

  it('runs the gate in the Playwright image of the locked Playwright version, pinned by digest', () => {
    // The image ships the browsers of one Playwright version with their system libraries, so the
    // job downloads neither, and its browsers are found only by that same version.
    const version = lockedPlaywrightVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    const tag = `v${version.replaceAll('.', '\\.')}-noble`;
    expect(gateContainer().image).toMatch(
      new RegExp(`^mcr\\.microsoft\\.com/playwright:${tag}@sha256:[0-9a-f]{64}$`),
    );
  });

  it('runs the gate as the runner user, under an init that reaps orphaned processes', () => {
    // uid 1001 owns the checkout, and git refuses a repository another user owns; the tests'
    // isolated git config can't carry a safe.directory exception. The recovery, gate runner and
    // login-env tests wait for a killed grandchild to disappear, and without an init the job
    // container's PID 1 leaves it a zombie.
    expect(gateContainer().options).toBe('--init --user 1001');
  });

  it('bounds every job, so a stalled download fails in minutes instead of holding merges for hours', () => {
    // GitHub's default is 360 minutes.
    const unbounded = Object.entries(readWorkflow(CI).jobs).filter(([, job]) => {
      const minutes = job['timeout-minutes'];
      return minutes === undefined || minutes > 30;
    });
    expect(unbounded.map(([name]) => name)).toEqual([]);
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

  it('installs with a frozen lockfile, then runs the gate, downloading no browser or system package', () => {
    expect(readRepoFile(CI)).toContain(
      '      - run: pnpm install --frozen-lockfile\n      - run: bash scripts/gate.sh\n',
    );
    const runs = (readWorkflow(CI).jobs['gate']?.steps ?? []).map((step) => step.run ?? '');
    expect(runs.filter((run) => /playwright install|\bapt(-get)?\b/.test(run))).toEqual([]);
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
