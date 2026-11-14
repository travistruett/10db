import { PlaybookInput as PlaybookInputSchema, type PlaybookDto } from '@10db/contracts';
import type { z } from 'zod';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ACCOUNT } from '../../test/account-fixtures';
import { pickOption } from '../../test/combobox';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../../test/daemon';
import { projectDto } from '../../test/fixtures';
import { modelRowDto, rolePickDto, rolePicksDto } from '../../test/model-fixtures';
import { personaDto, playbookDto } from '../../test/playbook-fixtures';
import { PlaybookTable } from './playbook-table';
import { ProjectPlaybook } from './project-playbook';

const project = projectDto();
const REVIEWER = personaDto({ key: 'reviewer-b', role: 'review', name: 'Reviewer B' });

/** What the daemon reads from a write, after its own schema has parsed it. */
type PlaybookBody = z.output<typeof PlaybookInputSchema>;

interface Put {
  readonly path: string;
  readonly body: PlaybookBody;
}

/** What a scope's playbook looks like after a write: each field sent is set there, and a null one is cleared. */
function applyPut(
  view: PlaybookDto,
  input: PlaybookBody,
  source: 'global' | 'project',
): PlaybookDto {
  const sourced = <T,>(value: T | null | undefined) =>
    value === null || value === undefined
      ? { value: null, source: 'default' as const }
      : { value, source };
  return playbookDto({
    rows: view.rows.map((row) => {
      const sent = input.rows.find((r) => r.rigor === row.rigor);
      return sent?.steps == null ? row : { ...row, steps: { value: sent.steps, source } };
    }),
    cells: view.cells.map((cell) => {
      const sent = input.cells.find((c) => c.rigor === cell.rigor && c.role === cell.role);
      return sent === undefined
        ? cell
        : {
            ...cell,
            personaId: sourced(sent.personaId),
            model: sourced(sent.model),
            effort: sourced(sent.effort),
          };
    }),
  });
}

/** Serves the playbook of each scope and records what the table writes, parsed with the daemon's own schema. */
function serve(
  opts: { global?: PlaybookDto; own?: PlaybookDto; askedPicks?: string[] } = {},
): Put[] {
  const puts: Put[] = [];
  let global = opts.global ?? playbookDto();
  let own = opts.own ?? playbookDto();
  server.use(
    http.get(daemonUrl('/playbook'), () => HttpResponse.json(global)),
    http.get(daemonUrl('/projects/:projectId/playbook'), () => HttpResponse.json(own)),
    http.put(daemonUrl('/playbook'), async ({ request }) => {
      const body = PlaybookInputSchema.parse(await request.json());
      puts.push({ path: '/playbook', body });
      global = applyPut(global, body, 'global');
      return HttpResponse.json(global);
    }),
    http.put(daemonUrl('/projects/:projectId/playbook'), async ({ request }) => {
      const body = PlaybookInputSchema.parse(await request.json());
      puts.push({ path: '/projects/:projectId/playbook', body });
      own = applyPut(own, body, 'project');
      return HttpResponse.json(own);
    }),
    http.get(daemonUrl('/personas'), () => HttpResponse.json([REVIEWER])),
    http.get(daemonUrl('/models'), () =>
      HttpResponse.json([
        modelRowDto({ model: 'mid-a', name: 'Mid A', availableOn: [DEFAULT_ACCOUNT.id] }),
      ]),
    ),
    http.get(daemonUrl('/models/picks'), ({ request }) => {
      const url = new URL(request.url);
      opts.askedPicks?.push(
        `${url.searchParams.get('rigor') ?? ''}/${url.searchParams.get('project') ?? 'all'}`,
      );
      return HttpResponse.json(
        rolePicksDto(DEFAULT_ACCOUNT.id, [
          rolePickDto({
            role: 'review',
            model: 'mid-a',
            effort: 'high',
            costPerTaskUsd: 0.42,
            reason: 'by score: cheapest profile at or above 40 intelligence',
          }),
          rolePickDto({ role: 'implement', model: 'mid-a', effort: 'medium' }),
        ]),
      );
    }),
    ...baseHandlers(),
  );
  return puts;
}

