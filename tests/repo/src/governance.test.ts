import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  globSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { readManifest, readRepoFile, repoRoot } from './workspace';
import { workflowJobNames } from './workflows';

interface Rule {
  type: string;
  parameters?: Record<string, unknown>;
}
interface Ruleset {
  name: string;
  target: 'branch' | 'tag';
  enforcement: string;
  conditions: { ref_name: { include: string[] } };
  bypass_actors: { actor_id: number | null; actor_type: string; bypass_mode: string }[];
  rules: Rule[];
}

const rulesets = globSync('.github/rulesets/*.json', { cwd: repoRoot })
  .sort()
  .map((path) => JSON.parse(readRepoFile(path)) as Ruleset);
const byTarget = (target: Ruleset['target']) => rulesets.filter((r) => r.target === target);
const byName = (name: string) => rulesets.find((r) => r.name === name);
const rule = (ruleset: Ruleset | undefined, type: string) =>
  ruleset?.rules.find((r) => r.type === type);

describe('rulesets', () => {
  it('has two main rulesets and two release-tag rulesets, all active', () => {
    expect(byTarget('branch').map((r) => r.name)).toEqual(['main-protection', 'main-review']);
    expect(byTarget('branch').map((r) => r.conditions.ref_name.include)).toEqual([
      ['~DEFAULT_BRANCH'],
      ['~DEFAULT_BRANCH'],
    ]);
    expect(byTarget('tag').map((r) => r.name)).toEqual(['tags-create', 'tags-immutable']);
    expect(byTarget('tag').map((r) => r.conditions.ref_name.include)).toEqual([
      ['refs/tags/v*'],
      ['refs/tags/v*'],
    ]);
    expect(rulesets.filter((r) => r.enforcement !== 'active').map((r) => r.name)).toEqual([
      'main-review',
    ]);
  });

  it('protects main with no bypass: PRs, squash, linear, no force push', () => {
    const main = byName('main-protection');
    expect(main?.bypass_actors).toEqual([]);
    expect(main?.rules.map((r) => r.type).sort()).toEqual([
      'deletion',
      'non_fast_forward',
      'pull_request',
      'required_linear_history',
      'required_status_checks',
    ]);
    expect(rule(main, 'pull_request')?.parameters).toEqual({
      allowed_merge_methods: ['squash'],
      dismiss_stale_reviews_on_push: false,
      require_code_owner_review: false,
      require_last_push_approval: false,
      required_approving_review_count: 0,
      required_review_thread_resolution: true,
    });
  });

  it('requires exactly the CI jobs that ci.yml defines', () => {
    const main = byName('main-protection');
    const checks = (rule(main, 'required_status_checks')?.parameters?.['required_status_checks'] ??
      []) as {
      context: string;
      integration_id?: number;
    }[];
    expect(checks.map((c) => c.context)).toEqual(workflowJobNames('.github/workflows/ci.yml'));
  });

  it('accepts each required check only from GitHub Actions, never a posted commit status', () => {
    const main = byName('main-protection');
    const checks = (rule(main, 'required_status_checks')?.parameters?.['required_status_checks'] ??
      []) as { integration_id?: number }[];
    expect(checks.length).toBe(5);
    expect(checks.every((c) => c.integration_id === 15368)).toBe(true);
  });

  it('keeps the code-owner review in main-review, switched off while the maintainer is the only writer', () => {
    const review = byName('main-review');
    expect(review?.enforcement).toBe('disabled');
    expect(review?.bypass_actors).toEqual([
      { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'pull_request' },
    ]);
    expect(review?.rules.map((r) => r.type)).toEqual(['pull_request']);
    expect(rule(review, 'pull_request')?.parameters).toEqual({
      allowed_merge_methods: ['squash'],
      dismiss_stale_reviews_on_push: true,
      require_code_owner_review: true,
      require_last_push_approval: false,
      required_approving_review_count: 1,
      required_review_thread_resolution: false,
    });
  });

  it('makes v* tags immutable for everyone, the release bot included', () => {
    const immutable = byName('tags-immutable');
    expect(immutable?.bypass_actors).toEqual([]);
    expect(immutable?.rules.map((r) => r.type).sort()).toEqual(['deletion', 'update']);
  });

  it('restricts v* tag creation; only the release bot may ever bypass it', () => {
    const create = byName('tags-create');
    expect(create?.rules.map((r) => r.type)).toEqual(['creation']);
    // No App exists before the repository is published, so the list starts empty and nobody can
    // create a v* tag. Publishing adds exactly one actor: the release bot, as an Integration.
    const actors = create?.bypass_actors ?? [];
    expect(actors.length).toBeLessThanOrEqual(1);
    expect(
      actors.filter((a) => a.actor_type !== 'Integration' || a.bypass_mode !== 'always'),
    ).toEqual([]);
  });
});

