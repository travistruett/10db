import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runWithFakeGh, type GhReply } from './fake-gh';
import { repoRoot } from './workspace';

const script = join(repoRoot, 'scripts/report-main-failures.mjs');
const repository = 'owner/repo';
const title = 'Workflows are failing on main';

interface Run {
  readonly conclusion: string;
  readonly event?: string;
  readonly repository?: string;
}
interface Workflow {
  readonly id: number;
  readonly name: string;
  readonly path?: string;
  readonly state?: string;
  readonly runs: readonly Run[];
}

const url = (id: number, index: number) => `https://example.test/${String(id)}/${String(index)}`;

function workflowReplies(workflows: readonly Workflow[]): GhReply[] {
  return [
    {
      args: `api repos/${repository}/actions/workflows?per_page=100`,
      stdout: JSON.stringify({
        workflows: workflows.map(({ id, name, path, state }) => ({
          id,
          name,
          path: path ?? `.github/workflows/${name}.yml`,
          state: state ?? 'active',
        })),
      }),
    },
    ...workflows.map(({ id, runs }) => ({
      args: `api repos/${repository}/actions/workflows/${String(id)}/runs`,
      stdout: JSON.stringify({
        workflow_runs: runs.map((run, index) => ({
          conclusion: run.conclusion,
          event: run.event ?? 'push',
          head_repository: { full_name: run.repository ?? repository },
          html_url: url(id, index),
        })),
      }),
    })),
  ];
}

interface OpenIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly author?: string;
}

const openIssues = (...issues: readonly OpenIssue[]) => ({
  args: 'issue list',
  stdout: JSON.stringify(
    issues.map(({ author, ...issue }) => ({
      ...issue,
      author: { login: author ?? 'app/github-actions' },
    })),
  ),
});
const changes: GhReply[] = [
  { args: 'issue create' },
  { args: 'issue edit' },
  { args: 'issue close' },
  { args: 'issue comment' },
];
const failingBody = `The latest run of these workflows on main failed:

- [release-please](${url(1, 0)})

This issue is rewritten hourly and closes by itself when they pass.
`;

function report(workflows: readonly Workflow[], issues: ReturnType<typeof openIssues>) {
  const result = runWithFakeGh(script, [...workflowReplies(workflows), issues, ...changes], {
    REPOSITORY: repository,
  });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return result.calls
    .map((call) => call.args)
    .filter((args) => /^issue (create|edit|close|comment)/.test(args));
}

