#!/usr/bin/env node
// The changed-packages check: format, lint, typecheck, tests and drift of the workspace packages a
// diff touches, with typecheck and tests widened to the packages that depend on them. 10db runs it
// after each implement step in place of `make gate` (the project's changedCheckCommand is
// `make check-changed`); the ship gate still runs the full `make gate` before the push.
//
// The diff is everything since the branch left its base, uncommitted and untracked files included.
// The base is the merge-base with origin/main, else the upstream branch, else main. With no base,
// or with a changed file this script cannot place in a package or a docs-like path (a root config,
// the lockfile, the gate script, CI), it runs the full gate: it never narrows what it cannot place.
//
// --precheck is the pre-check 10db runs in place of the gate when the pull request's base has
// required checks on GitHub (`make precheck`): format and lint of the changed files, typecheck of the
// changed packages and every package depending on one, and drift of the changed packages, with no
// tests, Rust checks or e2e. Where it cannot place a file, or has no base, it runs those four steps over
// every package instead of the gate: it never runs scripts/gate.sh. CI runs every test.
//
// Usage:
//   node scripts/check-changed.mjs                  run the check
//   node scripts/check-changed.mjs --precheck       run the pre-check (no tests, Rust or e2e)
//   node scripts/check-changed.mjs --plan [--precheck] [-- file…]
//                                                    print the plan as JSON and run nothing; the
//                                                    files replace the git diff
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, globSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

/** Paths outside every package whose change cannot break a package: docs and tooling prose. */
const LIGHT_OUTSIDE = [/^docs\//, /^spikes\//, /^\.claude\//, /^\.codex\//, /^[^/]+\.md$/];
/** …and the scripts, except the gate itself, which is what a changed-packages check stands in for. */
const SCRIPT_OUTSIDE = /^scripts\/(?!gate\.sh$)/;
/** The Tauri shell: a change there also runs the Rust checks, as the gate's rust step does. */
const RUST_DIR = 'apps/desktop/src-tauri/';
/**
 * Files inside a package that the repo rule tests (tests/repo) read or run, so a change to one also
 * runs them: every manifest, Markdown file (AGENTS.md, CLAUDE.md, cited decisions), env file and
 * vitest or vite config; the Tauri shell's config and Cargo files; the apps' e2e and scripts folders;
 * and the daemon tests that git-hook-variables.test.ts runs. Keep this in step with tests/repo.
 */
const READ_BY_REPO_TESTS = [
  /(^|\/)package\.json$/,
  /\.md$/,
  /(^|\/)\.env[^/]*$/,
  /(^|\/)(vitest|vite)\.config\.[cm]?[jt]s$/,
  /^apps\/desktop\/src-tauri\//,
  /^apps\/[^/]+\/(e2e|scripts)\//,
  /^apps\/daemon\/(test|src\/git|src\/watcher)\//,
];

/**
 * @typedef {{ name: string, dir: string, deps: string[], scripts: string[] }} Pkg
 * @param {string} dir
 * @returns {Pkg[]}
 */
function workspacePackages(dir) {
  const manifests = globSync(
    ['apps/*/package.json', 'packages/*/package.json', 'tests/*/package.json'],
    {
      cwd: dir,
    },
  ).sort();
  const raw = manifests.map((path) => {
    const json = JSON.parse(readFileSync(join(dir, path), 'utf8'));
    return {
      name: String(json.name),
      dir: path.slice(0, -'/package.json'.length),
      deps: Object.keys({
        ...json.dependencies,
        ...json.devDependencies,
        ...json.optionalDependencies,
      }),
      scripts: Object.keys(json.scripts ?? {}),
    };
  });
  const names = new Set(raw.map((p) => p.name));
  return raw.map((p) => ({ ...p, deps: p.deps.filter((d) => names.has(d)) }));
}

/** @param {Pkg[]} packages @param {Set<string>} start the names to widen to every dependent */
function withDependents(packages, start) {
  const out = new Set(start);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of packages) {
      if (!out.has(p.name) && p.deps.some((d) => out.has(d))) {
        out.add(p.name);
        grew = true;
      }
    }
  }
  return out;
}

/**
 * What to run for these changed files (repo-relative, still present or deleted).
 * @param {string[]} files
 * @param {Pkg[]} packages
 * @param {boolean} [precheck] plan the pre-check: no tests, so no repo rule tests and no Rust
 */