const own = <T,>(value: T, source: 'default' | 'global' | 'project') => ({ value, source });

async function openCell(name: RegExp) {
  fireEvent.click(await screen.findByRole('button', { name }));
  return within(await screen.findByRole('dialog', { name: /cell$/ }));
}

describe('the playbook table', () => {
  it('shows a row per rigor and blanks the roles a row does not run, with what each cell resolves to', async () => {
    serve();
    renderWithDaemon(<PlaybookTable projectId={null} accountId={DEFAULT_ACCOUNT.id} />);
    const review = await screen.findByRole('button', {
      name: 'Standard Review: Mid A, high · Auto, at least 40',
    });
    expect(review).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Light Build: Mid A, medium · Auto, at least 35' }),
    ).toBeTruthy();
    // Light runs Build only.
    expect(screen.queryByRole('button', { name: /^Light Review/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Light Plan:/ })).toBeNull();
    for (const rigor of ['Light', 'Standard', 'Careful', 'Critical'])
      expect(screen.getByRole('button', { name: `${rigor} steps` })).toBeTruthy();
  });

  it('makes each cell’s own button the editor’s popover target, so the popup attributes sit on a button', async () => {
    serve();
    renderWithDaemon(<PlaybookTable projectId={null} accountId={DEFAULT_ACCOUNT.id} />);
    const build = await screen.findByRole('button', { name: /^Light Build:/ });
    expect(build.getAttribute('aria-haspopup')).toBe('dialog');
    expect(build.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(build);
    await waitFor(() => {
      expect(build.getAttribute('aria-expanded')).toBe('true');
    });
  });

  it('asks the daemon for every rigor’s picks, in the project’s playbook for a project', async () => {
    const askedPicks: string[] = [];
    serve({ askedPicks });
    renderWithDaemon(<PlaybookTable projectId={project.id} accountId={DEFAULT_ACCOUNT.id} />);
    await screen.findByRole('button', { name: /^Standard Review/ });
    await waitFor(() => {
      expect([...new Set(askedPicks)].sort()).toEqual(
        ['careful', 'critical', 'light', 'standard'].map((r) => `${r}/${project.id}`),
      );
    });
  });

  describe('a cell edit writes this scope’s own fields only', () => {
    it('globally: sets the effort and leaves the default model unwritten', async () => {
      const puts = serve();
      renderWithDaemon(<PlaybookTable projectId={null} accountId={DEFAULT_ACCOUNT.id} />);
      const cell = await openCell(/^Standard Review/);
      await pickOption(cell.getByRole('combobox', { name: 'Effort', hidden: true }), 'Low');
      await waitFor(() => {
        expect(puts).toEqual([
          {
            path: '/playbook',
            body: {
              rows: [],
              cells: [
                { rigor: 'standard', role: 'review', personaId: null, model: null, effort: 'low' },
              ],
            },
          },
        ]);
      });
    });

    it('in a project: keeps what the project set, and never copies the global fields into it', async () => {
      const puts = serve({
        own: playbookDto({
          cells: [
            {
              rigor: 'standard',
              role: 'review',
              personaId: own(null, 'default'),
              model: own({ kind: 'tier', tier: 'capable' }, 'project'),
              effort: own('max', 'global'),
            },
          ],
        }),
      });
      renderWithDaemon(<PlaybookTable projectId={project.id} accountId={DEFAULT_ACCOUNT.id} />);
      const cell = await openCell(/^Standard Review/);
      await pickOption(cell.getByRole('combobox', { name: 'Persona', hidden: true }), 'Reviewer B');
      await waitFor(() => {
        expect(puts).toHaveLength(1);
      });
      expect(puts[0]?.path).toBe('/projects/:projectId/playbook');
      expect(puts[0]?.body.cells).toEqual([
        {
          rigor: 'standard',
          role: 'review',
          personaId: REVIEWER.id,
          model: { kind: 'tier', tier: 'capable' },
          // The global effort stays global; this project sets none.
          effort: null,
        },
      ]);
    });

    it('names what an unset field inherits: Global in a project, Default everywhere', async () => {
      serve({
        global: playbookDto({
          cells: [
            {
              rigor: 'standard',
              role: 'review',
              personaId: own(null, 'default'),
              model: own({ kind: 'automatic', minimum: 40 }, 'default'),
              effort: own('low', 'global'),
            },
          ],
        }),
      });
      renderWithDaemon(<PlaybookTable projectId={project.id} accountId={DEFAULT_ACCOUNT.id} />);
      let cell = await openCell(/^Standard Review/);
      const value = (name: string) =>
        cell.getByRole('combobox', { name, hidden: true }).getAttribute('value');
      expect(value('Effort')).toBe('Global: Low');
      expect(value('Model')).toBe('Global: Automatic, at least 40');
      expect(value('Persona')).toBe('Global: the role’s own');
      cleanup();
      renderWithDaemon(<PlaybookTable projectId={null} accountId={DEFAULT_ACCOUNT.id} />);
      cell = await openCell(/^Standard Review/);
      expect(value('Model')).toBe('Default: Automatic, at least 40');
      expect(value('Persona')).toBe('Default: the role’s own');
      // The effort is set globally, so the field shows it rather than the default under it.
      expect(value('Effort')).toBe('Low');
    });

    it('shows no cost line when the pick has no cost', async () => {
      serve();
      renderWithDaemon(<PlaybookTable projectId={null} accountId={DEFAULT_ACCOUNT.id} />);
      let cell = await openCell(/^Standard Build/);
      expect(cell.queryByText(/per task/)).toBeNull();
      cleanup();
      renderWithDaemon(<PlaybookTable projectId={null} accountId={DEFAULT_ACCOUNT.id} />);
      cell = await openCell(/^Standard Review/);
      expect(cell.getByText(/\$0\.42 per task/)).toBeTruthy();
    });

    it('commits a minimum for Automatic on blur, and a tier for Top of tier', async () => {
      const puts = serve();
      renderWithDaemon(<PlaybookTable projectId={null} accountId={DEFAULT_ACCOUNT.id} />);
      const cell = await openCell(/^Standard Review/);
      await pickOption(cell.getByRole('combobox', { name: 'Model', hidden: true }), 'Automatic');
      const minimum = await cell.findByRole('textbox', {
        name: 'Minimum Intelligence',
        hidden: true,
      });
      fireEvent.change(minimum, { target: { value: '55' } });
      fireEvent.blur(minimum);
      await waitFor(() => {
        expect(puts.at(-1)?.body.cells).toEqual([
          {
            rigor: 'standard',
            role: 'review',
            personaId: null,
            model: { kind: 'automatic', minimum: 55 },
            effort: null,
          },
        ]);
      });
      await pickOption(cell.getByRole('combobox', { name: 'Model', hidden: true }), 'Top of tier');
      await pickOption(
        await cell.findByRole('combobox', { name: 'Tier', hidden: true }),
        'Capable',
      );
      await waitFor(() => {
        expect(puts.at(-1)?.body.cells[0]?.model).toEqual({
          kind: 'top_of_tier',
          tier: 'capable',
        });
      });
    });
  });

  describe('Reset', () => {
    it('clears every field of the cell in this scope', async () => {
      const puts = serve({
        global: playbookDto({
          cells: [
            {
              rigor: 'standard',
              role: 'review',
              personaId: own(null, 'default'),
              model: own({ kind: 'tier', tier: 'capable' }, 'global'),
              effort: own('low', 'global'),
            },
          ],
        }),
      });
      renderWithDaemon(<PlaybookTable projectId={null} accountId={DEFAULT_ACCOUNT.id} />);
      const cell = await openCell(/^Standard Review/);
      fireEvent.click(cell.getByRole('button', { name: 'Reset', hidden: true }));
      await waitFor(() => {
        expect(puts).toEqual([
          {
            path: '/playbook',
            body: {
              rows: [],
              cells: [
                { rigor: 'standard', role: 'review', personaId: null, model: null, effort: null },
              ],
            },
          },
        ]);
      });
    });

    it('is off for a cell this scope sets nothing in', async () => {
      const puts = serve({
        // The global scope sets it; the project sets nothing, so Reset has nothing to clear there.
        own: playbookDto({
          cells: [
            {
              rigor: 'standard',
              role: 'review',
              personaId: own(null, 'default'),
              model: own(null, 'default'),
              effort: own('low', 'global'),
            },
          ],
        }),
      });
      renderWithDaemon(<PlaybookTable projectId={project.id} accountId={DEFAULT_ACCOUNT.id} />);
      const cell = await openCell(/^Standard Review/);
      expect(cell.getByRole('button', { name: 'Reset', hidden: true })).toHaveProperty(
        'disabled',
        true,
      );
      expect(puts).toEqual([]);
    });
  });

  describe('a rigor’s steps', () => {
    it('switches a step on in this scope, keeping Build fixed and in task order', async () => {
      const puts = serve();
      renderWithDaemon(<PlaybookTable projectId={null} accountId={DEFAULT_ACCOUNT.id} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Light steps' }));
      const drawer = within(await screen.findByRole('dialog', { name: 'Light: steps' }));
      expect(drawer.getByRole('checkbox', { name: /Build/, hidden: true })).toHaveProperty(
        'disabled',
        true,
      );
      fireEvent.click(drawer.getByRole('checkbox', { name: /^Review/, hidden: true }));
      await waitFor(() => {
        expect(puts).toEqual([
          {
            path: '/playbook',
            body: { rows: [{ rigor: 'light', steps: ['implement', 'review'] }], cells: [] },
          },
        ]);
      });
    });

    it('takes the plan review with the plan, and Reset hands the row back', async () => {
      const puts = serve({
        global: playbookDto({
          rows: [
            {
              rigor: 'critical',
              steps: own(['plan', 'plan_review', 'implement', 'review', 'qa'], 'global'),
            },
          ],
        }),
      });
      renderWithDaemon(<PlaybookTable projectId={null} accountId={DEFAULT_ACCOUNT.id} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Critical steps' }));
      const drawer = within(await screen.findByRole('dialog', { name: 'Critical: steps' }));
      fireEvent.click(drawer.getByRole('checkbox', { name: /^Plan\b(?! Review)/, hidden: true }));
      await waitFor(() => {
        expect(puts.at(-1)?.body.rows).toEqual([
          { rigor: 'critical', steps: ['implement', 'review', 'qa'] },
        ]);
      });
      const reset = drawer.getByRole('button', { name: 'Reset', hidden: true });
      await waitFor(() => {
        expect(reset).toHaveProperty('disabled', false);
      });
      fireEvent.click(reset);
      await waitFor(() => {
        expect(puts.at(-1)?.body.rows).toEqual([{ rigor: 'critical', steps: null }]);
      });
    });
  });
});

describe('a project’s playbook', () => {
  it('sets the project’s default rigor', async () => {
    serve();
    const patched: unknown[] = [];
    server.use(
      http.patch(daemonUrl('/projects/:projectId'), async ({ request }) => {
        patched.push(await request.json());
        return HttpResponse.json(project);
      }),
    );
    renderWithDaemon(<ProjectPlaybook project={project} />);
    const field = await screen.findByRole('combobox', { name: 'Default rigor' });
    expect(field).toHaveProperty('value', 'Standard');
    await pickOption(field, 'Careful');
    await waitFor(() => {
      expect(patched).toEqual([{ defaultRigor: 'careful' }]);
    });
  });
});