describe('report-main-failures.mjs', () => {
  const failing: Workflow = { id: 1, name: 'release-please', runs: [{ conclusion: 'failure' }] };
  const passing: Workflow = { id: 2, name: 'ci', runs: [{ conclusion: 'success' }] };

  it('opens one issue naming each failing workflow and linking its run', () => {
    const [create, ...rest] = report([failing, passing], openIssues());
    expect(rest).toEqual([]);
    expect(create).toContain(`issue create --repo ${repository} --title ${title}`);
    expect(create).toContain(`[release-please](${url(1, 0)})`);
    expect(create).not.toContain('[ci]');
  });

  it.each(['failure', 'timed_out', 'startup_failure'])('counts a %s as failing', (conclusion) => {
    const workflow = { ...failing, runs: [{ conclusion }] };
    expect(report([workflow], openIssues())).toHaveLength(1);
  });

  const quiet = [
    { name: 'a later run passed', runs: [{ conclusion: 'success' }, { conclusion: 'failure' }] },
    {
      name: 'the failure is a pull request run',
      runs: [{ conclusion: 'failure', event: 'pull_request' }, { conclusion: 'success' }],
    },
    {
      name: 'a cancelled run hides nothing, and the run before it passed',
      runs: [{ conclusion: 'cancelled' }, { conclusion: 'success' }],
    },
    {
      name: "the failure is a fork's main",
      runs: [{ conclusion: 'failure', repository: 'fork/repo' }, { conclusion: 'success' }],
    },
    { name: 'the workflow has no runs on main', runs: [] },
  ];

  it.each(quiet)('reports nothing when $name', ({ runs }) => {
    expect(report([{ id: 1, name: 'release-please', runs }], openIssues())).toEqual([]);
  });

  it.each(['cancelled', 'skipped', 'stale', 'neutral', 'action_required'])(
    'looks past a %s run to the failure before it',
    (conclusion) => {
      const workflow = { ...failing, runs: [{ conclusion }, { conclusion: 'failure' }] };
      expect(report([workflow], openIssues())).toHaveLength(1);
    },
  );

  it('says so, rather than reporting a pass, when no run in the window reached a verdict', () => {
    const workflow = { ...failing, runs: [{ conclusion: 'cancelled' }] };
    const [create, ...rest] = report([workflow], openIssues());
    expect(rest).toEqual([]);
    expect(create).toContain('no recent run finished');
  });

  it.each([
    { name: 'disabled', workflow: { ...failing, state: 'disabled_manually' } },
    { name: 'made by GitHub', workflow: { ...failing, path: 'dynamic/dependabot/update' } },
  ])('ignores a workflow that is $name', ({ workflow }) => {
    expect(report([workflow], openIssues())).toEqual([]);
  });

  it('leaves the issue alone when nothing changed, so it sends no notification', () => {
    const issues = openIssues({ number: 7, title, body: failingBody });
    expect(report([failing], issues)).toEqual([]);
  });

  it('rewrites the issue without a notification when only the run link changed', () => {
    const older = failingBody.replace(url(1, 0), 'https://example.test/older');
    const [edit, ...rest] = report([failing], openIssues({ number: 7, title, body: older }));
    expect(rest).toEqual([]);
    expect(edit).toContain(`issue edit 7 --repo ${repository}`);
  });

  it('comments when another workflow starts failing, because an edit notifies nobody', () => {
    const also: Workflow = { id: 3, name: 'release-dry-run', runs: [{ conclusion: 'failure' }] };
    const issues = openIssues({ number: 7, title, body: failingBody });
    const [comment, edit, ...rest] = report([failing, also], issues);
    expect(rest).toEqual([]);
    expect(comment).toContain('issue comment 7');
    expect(comment).toContain('release-dry-run');
    expect(comment).not.toContain('release-please');
    expect(edit).toContain('issue edit 7');
  });

  it('leaves the new name out of the body when the comment fails, so the next run sends it', () => {
    const also: Workflow = { id: 3, name: 'release-dry-run', runs: [{ conclusion: 'failure' }] };
    const result = runWithFakeGh(
      script,
      [
        ...workflowReplies([failing, also]),
        openIssues({ number: 7, title, body: failingBody }),
        { args: 'issue comment', stderr: 'gh: Bad Gateway (HTTP 502)', status: 1 },
        ...changes,
      ],
      { REPOSITORY: repository },
    );
    expect(result.status).toBe(1);
    expect(result.calls.filter((call) => call.args.startsWith('issue edit'))).toEqual([]);
  });

  it('closes the issue when every workflow passes', () => {
    const issues = openIssues({ number: 7, title, body: failingBody });
    const [close, ...rest] = report([passing], issues);
    expect(rest).toEqual([]);
    expect(close).toContain(`issue close 7 --repo ${repository}`);
  });

  it.each(['someone', 'app/renovate'])(
    'opens its own issue when %s holds the same title, so nobody can silence it',
    (author) => {
      const issues = openIssues({ number: 3, title, body: failingBody, author });
      const [create, ...rest] = report([failing], issues);
      expect(rest).toEqual([]);
      expect(create).toContain('issue create');
    },
  );

  it('leaves other issues alone', () => {
    const issues = openIssues({ number: 3, title: 'a bug', body: 'text' });
    expect(report([passing], issues)).toEqual([]);
  });

  it('fails rather than reporting all clear when GitHub cannot be read', () => {
    const result = runWithFakeGh(
      script,
      [{ args: 'api repos', stderr: 'gh: Bad Gateway (HTTP 502)', status: 1 }, ...changes],
      { REPOSITORY: repository },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('HTTP 502');
    expect(result.calls.filter((call) => call.args.startsWith('issue'))).toEqual([]);
  });

  it('refuses a missing repository name', () => {
    const result = runWithFakeGh(script, [], {});
    expect(result.status).toBe(2);
    expect(result.calls).toEqual([]);
  });
});
