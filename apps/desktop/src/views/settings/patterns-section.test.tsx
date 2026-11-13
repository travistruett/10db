import { ModelSettingsInput, type ModelSettingsDto, type PatternDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../../test/daemon';
import { projectDto } from '../../test/fixtures';
import { modelRowDto, noModelSettings, patternDto } from '../../test/model-fixtures';
import { SectionBody } from './section-body';
import { SettingsSectionKey } from './sections';

const project = projectDto({
  areas: [
    { name: 'billing', globs: ['billing/**'] },
    { name: 'web', globs: ['web/**'] },
  ],
});

const highRisk = patternDto({
  name: 'High-risk work',
  match: { riskTags: ['security', 'auth', 'migration'] },
  setting: { kind: 'top_of_tier' },
  position: 0,
});
const retries = patternDto({
  name: 'Second tries',
  match: { retryOnly: true },
  setting: { kind: 'tier', tier: 'capable' },
  position: 1,
});

/** The saved patterns come back from every PUT as the daemon would answer them, in the order sent. */
function serve(initial: readonly PatternDto[], scope: 'global' | 'project') {
  let patterns = [...initial];
  const sent: unknown[] = [];
  const read = (): ModelSettingsDto => ({ ...noModelSettings(), patterns });
  const answer = (body: { patterns?: readonly { name: string }[] | undefined }) => {
    if (body.patterns)
      patterns = body.patterns.map((p, position) =>
        patternDto({ ...p, position, projectId: scope === 'project' ? project.id : null }),
      );
    return HttpResponse.json(read());
  };
  server.use(
    http.get(daemonUrl('/models'), () => HttpResponse.json([modelRowDto({ model: 'm' })])),
    http.get(daemonUrl('/model-settings'), () => HttpResponse.json(read())),
    http.get(daemonUrl('/projects/:projectId/model-settings'), () => HttpResponse.json(read())),
    http.put(daemonUrl('/model-settings'), async ({ request }) => {
      const body = ModelSettingsInput.parse(await request.json());
      sent.push(body.patterns);
      return answer(body);
    }),
    http.put(daemonUrl('/projects/:projectId/model-settings'), async ({ request }) => {
      const body = ModelSettingsInput.parse(await request.json());
      sent.push(body.patterns);
      return answer(body);
    }),
    ...baseHandlers(),
  );
  return sent;
}

const pattern = async (n: number) =>
  within(await screen.findByRole('group', { name: `Pattern ${String(n)}` }));

describe('Settings › Personas and flows › patterns', () => {
  it('lists the saved patterns in order, and saves a reordered, edited and added list', async () => {
    const sent = serve([highRisk, retries], 'global');
    renderWithDaemon(
      <SectionBody sectionKey={SettingsSectionKey.PersonasAndFlows} project={project} />,
    );
    const first = await pattern(1);
    expect(first.getByRole('textbox', { name: 'Name' })).toHaveProperty('value', 'High-risk work');
    expect(first.getByRole('combobox', { name: 'Model' })).toHaveProperty('value', 'Top of tier');
    for (const risk of ['Security', 'Sign-in and permissions', 'Database migration'])
      expect(first.getByText(risk)).toBeTruthy();
    expect((await pattern(2)).getByRole('checkbox', { name: 'Only on a retry' })).toHaveProperty(
      'checked',
      true,
    );
    const save = screen.getByRole('button', { name: 'Save patterns' });
    expect(save).toHaveProperty('disabled', true);

    fireEvent.click(first.getByRole('button', { name: 'Move pattern 1 down' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add pattern' }));
    fireEvent.change((await pattern(3)).getByRole('textbox', { name: 'Name' }), {
      target: { value: '  Billing  ' },
    });
    fireEvent.click(save);

    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]).toEqual([
      {
        name: 'Second tries',
        match: { roles: [], riskTags: [], areas: [], retryOnly: true },
        setting: { kind: 'tier', tier: 'capable' },
      },
      {
        name: 'High-risk work',
        match: {
          roles: [],
          riskTags: ['security', 'auth', 'migration'],
          areas: [],
          retryOnly: false,
        },
        setting: { kind: 'top_of_tier' },
      },
      {
        name: 'Billing',
        match: { roles: [], riskTags: [], areas: [], retryOnly: false },
        setting: { kind: 'automatic' },
      },
    ]);
    // Reloaded from the daemon, in the order saved.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save patterns' })).toHaveProperty(
        'disabled',
        true,
      );
    });
    expect((await pattern(1)).getByRole('textbox', { name: 'Name' })).toHaveProperty(
      'value',
      'Second tries',
    );
    expect((await pattern(3)).getByRole('textbox', { name: 'Name' })).toHaveProperty(
      'value',
      'Billing',
    );
  });

  it('saves an empty list when the last pattern is deleted, so it stays gone', async () => {
    const sent = serve([highRisk], 'global');
    renderWithDaemon(
      <SectionBody sectionKey={SettingsSectionKey.PersonasAndFlows} project={project} />,
    );
    fireEvent.click((await pattern(1)).getByRole('button', { name: 'Delete pattern 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save patterns' }));
    await waitFor(() => {
      expect(sent).toEqual([[]]);
    });
    await waitFor(() => {
      expect(screen.queryByRole('group', { name: 'Pattern 1' })).toBeNull();
    });
  });

  it('does not save a pattern with no name', async () => {
    serve([], 'global');
    renderWithDaemon(
      <SectionBody sectionKey={SettingsSectionKey.PersonasAndFlows} project={project} />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Add pattern' }));
    expect(screen.getByRole('button', { name: 'Save patterns' })).toHaveProperty('disabled', true);
  });
});

describe('Settings › Team › patterns', () => {
  it('saves a project’s own patterns, with the project’s areas to choose from', async () => {
    const sent = serve([], 'project');
    renderWithDaemon(<SectionBody sectionKey={SettingsSectionKey.Team} project={project} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add pattern' }));
    const added = await pattern(1);
    fireEvent.change(added.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Money' },
    });
    fireEvent.click(added.getByLabelText('Areas'));
    fireEvent.click(await screen.findByRole('option', { name: 'billing', hidden: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Save patterns' }));
    await waitFor(() => {
      expect(sent).toEqual([
        [
          {
            name: 'Money',
            match: { roles: [], riskTags: [], areas: ['billing'], retryOnly: false },
            setting: { kind: 'automatic' },
          },
        ],
      ]);
    });
  });
});
