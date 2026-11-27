import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect } from '@playwright/test';
import { claudeIsInstalled } from './claude-is-installed';
import { daemonUrl } from './daemon-url';
import { test } from './routed-test';
import { E2E_DATA, E2E_DIR, E2E_TOKEN } from './paths';
import { createProject } from './shape-project';

/** A gate report as ampsio commits one: one model passes, the other misses a gate. */
const GATE_REPORT = {
  task: 'ingest.mapping',
  version: 2,
  fingerprint: 'f'.repeat(64),
  repeat: 1,
  passed: false,
  slots: [
    {
      slot: 'SMART@medium',
      slug: 'acme/model-a',
      passed: true,
      trials: 2,
      gates: { complete: { rate: 1, good: 2, total: 2, trials: 2, minimum: 1, passed: true } },
      outcomes: { ok: 2 },
      cost: { total: '0.42', per_trial: '0.21', basis: 'billed' },
      latency_ms: { p50: 5400, p95: 9000 },
      served: [{ model: 'acme/model-a', provider: 'Acme', responses: 2 }],
      unrecorded_cases: [],
      recordings_withheld: null,
    },
    {
      slot: 'acme/model-b@medium',
      slug: 'acme/model-b',
      passed: false,
      trials: 2,
      gates: { complete: { rate: 0.5, good: 1, total: 2, trials: 2, minimum: 1, passed: false } },
      outcomes: { ok: 1, provider_error: 1 },
      cost: { total: '0.5', per_trial: '0.25', basis: 'billed' },
      latency_ms: { p50: 7400, p95: 9900 },
      served: [{ model: 'acme/model-b', provider: 'Acme', responses: 2 }],
      unrecorded_cases: [],
      recordings_withheld: null,
    },
  ],
};