describe('repository settings', () => {
  const settings = JSON.parse(readRepoFile('.github/repo-settings.json')) as {
    repository: Record<string, unknown>;
    vulnerabilityAlerts: boolean;
    privateVulnerabilityReporting: boolean;
    workflowPermissions: Record<string, unknown>;
    forkPullRequestApproval: { approval_policy: string };
    environments: Record<string, unknown>;
  };

  it('allows squash merges only, titled by the PR, and deletes merged branches', () => {
    expect(settings.repository).toMatchObject({
      allow_squash_merge: true,
      allow_merge_commit: false,
      allow_rebase_merge: false,
      squash_merge_commit_title: 'PR_TITLE',
      delete_branch_on_merge: true,
    });
  });

  it('lets a merge be queued to land once its required checks pass', () => {
    expect(settings.repository['allow_auto_merge']).toBe(true);
  });

  it('turns on secret scanning, push protection, private reporting and Dependabot alerts', () => {
    expect(settings.repository['security_and_analysis']).toEqual({
      secret_scanning: { status: 'enabled' },
      secret_scanning_push_protection: { status: 'enabled' },
    });
    expect(settings.privateVulnerabilityReporting).toBe(true);
    expect(settings.vulnerabilityAlerts).toBe(true);
  });

  it('defaults workflow tokens to read-only and holds first-time contributors for approval', () => {
    expect(settings.workflowPermissions).toEqual({
      default_workflow_permissions: 'read',
      can_approve_pull_request_reviews: false,
    });
    expect(settings.forkPullRequestApproval.approval_policy).toBe('first_time_contributors');
  });

  it('holds every release run for the builder, from v* tags only, and the bot to main', () => {
    expect(settings.environments).toEqual({
      'release-bot': { reviewers: [], deploymentPolicies: [{ name: 'main', type: 'branch' }] },
      release: { reviewers: ['travistruett'], deploymentPolicies: [{ name: 'v*', type: 'tag' }] },
    });
  });
});

