import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { claudeIsInstalled } from './claude-is-installed';
import { daemonUrl } from './daemon-url';
import { test } from './routed-test';
import { E2E_DIR, E2E_TOKEN } from './paths';
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

  // Evals: the local report is a suite, the failing model says which gate, nothing ran a model.
  await page.goto('/evals');
  const suites = page.getByRole('table', { name: 'Suites' });
  await expect(suites).toContainText('ingest.mapping');
  await expect(suites).toContainText('acme/model-b');
  await expect(suites).toContainText('complete 0.5 < 1');
  // A trial with no answer is availability, said apart from the gates.
  await expect(suites).toContainText('1 provider error');
  await expect(page.getByText('Found by file names.')).toBeVisible();
  await expect(page.getByText('evals/ingest/mapping.py')).toBeVisible();
  await suites.getByText('ingest.mapping').click();
  const drawer = page.getByRole('dialog', { name: 'Suite' });
  await expect(drawer).toContainText('Gates');
  await expect(drawer).toContainText('$0.92');
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);

  // By Model: each model's suites read off the same report, and two side by side with the cost difference.
  await page.getByRole('tab', { name: 'By Model' }).click();
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
      suites: [{ key: 'ingest.mapping', definitionPaths: ['evals/ingest/mapping.py'] }],
      gaps: [{ label: 'Summarizer', where: 'src/summarize.py:12', why: 'No suite covers it' }],
    },
  });
  expect(recorded.ok()).toBe(true);
  await page.goto('/evals');
  await page.getByRole('tab', { name: /No Eval/u }).click();
  await page.getByRole('button', { name: 'New Eval for Summarizer' }).click();
  const form = page.getByRole('dialog', { name: 'New Eval' });
  await expect(form.getByRole('textbox', { name: 'Behavior' })).toHaveValue('Summarizer');
  await form.getByRole('textbox', { name: 'Oracle' }).fill('A human-written summary per case');
  await form.getByRole('button', { name: 'File Task' }).click();
  await expect(form).toContainText('Filed Write the eval for Summarizer');
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
});
