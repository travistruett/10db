import { expect } from '@playwright/test';
import { claudeIsInstalled } from './claude-is-installed';
import { test } from './routed-test';
import { createProject } from './shape-project';

// Core flow 10 (a setting that changes behavior): This Project › Trust says what a lane gets. A switch lists
// what it brings, 10db proposes a Production entry from the repo's vercel.json, and the repo's own MCP
// server waits until the builder turns it On after reading what it runs.
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
  });
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
});