// Core flow 10 (a setting that changes behavior): This Project › Trust says what a lane gets. A switch lists
// what it brings, 10db proposes a Production entry from the repo's vercel.json, and the repo's own MCP
// server waits until the builder turns it On after reading what it runs. Evals reads the same repository: a
// gitignored gate report in the checkout becomes a suite with its result per model, and its drawer shows the failing gate.
test('a builder sees what a lane gets, adds a Production proposal and turns on a repo server', async ({
  page,
  request,
}) => {
  const projectId = await createProject(request, 'trust-page', undefined, {
    '.mcp.json': JSON.stringify({
      mcpServers: {
        docs: {
          type: 'http',
          url: 'https://docs.acme-tools.dev/mcp/with/a/long/path/that/goes/on/and/on/to/test/wrapping/at/the/panel/edge?workspace=acme-engineering&token=${DOCS_TOKEN}',
          headers: { 'X-Team': 'acme' },
        },
        // A stdio server whose env block carries a profile, a replaced PATH and a plain value.
        tools: {
          command: 'node',
          args: [
            '--config',
            '/srv/acme/tools/very/long/directory/name/for/the/mcp/server/config.json',
            '--verbose',
            'server.js',
          ],
          env: { AWS_PROFILE: 'acme-dev', PATH: '/usr/bin', MODE: 'fast' },
        },
      },
    }),
    'vercel.json': JSON.stringify({ alias: ['app.acme-prod.dev'] }, null, 2),
    '.claude/skills/deploy/SKILL.md':
      '---\nname: deploy\ndescription: Ships the app\n---\nShip it.\n',
    // Results are local output a project keeps out of git, as ampsio does.
    '.gitignore': 'evals/reports/\n',
    'evals/ingest/mapping.py': 'DATASET = None\n',
    '.claude/skills/llm-eval/SKILL.md':
      '---\nname: llm-eval\ndescription: Writes an eval for LLM work\n---\nCases, graders, a free arm.\n',
  });
  const reports = join(E2E_DIR, 'trust-page-repo', 'evals', 'reports', 'ingest.mapping');
  mkdirSync(reports, { recursive: true });
  writeFileSync(join(reports, '20261013T140758276231Z.json'), JSON.stringify(GATE_REPORT));
  await claudeIsInstalled(page);
  await page.addInitScript((id: string) => {
    window.localStorage.setItem('tendb.project', JSON.stringify(id));
  }, projectId);
  await page.goto('/settings/project-trust');

  // Each switch lists what it brings under it.
  await expect(
    page
      .getByRole('list', { name: 'Project Skills, Commands and Agents items' })
      .getByText('project:deploy'),
  ).toBeVisible();

  // Production: a proposal with its source, added with one click.
  const found = page.getByRole('region', { name: 'Found in the repo' });
  await expect(found).toContainText('app.acme-prod.dev');
  await expect(found).toContainText('vercel.json:');
  await found.getByRole('button', { name: 'Add app.acme-prod.dev' }).click();
  await expect(found).toHaveCount(0);
  await expect(page.getByRole('main').getByText('app.acme-prod.dev')).toBeVisible();

  // The repo's server waits; On shows what it connects to and asks first.
  const docs = page.getByRole('switch', { name: 'docs' });
  const row = page.getByRole('main').getByText('Waiting', { exact: true });
  await expect(row).toHaveCount(2);
  await expect(docs).not.toBeChecked();
  await docs.click({ force: true });
  const confirm = page.getByRole('dialog', { name: 'Turn On docs?' });
  await expect(confirm).toContainText('Connects to');
  await expect(confirm).toContainText('https://docs.acme-tools.dev/mcp/with');
  // Everything the approval grants is in the summary, not only behind Full Details.
  await expect(confirm).toContainText('Sends headers');
  await expect(confirm).toContainText('X-Team=acme');
  await confirm.getByRole('button', { name: 'Turn On' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(docs).toBeChecked();
  await expect(row).toHaveCount(1);

  // A stdio server's env shows what it sets, the replaced PATH and the AWS profile it gets.
  await page.getByRole('switch', { name: 'tools' }).click({ force: true });
  const tools = page.getByRole('dialog', { name: 'Turn On tools?' });
  await expect(tools).toContainText('AWS_PROFILE=acme-dev');
  await expect(tools).toContainText('short-lived credentials for profile acme-dev');
  await expect(tools).toContainText('Its env block replaces PATH');
  await tools.getByRole('button', { name: 'Cancel' }).click();

  // Standing approvals: a kind the builder made routine is listed with its calls, Remove moves it to Not
  // Routine, and Approve there makes it routine again. The e2e daemon has no Decisions account, which the page says.
  const KIND = '`make t` with arguments like the examples';
  execFileSync(
    'pnpm',
    [
      'exec',
      'tsx',
      'scripts/seed-precedent.ts',
      resolve(E2E_DATA, '10db.sqlite'),
      JSON.stringify({
        projectId,
        programKey: 'make t',
        kind: KIND,
        examples: ['make t TESTS=a.test.ts'],
      }),
    ],
    { cwd: resolve(import.meta.dirname, '../../daemon'), stdio: 'inherit' },
  );
  await page.reload();
  const main = page.getByRole('main');
  await expect(main.getByText('Standing approvals need a Decisions account')).toBeVisible();
  await expect(main.getByText(KIND, { exact: true })).toBeVisible();
  await expect(main.getByText('make t TESTS=a.test.ts')).toBeVisible();
  await expect(main.getByText('Everywhere in this project, copies included')).toBeVisible();
  await expect(
    main.getByText('A running Claude session in auto mode keeps this until it next starts.'),
  ).toBeVisible();
  await expect(main.getByText('Not Routine', { exact: true })).toHaveCount(0);
  await main.getByRole('button', { name: `Remove ${KIND}` }).click();
  await expect(main.getByText('Not Routine', { exact: true })).toBeVisible();
  await expect(main.getByRole('button', { name: `Remove ${KIND}` })).toHaveCount(0);
  await main.getByRole('button', { name: `Approve ${KIND}` }).click();
  await expect(main.getByRole('button', { name: `Remove ${KIND}` })).toBeVisible();
  await expect(main.getByText('Not Routine', { exact: true })).toHaveCount(0);

  // Evals: the local report is a suite, the failing model says which gate, nothing ran a model.
  await page.goto('/evals');
  const suites = page.getByRole('table', { name: 'Evals' });
  await expect(suites).toContainText('ingest.mapping');
  await expect(suites).toContainText('acme/model-b');
  await expect(suites).toContainText('complete 0.5 < 1');
  // A trial with no answer is availability, said apart from the gates.
  await expect(suites).toContainText('1 provider error');
  // Until the evals are assessed the byline says so. The fake adapter has no model, so Assess Now ends in a
  // reason and can be pressed again; the project's own scheduled run may have failed the same way first.
  await expect(page.getByText(/Not assessed yet/u).first()).toBeVisible();
  await page.getByRole('button', { name: 'Assess Now' }).click();
  await expect(page.getByText('The last assessment failed.')).toBeVisible();
  await expect(page.getByText('The fake adapter has no model to ask.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Assess Now' })).toBeEnabled();
  await expect(page.getByText('evals/ingest/mapping.py')).toBeVisible();
  await suites.getByText('ingest.mapping').click();
  const drawer = page.getByRole('dialog', { name: 'Suite' });
  await expect(drawer).toContainText('Gates');
  await expect(drawer).toContainText('$0.92');
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);

  // By Model: each model's suites read off the same report, and two side by side with the cost difference.
  await page.getByLabel('Evals view').getByText('Models', { exact: true }).click();
  const modelB = page.getByRole('table', { name: 'Models' }).getByRole('row', { name: /model-b/u });
  await expect(modelB).toContainText('0 of 1');
  await expect(modelB).toContainText('ingest.mapping');
  await page.getByRole('combobox', { name: 'Compare with' }).click();
  await page.getByRole('option', { name: 'acme/model-b' }).click();
  const compare = page.getByRole('table', { name: 'Compare models' });
  await expect(compare).toContainText('passed');
  await expect(compare).toContainText('failed complete');
  await expect(page.getByText('1 suite differs, at +19% cost')).toBeVisible();

  // New Eval: a No Eval row files a task whose brief carries the rationale, the project's eval skill and the ban on
  // the live arm, and the task shows on the Board.
  const auth = { Authorization: `Bearer ${E2E_TOKEN}` };
  const recorded = await request.put(`${daemonUrl}/projects/${projectId}/evals/manifest`, {
    headers: auth,
    data: {
      suites: [
        {
          key: 'ingest.mapping',
          definitionPaths: ['evals/ingest/mapping.py'],
          liveCommand: 'echo done',
          live: {},
        },
        { key: 'plain', liveCommand: 'echo plain' },
      ],
      gaps: [{ label: 'Summarizer', where: 'src/summarize.py:12', why: 'No suite covers it' }],
    },
  });
  expect(recorded.ok()).toBe(true);
  await page.goto('/evals');
  // Run: a suite with live settings offers it, and this daemon has no sandbox, so the window refuses with
  // no Run; a suite whose assessment said nothing of how its command runs has none.
  await page.getByRole('table', { name: 'Evals' }).getByText('ingest.mapping').click();
  const liveDrawer = page.getByRole('dialog', { name: 'Suite' });
  await liveDrawer.getByRole('button', { name: 'Run', exact: true }).click();
  const runWindow = page.getByRole('dialog', { name: 'Run live eval' });
  await expect(runWindow).toContainText('echo done');
  await expect(runWindow.getByTestId('live-refusal')).toContainText('runs no sandbox');
  await expect(runWindow.getByRole('button', { name: 'Run', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.getByRole('table', { name: 'Evals' }).getByText('plain').click();
  await expect(liveDrawer).toContainText('10db does not know how this command runs yet');
  await expect(liveDrawer.getByRole('button', { name: 'Assess Now' })).toBeVisible();
  await expect(liveDrawer.getByRole('button', { name: 'Run', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  // The tiles filter the one table: Failing keeps the failing suite, No Eval keeps the gap's row.
  await page.getByRole('button', { name: /failing/u }).click();
  await expect(page.getByRole('table', { name: 'Evals' })).toContainText('ingest.mapping');
  await expect(page.getByRole('table', { name: 'Evals' })).not.toContainText('Summarizer');
  await page.getByRole('button', { name: /no eval/u }).click();
  await expect(page.getByRole('table', { name: 'Evals' })).toContainText('Summarizer');
  await expect(page.getByRole('table', { name: 'Evals' })).not.toContainText('ingest.mapping');
  await page.getByRole('button', { name: 'New Eval for Summarizer' }).click();
  const form = page.getByRole('dialog', { name: 'New Eval' });
  await expect(form.getByRole('textbox', { name: 'Short name' })).toHaveValue('Summarizer');
  const next = form.getByRole('button', { name: 'Next' });
  await expect(next).toBeDisabled();
  await form
    .getByRole('textbox', { name: /In one sentence/u })
    .fill('Summaries keep every figure the source states.');
  await next.click();
  // Three examples, each marked Good or Bad, open the next step.
  for (const index of [0, 1, 2]) {
    await form.getByRole('button', { name: 'Add Example' }).click();
    await form
      .getByRole('textbox', { name: `Example ${String(index + 1)} input` })
      .fill(`case ${String(index + 1)}`);
    await form
      .getByRole('button', { name: index === 2 ? 'Bad' : 'Good', exact: true })
      .nth(index)
      .click();
  }
  await next.click();
  await form.getByRole('radio', { name: /A rule or test/u }).click();
  await form
    .getByRole('textbox', { name: /What should the check look at/u })
    .fill('A human-written summary per case');
  await form.getByText('Every time', { exact: true }).click();
  await next.click();
  await form.getByRole('textbox', { name: /A model that isn.t listed/u }).fill('acme/model-b');
  await form.getByRole('button', { name: 'Add Model' }).click();
  await next.click();
  await expect(form).toContainText('What the agent will build');
  await form.getByRole('button', { name: 'Create Task' }).click();
  await expect(form).toContainText('Task created: Write the eval for Summarizer');
  await form.getByRole('link', { name: 'Write the eval for Summarizer' }).click();
  await expect(page).toHaveURL(/\/board/u);
  await expect(page.getByText('Write the eval for Summarizer').first()).toBeVisible();
  const tasks = await request.get(`${daemonUrl}/projects/${projectId}/tasks`, {
    headers: auth,
    maxRetries: 2,
  });
  const filed = ((await tasks.json()) as { title: string; description: string }[]).find(
    (t) => t.title === 'Write the eval for Summarizer',
  );
  expect(filed?.description).toContain('A human-written summary per case');
  expect(filed?.description).toContain('.claude/skills/llm-eval/SKILL.md');
  expect(filed?.description).toContain('src/summarize.py');
  expect(filed?.description).toContain('Never run the live command');
  expect(filed?.description).toContain('Bad: "case 3"');
  expect(filed?.description).toContain('`acme/model-b`');
});
