import { expect, test, type Page } from '@playwright/test';
import { z } from 'zod';
import { claudeIsInstalled } from './claude-is-installed';
import { daemonUrl } from './daemon-url';
import { expectAccessible } from './expect-accessible';
import { auth, createProject } from './shape-project';

// A Plan's record against the real daemon: a small imported Plan, each tab of its Record opened in
// dark and light and scanned with axe. It imports a Plan and converts nothing, so no goal or task
// reaches Factory or the Board for the specs after it.

const AT = '2026-11-12T08:00:00.000Z';
const PLAN = [
  '# Pairing plan',
  '## Starting point',
  'Main at 818d3644; see the note[^1] and [the guide][guide].',
  '### Task 1: Pair a device',
  'Pair it over the tailnet with `pair()`, reaching <host>.',
  '## Calls made',
  'A code lasts ten minutes.',
  '',
  '[^1]: The runner packs once.',
  '',
  '[guide]: https://example.com/guide',
  '',
].join('\n');

/** The bundle for `projectId`: one plan document, one of each entry and list, one task. */
const bundle = (projectId: string) => ({
  id: 'plan-record-e2e',
  projectId,
  title: 'Pairing',
  origin: { kind: 'claude_code', session: 'ses-e2e', model: 'claude-opus-5-5', at: AT },
  intent: [{ key: 'i1', quote: 'Plans stay local.', speaker: 'builder', saidAt: '2026-11-12' }],
  documents: [
    {
      key: 'p1',
      kind: 'plan',
      title: 'Pairing plan',
      revisions: [{ number: 1, body: PLAN, note: 'first', author: 'opus', at: AT }],
    },
  ],
  entries: [
    {
      key: 'f1',
      kind: 'fact',
      title: 'The runner packs once',
      body: { claim: 'The runner packs the context once per session.' },
      anchors: [
        { kind: 'code', path: 'src/runner.ts', line: 3, commit: '818d3644', excerpt: 'build();' },
      ],
      sources: ['capture'],
      verified: true,
      checkedAt: '2026-11-12',
    },
  ],
  decisions: [
    {
      key: 'd1',
      question: 'Where does the record live?',
      choice: 'In the database',
      rationale: 'Local only',
      alternatives: [{ option: 'Docs PRs', whyNot: 'They land in the repo' }],
      lasting: true,
      scope: 'project',
      decidedAt: '2026-11-12',
    },
  ],
  findings: [
    {
      key: 'p1-r1-1',
      document: 'p1',
      revision: 1,
      section: 'task-1',
      reviewer: 'fable plan reviewer',
      round: 1,
      severity: 'high',
      severityText: 'blocking',
      text: 'The code from `pair()` never expires',
      state: 'resolved',
      outcomeText: 'fixed',
      how: 'Named it',
      howDetail: 'Calls made says ten minutes.',
    },
  ],
  questions: [{ key: 'q1', text: 'Which port?', owner: 'designer', about: 't1' }],
  goals: [
    {
      key: 'g1',
      title: 'Pairing',
      objective: 'A device pairs with the host.',
      tasks: [
        {
          key: 't1',
          title: 'Pair a device',
          criteria: ['A device pairs'],
          areas: ['repo'],
          planRef: { document: 'p1', revision: 1, section: 'task-1', shared: ['calls-made'] },
          cites: ['f1', 'd1'],
        },
      ],
    },
  ],
});

const TABS = ['Documents', 'Decisions', 'Evidence', 'Reviews', 'Questions', 'Tasks'] as const;

async function openRecord(page: Page, projectId: string, shapeId: string, scheme: string) {
  await claudeIsInstalled(page);
  await page.addInitScript(
    ([id = '', value = '']: string[]) => {
      window.localStorage.setItem('tendb.project', JSON.stringify(id));
      window.localStorage.setItem('mantine-color-scheme-value', value);
    },
    [projectId, scheme],
  );
  await page.goto(`/shape/${shapeId}/record`);
  await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', scheme);
}

for (const scheme of ['dark', 'light'] as const) {
  test(`each tab of an imported Plan's record passes axe in ${scheme}`, async ({
    page,
    request,
  }) => {
    const projectId = await createProject(request, `plan-record-${scheme}`);
    const imported = await request.post(`${daemonUrl}/projects/${projectId}/plans/import`, {
      headers: auth,
      data: { bundle: bundle(projectId) },
    });
    expect(imported.ok()).toBe(true);
    const { shapeId } = z.object({ shapeId: z.string() }).parse(await imported.json());
    await page.setViewportSize({ width: 1440, height: 900 });
    await openRecord(page, projectId, shapeId, scheme);

    // Documents opens first, drawn whole: the footnote and the reference link resolve, and <host>
    // reads as written.
    const body = page.getByRole('region', { name: 'Pairing plan' });
    await expect(body).toContainText('The runner packs once.');
    await expect(body.getByRole('link', { name: 'the guide' })).toHaveAttribute(
      'title',
      'https://example.com/guide',
    );
    await expect(body).toContainText('reaching <host>.');
    await expectAccessible(page, `Documents, ${scheme}`);
    for (const tab of TABS.slice(1)) {
      await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
      await expect(page.getByRole('tab', { name: new RegExp(`^${tab}`) })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(page.getByRole('table')).toBeVisible();
      await expectAccessible(page, `${tab}, ${scheme}`);
    }
  });
}