describe('scripts/github-settings.mjs against a fake gh', () => {
  let dir: string;
  const calls = () =>
    readFileSync(join(dir, 'calls.log'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split(' ').slice(0, 4).join(' '));

  /** The ruleset names the script sent, in order. */
  const sentRulesets = () =>
    readFileSync(join(dir, 'calls.log'), 'utf8')
      .trim()
      .split('\n')
      .filter((line) => /^api --method (POST|PUT) repos\/owner\/10db\/rulesets/.test(line))
      .map((line) => (JSON.parse(line.slice(line.indexOf('{'))) as { name: string }).name);

  /** The body the script sent with the first call to `method path`. */
  const sentBody = (method: string, path: string): unknown => {
    const line = readFileSync(join(dir, 'calls.log'), 'utf8')
      .split('\n')
      .find((l) => l.startsWith(`api --method ${method} ${path} `));
    return line === undefined ? undefined : JSON.parse(line.slice(line.indexOf('{')));
  };

  /**
   * Runs the script with a `gh` on PATH that logs each call; the live repo has `existing` rulesets
   * and, per environment, the deployment policies in `policies`. Every user's id is 42.
   * A call whose arguments or body contain `failOn` fails with exit code 1.
   */
  function runWith(
    existing: { id: number; name: string }[],
    failOn = '',
    policies: Record<string, { id: number; name: string; type: string }[]> = {},
  ) {
    writeFileSync(
      join(dir, 'gh'),
      [
        '#!/usr/bin/env node',
        "const { appendFileSync, readFileSync } = require('node:fs');",
        'const args = process.argv.slice(2);',
        "const body = args.includes('--input') ? readFileSync(0, 'utf8') : '';",
        `appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, args.join(' ') + ' ' + body + '\\n');`,
        `if (${JSON.stringify(failOn)} && (args.join(' ') + body).includes(${JSON.stringify(failOn)})) {`,
        "  console.error('gh: simulated failure');",
        '  process.exit(1);',
        '}',
        "if (args[0] === 'repo') console.log('owner/10db');",
        "else if (args[2] === 'GET' && args[3].startsWith('users/')) console.log('{\"id\":42}');",
        "else if (args[2] === 'GET' && args[3].endsWith('/deployment-branch-policies')) {",
        `  const live = ${JSON.stringify(policies)}[args[3].split('/')[4]] ?? [];`,
        '  console.log(JSON.stringify({ branch_policies: live }));',
        '}',
        `else if (args[2] === 'GET') console.log(${JSON.stringify(JSON.stringify(existing))});`,
      ].join('\n'),
    );
    chmodSync(join(dir, 'gh'), 0o755);
    return spawnSync(process.execPath, [resolve(repoRoot, 'scripts/github-settings.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env['PATH'] ?? ''}` },
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), '10db-fake-gh-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates missing rulesets first, then applies every setting', () => {
    expect(runWith([]).status).toBe(0);
    expect(calls()).toEqual([
      'repo view --json nameWithOwner',
      'api --method GET repos/owner/10db/rulesets',
      'api --method POST repos/owner/10db/rulesets',
      'api --method POST repos/owner/10db/rulesets',
      'api --method POST repos/owner/10db/rulesets',
      'api --method POST repos/owner/10db/rulesets',
      'api --method PATCH repos/owner/10db',
      'api --method PUT repos/owner/10db/vulnerability-alerts',
      'api --method PUT repos/owner/10db/private-vulnerability-reporting',
      'api --method PUT repos/owner/10db/actions/permissions/workflow',
      'api --method PUT repos/owner/10db/actions/permissions/fork-pr-contributor-approval',
      'api --method PUT repos/owner/10db/environments/release-bot',
      'api --method GET repos/owner/10db/environments/release-bot/deployment-branch-policies',
      'api --method POST repos/owner/10db/environments/release-bot/deployment-branch-policies',
      'api --method GET users/travistruett',
      'api --method PUT repos/owner/10db/environments/release',
      'api --method GET repos/owner/10db/environments/release/deployment-branch-policies',
      'api --method POST repos/owner/10db/environments/release/deployment-branch-policies',
    ]);
  });

  it('makes the builder the release reviewer and lets each environment deploy only from its refs', () => {
    expect(runWith([]).status).toBe(0);
    expect(sentBody('PUT', 'repos/owner/10db/environments/release')).toEqual({
      prevent_self_review: false,
      reviewers: [{ type: 'User', id: 42 }],
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    });
    expect(sentBody('PUT', 'repos/owner/10db/environments/release-bot')).toMatchObject({
      reviewers: null,
    });
    expect(
      sentBody('POST', 'repos/owner/10db/environments/release/deployment-branch-policies'),
    ).toEqual({ name: 'v*', type: 'tag' });
  });

  it('keeps a live deployment policy the file lists and deletes the rest', () => {
    const live = {
      release: [
        { id: 5, name: 'v*', type: 'tag' },
        { id: 6, name: 'main', type: 'branch' },
      ],
    };
    expect(runWith([], '', live).status).toBe(0);
    expect(calls().filter((call) => call.includes('environments/release/deployment'))).toEqual([
      'api --method GET repos/owner/10db/environments/release/deployment-branch-policies',
      'api --method DELETE repos/owner/10db/environments/release/deployment-branch-policies/6',
    ]);
  });

  it('applies tags-immutable before tags-create', () => {
    runWith([]);
    expect(sentRulesets()).toEqual([
      'main-protection',
      'main-review',
      'tags-immutable',
      'tags-create',
    ]);
  });

  it('keeps going after a failed call, then exits non-zero and lists the failures', () => {
    const result = runWith([], '"name":"tags-immutable"');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('tags-immutable');
    // The ruleset after the failure and every repository setting still ran.
    expect(sentRulesets()).toEqual([
      'main-protection',
      'main-review',
      'tags-immutable',
      'tags-create',
    ]);
    expect(calls()).toContain('api --method PATCH repos/owner/10db');
    expect(calls()).toContain(
      'api --method PUT repos/owner/10db/actions/permissions/fork-pr-contributor-approval',
    );
  });

  it('replaces rulesets that already exist, matched by name, so reruns are idempotent', () => {
    expect(
      runWith([
        { id: 7, name: 'main-protection' },
        { id: 8, name: 'main-review' },
        { id: 9, name: 'tags-create' },
        { id: 10, name: 'tags-immutable' },
      ]).status,
    ).toBe(0);
    expect(calls().filter((call) => call.includes('/rulesets/'))).toEqual([
      'api --method PUT repos/owner/10db/rulesets/7',
      'api --method PUT repos/owner/10db/rulesets/8',
      'api --method PUT repos/owner/10db/rulesets/10',
      'api --method PUT repos/owner/10db/rulesets/9',
    ]);
  });
});

describe('release-please', () => {
  const config = JSON.parse(readRepoFile('release-please-config.json')) as {
    packages: Record<string, Record<string, unknown>>;
  };
  const options = config.packages['.'] ?? {};
  const manifest = JSON.parse(readRepoFile('.release-please-manifest.json')) as Record<
    string,
    string
  >;

  it('tags plain vX.Y.Z, starts at 0.1.0 and creates the tag with the draft release', () => {
    expect(options).toMatchObject({
      'release-type': 'node',
      'include-component-in-tag': false,
      'include-v-in-tag': true,
      'initial-version': '0.1.0',
      'bump-minor-pre-major': true,
      draft: true,
      'force-tag-creation': true,
    });
  });

  it('titles its Release PR as a valid Conventional Commit', () => {
    const title = String(options['pull-request-title-pattern']).replace('${version}', '0.1.0');
    const result = spawnSync(resolve(repoRoot, 'node_modules/.bin/commitlint'), [], {
      cwd: repoRoot,
      input: title,
      encoding: 'utf8',
    });
    expect(result.status, result.stdout).toBe(0);
  });

  it('keeps every version file at the manifest version', () => {
    const version = manifest['.'];
    expect(readManifest('package.json').version).toBe(version);
    expect(
      (JSON.parse(readRepoFile('apps/desktop/src-tauri/tauri.conf.json')) as { version: string })
        .version,
    ).toBe(version);
    expect(readRepoFile('apps/desktop/src-tauri/Cargo.toml')).toMatch(
      new RegExp(`^version = "${String(version)}"$`, 'm'),
    );
  });

  it('points every extra file at a file that exists', () => {
    const extra = options['extra-files'] as { path: string }[];
    expect(extra.filter((f) => !existsSync(resolve(repoRoot, f.path))).map((f) => f.path)).toEqual(
      [],
    );
  });
});

describe('community files', () => {
  it.each([
    'SECURITY.md',
    'CONTRIBUTING.md',
    'CODE_OF_CONDUCT.md',
    'CHANGELOG.md',
    '.github/CODEOWNERS',
    '.github/pull_request_template.md',
    '.github/ISSUE_TEMPLATE/bug.yml',
    '.github/ISSUE_TEMPLATE/feature.yml',
    '.github/ISSUE_TEMPLATE/config.yml',
    'renovate.json',
  ])('%s exists', (path) => {
    expect(existsSync(resolve(repoRoot, path))).toBe(true);
  });

  it('fills in the Code of Conduct contact', () => {
    expect(readRepoFile('CODE_OF_CONDUCT.md')).not.toContain('[INSERT');
  });

  it('assigns every path to the maintainer, and names the CI, hook and agent files last', () => {
    const lines = readRepoFile('.github/CODEOWNERS')
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('#'));
    expect(lines).toEqual([
      '* @travistruett',
      '/.github/ @travistruett',
      '/lefthook.yml @travistruett',
      '/commitlint.config.* @travistruett',
      '/mise.toml @travistruett',
      '/mise.lock @travistruett',
      '/.claude/ @travistruett',
      '/.codex/ @travistruett',
    ]);
  });

  it('turns off blank issues and sends security reports to private reporting', () => {
    const config = parse(readRepoFile('.github/ISSUE_TEMPLATE/config.yml')) as {
      blank_issues_enabled: boolean;
      contact_links: { url: string }[];
    };
    expect(config.blank_issues_enabled).toBe(false);
    expect(config.contact_links.some((l) => l.url.endsWith('/security/advisories/new'))).toBe(true);
  });

  it('documents the scopes commitlint enforces', async () => {
    const { default: commitlint } = (await import(resolve(repoRoot, 'commitlint.config.js'))) as {
      default: { rules: Record<string, [number, string, string[]]> };
    };
    const scopes = commitlint.rules['scope-enum']?.[2] ?? [];
    const contributing = readRepoFile('CONTRIBUTING.md');
    expect(scopes.filter((scope) => !contributing.includes(`\`${scope}\``))).toEqual([]);
  });

  it('maps every commitlint scope but deps to paths that exist, for the titles 10db writes', async () => {
    const { default: commitlint } = (await import(resolve(repoRoot, 'commitlint.config.js'))) as {
      default: { rules: Record<string, [number, string, string[]]> };
    };
    const allowed = commitlint.rules['scope-enum']?.[2] ?? [];
    const { scopes } = JSON.parse(readRepoFile('.10db/pr-scopes.json')) as {
      scopes: Record<string, string[]>;
    };
    expect(Object.keys(scopes).sort()).toEqual(allowed.filter((s) => s !== 'deps').sort());
    expect(
      Object.values(scopes)
        .flat()
        .filter((path) => !existsSync(resolve(repoRoot, path))),
    ).toEqual([]);
  });

  it('opens Renovate PRs as chore(deps) commits and waits three days after each release', () => {
    const renovate = JSON.parse(readRepoFile('renovate.json')) as Record<string, unknown>;
    expect(renovate['extends']).toEqual(
      expect.arrayContaining([':semanticCommitTypeAll(chore)', ':semanticCommitScope(deps)']),
    );
    expect(renovate['minimumReleaseAge']).toBe('3 days');
  });

  it('batches Renovate into one weekly window, majors on approval, security fixes at once', () => {
    interface Rule {
      matchUpdateTypes?: string[];
      groupName?: string;
      dependencyDashboardApproval?: boolean;
    }
    const renovate = JSON.parse(readRepoFile('renovate.json')) as {
      timezone: string;
      schedule: string[];
      lockFileMaintenance: { schedule: string[] };
      vulnerabilityAlerts?: { schedule?: string[] };
      packageRules: Rule[];
    };
    expect(renovate.timezone).toBe('America/Los_Angeles');
    expect(renovate.schedule).toEqual(['before 6am on monday']);
    expect(renovate.lockFileMaintenance.schedule).toEqual([
      'before 6am on the first day of the month',
    ]);
    expect(renovate.vulnerabilityAlerts?.schedule ?? []).toEqual([]);
    // The last rule that matches wins, so the catch-all group must come after the named groups.
    const nonMajor = renovate.packageRules.findLastIndex(
      (r) => r.groupName === 'all non-major dependencies',
    );
    const named = renovate.packageRules.findLastIndex(
      (r) => r.groupName !== undefined && r.groupName !== 'all non-major dependencies',
    );
    expect(nonMajor).toBeGreaterThan(named);
    expect(renovate.packageRules[nonMajor]?.matchUpdateTypes).toEqual([
      'minor',
      'patch',
      'pin',
      'pinDigest',
      'digest',
    ]);
    expect(renovate.packageRules).toContainEqual(
      expect.objectContaining({ matchUpdateTypes: ['major'], dependencyDashboardApproval: true }),
    );
  });

  it('leaves the throwaway spikes alone', () => {
    const renovate = JSON.parse(readRepoFile('renovate.json')) as {
      packageRules: { matchFileNames?: string[]; enabled?: boolean }[];
    };
    expect(renovate.packageRules).toContainEqual(
      expect.objectContaining({ matchFileNames: ['spikes/**'], enabled: false }),
    );
  });
});

describe('the new-machine setup checklist', () => {
  const contributing = readRepoFile('CONTRIBUTING.md');
  const setup = /^## Set up\n([\s\S]*?)^## /m.exec(contributing)?.[1] ?? '';
  const makefile = readRepoFile('Makefile');
  const rootScripts = Object.keys(
    (JSON.parse(readRepoFile('package.json')) as { scripts: Record<string, string> }).scripts,
  );

  it('walks a new machine from macOS to a passing gate, in order', () => {
    const steps = [
      'Apple Silicon',
      'xcode-select --install',
      'xcode-select -p',
      'https://brew.sh',
      'git config --global user.name',
      'git config --global user.email',
      'brew install gh',
      'gh auth login',
      'brew install mise',
      'eval "$(mise activate zsh)"',
      '~/.local/share/mise/shims',
      'gh repo clone travistruett/10db',
      'git clone git@github.com:travistruett/10db.git',
      'mise trust',
      'make setup',
      'INSTALL_RUST=yes|no',
      'mise install && pnpm install',
      'v26.11.1',
      'GATE PASS',
      'pnpm dev',
      'http://localhost:1420',
      'pnpm --filter @10db/desktop sidecar',
      'pnpm --filter @10db/desktop dev:shell',
      '10db Dev',
      'app.10db.desktop.dev',
      '.dev/data',
      'beside an installed 10db',
      'ERR_PNPM_IGNORED_BUILDS',
      'allowBuilds',
    ];
    const positions = steps.map((step) => setup.indexOf(step));
    expect(steps.filter((_, i) => positions[i] === -1)).toEqual([]);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('runs the dev window through pnpm dev and dev:shell, as README.md and apps/desktop/AGENTS.md do', () => {
    expect(setup).not.toContain('pnpm tauri dev');
    for (const doc of ['README.md', 'apps/desktop/AGENTS.md']) {
      expect(readRepoFile(doc)).toContain('pnpm --filter @10db/desktop dev:shell');
    }
  });

  it('names only make targets and pnpm scripts that exist', () => {
    const make = [...setup.matchAll(/\bmake ([a-z-]+)/g)].map((m) => m[1]);
    const pnpm = [...setup.matchAll(/\bpnpm ([a-z:]+)/g)].map((m) => m[1]);
    const targets = [...makefile.matchAll(/^([a-z-]+):/gm)].map((m) => m[1]);
    const known = new Set([...rootScripts, 'install', 'tauri']);
    expect(make.filter((t) => !targets.includes(t))).toEqual([]);
    expect(pnpm.filter((s) => !known.has(s ?? ''))).toEqual([]);
  });

  it('is linked from the README', () => {
    expect(readRepoFile('README.md')).toContain('(CONTRIBUTING.md#set-up)');
  });
});
