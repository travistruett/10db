import { expect, test, type APIRequestContext } from '@playwright/test';
import { z } from 'zod';
import { claudeIsInstalled } from './claude-is-installed';
import { daemonUrl } from './daemon-url';
import { auth, createProject } from './shape-project';

// The Factory's Rigor table through the real daemon and the fake agent (script-book.json, keyed by
// task title): a Light task (one step) and a Standard task (build and review) run to done in one
// project, and the table shows one done task in each row with Standard's steps above Light's.

const Id = z.looseObject({ id: z.string() });
const Tasks = z.array(z.looseObject({ id: z.string(), status: z.string() }));

/** Makes a task of `rigor`, starts it and waits until the daemon says it is done. */
async function runToDone(
  request: APIRequestContext,
  projectId: string,
  title: string,
  rigor: 'light' | 'standard',
): Promise<void> {
  const created = await request.post(`${daemonUrl}/projects/${projectId}/tasks`, {
    headers: auth,
    data: { title, acceptanceCriteria: ['the file is written'], areas: ['repo'], rigor },
  });
  expect(created.ok()).toBe(true);
  const taskId = Id.parse(await created.json()).id;
  const started = await request.post(`${daemonUrl}/tasks/${taskId}/start`, { headers: auth });
  expect(started.ok()).toBe(true);
  await expect
    .poll(async () => {
      const listed = await request.get(`${daemonUrl}/projects/${projectId}/tasks`, {
        headers: auth,
      });
      return Tasks.parse(await listed.json()).find((t) => t.id === taskId)?.status;
    })
    .toBe('done');
}

test('the Rigor table shows a done Light task and a done Standard task, Standard with more steps', async ({
  page,
  request,
}) => {
  const projectId = await createProject(request, 'rigor-figures');
  await runToDone(request, projectId, 'Measure the light task', 'light');
  await runToDone(request, projectId, 'Measure the standard task', 'standard');

  await claudeIsInstalled(page);
  await page.addInitScript((id: string) => {
    window.localStorage.setItem('tendb.project', JSON.stringify(id));
  }, projectId);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/factory');

  const table = page.getByRole('table', { name: 'Work per task by rigor' });
  const cells = async (rigor: string): Promise<string[]> =>
    table
      .getByRole('row', { name: new RegExp(`^${rigor} `) })
      .getByRole('cell')
      .allTextContents();
  await expect.poll(async () => (await cells('Light'))[1]).toBe('1');
  const light = await cells('Light');
  const standard = await cells('Standard');
  // Rigor, Tasks done, Steps per task: one task each, and the review is Standard's second step.
  expect(light.slice(0, 3)).toEqual(['Light', '1', '1']);
  expect(standard.slice(0, 2)).toEqual(['Standard', '1']);
  expect(Number(standard[2])).toBeGreaterThan(Number(light[2]));
  // The /system route is still fetching as the test ends.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});
