import {
  GlobalModelSettingsInput,
  ProjectModelSettingsInput,
  type ModelSettingsDto,
  type RoleSettingDto,
} from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { accountDto, DEFAULT_ACCOUNT } from '../../test/account-fixtures';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../../test/daemon';
import { projectDto } from '../../test/fixtures';
import { modelRowDto, noModelSettings } from '../../test/model-fixtures';
import { SectionBody } from './section-body';
import { SettingsSectionKey } from './sections';

const project = projectDto();
const OTHER = accountDto({ label: 'Other account' });

const models = [
  modelRowDto({ model: 'fast-a', name: 'Fast A', tier: 'fast', availableOn: [DEFAULT_ACCOUNT.id] }),
  modelRowDto({
    model: 'mid-a',
    name: 'Mid A',
    tier: 'balanced',
    availableOn: [DEFAULT_ACCOUNT.id],
  }),
  modelRowDto({ model: 'top-b', name: 'Top B', tier: 'strongest', availableOn: [OTHER.id] }),
  modelRowDto({
    model: 'house',
    name: 'House',
    tier: null,
    status: 'unknown',
    maker: null,
    family: null,
    availableOn: [DEFAULT_ACCOUNT.id],
  }),
  modelRowDto({
    model: 'old-a',
    name: 'Old A',
    status: 'superseded',
    availableOn: [DEFAULT_ACCOUNT.id],
  }),
  modelRowDto({
    model: 'dud-a',
    name: 'Dud A',
    status: 'not_runnable',
    availableOn: [DEFAULT_ACCOUNT.id],
  }),
  modelRowDto({ model: 'gone', name: 'Gone', status: 'retired', availableOn: [] }),
];

const CHOICES = ['Automatic', 'Fast', 'Balanced', 'Strongest', 'Top of tier'];

interface Put {
  readonly path: string;
  readonly body: unknown;
}

function serve(opts: { global?: ModelSettingsDto; own?: ModelSettingsDto } = {}): Put[] {
  const puts: Put[] = [];
  const global = opts.global ?? noModelSettings();
  const own = opts.own ?? noModelSettings();
  server.use(
    http.get(daemonUrl('/models'), () => HttpResponse.json(models)),
    http.get(daemonUrl('/model-settings'), () => HttpResponse.json(global)),
    http.get(daemonUrl('/projects/:projectId/model-settings'), () => HttpResponse.json(own)),
    http.put(daemonUrl('/model-settings'), async ({ request }) => {
      puts.push({
        path: '/model-settings',
        body: GlobalModelSettingsInput.parse(await request.json()),
      });
      return HttpResponse.json(global);
    }),
    http.put(daemonUrl('/projects/:projectId/model-settings'), async ({ request }) => {
      puts.push({
        path: '/projects/:projectId/model-settings',
        body: ProjectModelSettingsInput.parse(await request.json()),
      });
      return HttpResponse.json(own);
    }),
    ...baseHandlers(),
  );
  return puts;
}

const role = (
  r: RoleSettingDto['role'],
  projectId: RoleSettingDto['projectId'],
  setting: RoleSettingDto['setting'],
) => ({
  role: r,
  projectId,
  setting,
});

async function openChoices(label: string) {
  fireEvent.click(await screen.findByRole('combobox', { name: label }));
  return within(await screen.findByRole('listbox', { name: label, hidden: true }));
}

describe('Settings › Team › model by role', () => {
  it('offers Use global, Automatic, the tiers and the models the project’s account offers', async () => {
    serve();
    renderWithDaemon(<SectionBody sectionKey={SettingsSectionKey.Team} project={project} />);
    const list = await openChoices('Review model');
    await waitFor(() => {
      expect(list.getAllByRole('option', { hidden: true }).map((o) => o.textContent)).toEqual([
        'Use global',
        ...CHOICES,
        'Fast A',
        'Mid A',
        'House (Unknown)',
      ]);
    });
  });

  it('saves a pick for that role in this project', async () => {
    const puts = serve();
    renderWithDaemon(<SectionBody sectionKey={SettingsSectionKey.Team} project={project} />);
    const list = await openChoices('Review model');
    fireEvent.click(await list.findByRole('option', { name: 'Strongest', hidden: true }));
    await waitFor(() => {
      expect(puts).toEqual([
        {
          path: '/projects/:projectId/model-settings',
          body: { roles: [{ role: 'review', setting: { kind: 'tier', tier: 'strongest' } }] },
        },
      ]);
    });
  });

  it('shows the project’s own setting and hands the role back to the global one with Use global', async () => {
    const puts = serve({
      own: {
        roles: [role('plan', project.id, { kind: 'model', model: 'mid-a' })],
        patterns: [],
      },
    });
    renderWithDaemon(<SectionBody sectionKey={SettingsSectionKey.Team} project={project} />);
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Plan model' })).toHaveProperty('value', 'Mid A');
    });
    // A role the project has not set follows the global setting.
    expect(screen.getByRole('combobox', { name: 'Review model' })).toHaveProperty(
      'value',
      'Use global',
    );
    const list = await openChoices('Plan model');
    fireEvent.click(await list.findByRole('option', { name: 'Use global', hidden: true }));
    await waitFor(() => {
      expect(puts).toEqual([
        {
          path: '/projects/:projectId/model-settings',
          body: { roles: [{ role: 'plan', setting: null }] },
        },
      ]);
    });
  });

  it('keeps a saved model that is no longer offered visible, and marked', async () => {
    serve({
      own: { roles: [role('qa', project.id, { kind: 'model', model: 'retired-x' })], patterns: [] },
    });
    renderWithDaemon(<SectionBody sectionKey={SettingsSectionKey.Team} project={project} />);
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'QA model' })).toHaveProperty(
        'value',
        'retired-x (not offered)',
      );
    });
  });
});

describe('Settings › Personas and flows › model by role', () => {
  it('offers the models of every account, and no Use global', async () => {
    serve();
    renderWithDaemon(
      <SectionBody sectionKey={SettingsSectionKey.PersonasAndFlows} project={project} />,
    );
    const list = await openChoices('Review model');
    await waitFor(() => {
      expect(list.getAllByRole('option', { hidden: true }).map((o) => o.textContent)).toEqual([
        ...CHOICES,
        'Fast A',
        'Mid A',
        'Top B',
        'House (Unknown)',
      ]);
    });
  });

  it('saves a pick everywhere, and shows the global setting a role has', async () => {
    const puts = serve({
      global: { roles: [role('review', null, { kind: 'top_of_tier' })], patterns: [] },
    });
    renderWithDaemon(
      <SectionBody sectionKey={SettingsSectionKey.PersonasAndFlows} project={project} />,
    );
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Review model' })).toHaveProperty(
        'value',
        'Top of tier',
      );
    });
    const list = await openChoices('Plan model');
    fireEvent.click(await list.findByRole('option', { name: 'Automatic', hidden: true }));
    await waitFor(() => {
      expect(puts).toEqual([
        {
          path: '/model-settings',
          body: { roles: [{ role: 'plan', setting: { kind: 'automatic' } }] },
        },
      ]);
    });
  });
});
