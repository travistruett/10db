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
      mcpServers: { docs: { type: 'http', url: 'https://docs.acme-tools.dev/mcp' } },
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
  await expect(row).toBeVisible();
  await expect(docs).not.toBeChecked();
  await docs.click({ force: true });
  const confirm = page.getByRole('dialog', { name: 'Turn On docs?' });
  await expect(confirm).toContainText('Connects to');
  await expect(confirm).toContainText('https://docs.acme-tools.dev/mcp');
  await confirm.getByRole('button', { name: 'Turn On' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(docs).toBeChecked();
  await expect(row).toHaveCount(0);
});