function planFor(files, packages, precheck = false) {
  /** @type {Set<string>} */
  const changed = new Set();
  /** @type {string[]} */
  const outside = [];
  /** @type {string[]} */
  const unplaced = [];
  let rust = false;
  let readByRepoTests = false;
  for (const file of files) {
    const owner = packages.find((p) => file.startsWith(`${p.dir}/`));
    if (owner) {
      changed.add(owner.name);
      if (file.startsWith(RUST_DIR)) rust = true;
      if (READ_BY_REPO_TESTS.some((re) => re.test(file))) readByRepoTests = true;
    } else if (LIGHT_OUTSIDE.some((re) => re.test(file)) || SCRIPT_OUTSIDE.test(file)) {
      outside.push(file);
    } else {
      unplaced.push(file);
    }
  }
  if (unplaced.length > 0) {
    return {
      full: true,
      reason: `not in a package: ${unplaced.join(', ')}`,
      files,
      ...(precheck ? { precheck } : {}),
    };
  }
  // The repo-wide rule tests read docs, scripts, the agent files and some package files, so they
  // run for those.
  const testSeed = new Set(changed);
  const repoChecks = packages.find((p) => p.dir === 'tests/repo');
  if (!precheck && (outside.length > 0 || readByRepoTests) && repoChecks)
    testSeed.add(repoChecks.name);
  const affected = withDependents(packages, new Set([...changed, ...testSeed]));
  const byName = (/** @type {Set<string>} */ set) =>
    packages.filter((p) => set.has(p.name)).map((p) => p.dir);
  return {
    full: false,
    reason: null,
    files,
    changed: byName(changed),
    affected: byName(affected),
    outside,
    rust: rust && !precheck,
    ...(precheck ? { precheck } : {}),
    drift: packages
      .filter((p) => changed.has(p.name) && p.scripts.includes('drift'))
      .map((p) => p.name),
    typecheck: packages
      .filter((p) => affected.has(p.name) && p.scripts.includes('typecheck'))
      .map((p) => p.name),
  };
}

/** @param {string[]} args @param {boolean} [allowFail] */
function git(args, allowFail = false) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (error) {
    if (allowFail) return null;
    throw error;
  }
}

/**
 * The merge-base with the first of origin/main, upstream and main that exists; null when none.
 * origin/main comes first because a pushed branch's upstream is often the branch itself, whose
 * merge-base is the pushed tip, not where the branch left its base.
 */
function baseRef() {
  for (const ref of ['origin/main', '@{upstream}', 'main']) {
    if (git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], true) === null) continue;
    const base = git(['merge-base', 'HEAD', ref], true);
    if (base) return base;
  }
  return null;
}

/** @param {string} base */
function changedFiles(base) {
  const lines = [
    git(['diff', '--name-only', base]),
    git(['ls-files', '--others', '--exclude-standard']),
  ].join('\n');
  return [...new Set(lines.split('\n').filter(Boolean))].sort();
}

/**
 * A step to run: its name, and the command with its arguments.
 * @typedef {{ name: string, command: string, args: string[] }} Step
 * @typedef {{ name: string, ok: boolean, seconds: number, output: string }} StepResult
 */

/**
 * Runs a step with its output held, so steps that run together print one after another.
 * @param {Step} s
 * @returns {Promise<StepResult>}
 */
function run(s) {
  const began = Date.now();
  return new Promise((done) => {
    const child = spawn(s.command, s.args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    const finish = (/** @type {boolean} */ ok) =>
      done({ name: s.name, ok, seconds: Math.round((Date.now() - began) / 1000), output });
    child.on('error', (error) => {
      output += String(error);
      finish(false);
    });
    child.on('close', (code) => {
      finish(code === 0);
    });
  });
}

/** @param {StepResult} r @param {Step} s */
function report(r, s) {
  console.log(`\n▶ ${r.name}: ${[s.command, ...s.args].join(' ')}`);
  process.stdout.write(r.output === '' || r.output.endsWith('\n') ? r.output : `${r.output}\n`);
  console.log(`${r.ok ? '✔' : '✘'} ${r.name} (${String(r.seconds)}s)`);
}

/**
 * Runs the steps together and reports each in order; returns the names of those that failed.
 * @param {Step[]} steps
 */
async function runTogether(steps) {
  const results = await Promise.all(steps.map(run));
  steps.forEach((s, i) => {
    const r = results[i];
    if (r) report(r, s);
  });
  return results.filter((r) => !r.ok).map((r) => r.name);
}

/**
 * The pre-check where the diff cannot be narrowed: format, lint, typecheck and drift over every
 * package, as the gate's steps of those names run them, and never scripts/gate.sh.
 * @param {string} reason
 */
async function runPrecheckEverywhere(reason) {
  console.log(`check-changed: pre-check over every package (${reason})`);
  const began = Date.now();
  const pnpmRun = (/** @type {string} */ name) => ({
    name,
    command: 'pnpm',
    args: ['run', name === 'format' ? 'format:check' : name],
  });
  // Drift regenerates files in the tree, so it runs after the three reads of the tree.
  const failed = await runTogether([pnpmRun('format'), pnpmRun('lint'), pnpmRun('typecheck')]);
  failed.push(...(await runTogether([pnpmRun('drift')])));
  finish(failed, began);
}

/** @param {string[]} failed @param {number} began */
function finish(failed, began) {
  const seconds = Math.round((Date.now() - began) / 1000);
  if (failed.length === 0) {
    console.log(`\nCHECK-CHANGED PASS (${String(seconds)}s)`);
  } else {
    console.log(`\nCHECK-CHANGED FAIL: ${failed.join(' ')} (${String(seconds)}s)`);
    process.exit(1);
  }
}

/** @param {string} reason */
function runFull(reason) {
  console.log(`check-changed: running the full gate (${reason})`);
  const result = spawnSync('bash', [join(root, 'scripts/gate.sh')], {
    cwd: root,
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}

async function main() {
  const argv = process.argv.slice(2);
  const planOnly = argv.includes('--plan');
  const precheck = argv.includes('--precheck');
  const dash = argv.indexOf('--');
  const packages = workspacePackages(root);
  let files;
  if (dash >= 0) {
    files = argv.slice(dash + 1);
  } else {
    const base = baseRef();
    if (base === null) {
      const reason = 'no base branch to diff against';
      if (planOnly) {
        console.log(JSON.stringify({ full: true, reason, ...(precheck ? { precheck } : {}) }));
        return;
      }
      if (precheck) return runPrecheckEverywhere(reason);
      runFull(reason);
    }
    files = changedFiles(base);
  }
  const plan = planFor(files, packages, precheck);
  if (planOnly) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  if (plan.full) {
    if (precheck) return runPrecheckEverywhere(plan.reason);
    runFull(plan.reason);
  }
  const began = Date.now();
  if (files.length === 0) {
    console.log('CHECK-CHANGED PASS nothing changed');
    return;
  }
  console.log(
    `check-changed: changed ${plan.changed.join(', ') || '(no package)'}; checking ${plan.affected.join(', ')}`,
  );
  const present = files.filter((f) => existsSync(join(root, f)));
  const lintable = (/** @type {string} */ f) => /\.(ts|tsx|js|mjs|cjs)$/.test(f);
  // The pre-check lints the changed files only; the changed-packages check lints whole packages.
  const lintTargets = precheck
    ? present.filter(lintable)
    : [...plan.changed, ...plan.outside.filter((f) => lintable(f) && existsSync(join(root, f)))];
  /** @type {Step[]} */
  const together = [];
  if (present.length > 0)
    together.push({
      name: 'format',
      command: 'pnpm',
      args: ['exec', 'prettier', '--check', '--ignore-unknown', ...present],
    });
  if (lintTargets.length > 0)
    together.push({
      name: 'lint',
      command: 'pnpm',
      args: ['exec', 'eslint', '--max-warnings=0', '--no-warn-ignored', ...lintTargets],
    });
  if (plan.typecheck.length > 0)
    together.push({
      name: 'typecheck',
      command: 'pnpm',
      args: ['--parallel', ...plan.typecheck.flatMap((n) => ['--filter', n]), 'run', 'typecheck'],
    });
  // Format, lint and typecheck are independent reads of the tree, so they share the machine.
  const failed = await runTogether(together);
  // The tests run alone: the UI's wait timeouts are tuned for a machine doing nothing else, and
  // lint beside them made them flake. Drift regenerates files in the tree, and the Rust checks build.
  /** @type {Step[]} */
  const alone = [
    ...(precheck
      ? []
      : [
          {
            name: 'test',
            command: 'pnpm',
            args: [
              'exec',
              'vitest',
              'run',
              '--passWithNoTests',
              ...plan.affected.map((d) => `${d}/`),
            ],
          },
        ]),
    ...plan.drift.map((name) => ({
      name: `drift ${name}`,
      command: 'pnpm',
      args: ['--filter', name, 'run', 'drift'],
    })),
  ];
  if (
    plan.rust &&
    !process.env['GATE_SKIP_RUST'] &&
    spawnSync('cargo', ['--version'], { stdio: 'ignore' }).status === 0
  )
    alone.push({ name: 'rust', command: 'make', args: ['-s', 'rust-check'] });
  for (const s of alone) failed.push(...(await runTogether([s])));
  finish(failed, began);
}

if (import.meta.main) await main();
