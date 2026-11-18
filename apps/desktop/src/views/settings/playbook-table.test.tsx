import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { DEFAULT_ACCOUNT } from '../../test/account-fixtures';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../../test/daemon';
import { modelRowDto, rolePickDto, rolePicksDto } from '../../test/model-fixtures';
import { personaDto, playbookDto } from '../../test/playbook-fixtures';
import { PlaybookTable } from './playbook-table';

it('shows a row per rigor and blanks the roles a row does not run, with what each cell resolves to', async () => {
  server.use(
    http.get(daemonUrl('/playbook'), () => HttpResponse.json(playbookDto())),
    http.get(daemonUrl('/personas'), () =>
      HttpResponse.json([personaDto({ key: 'reviewer-b', role: 'review', name: 'Reviewer B' })]),
    ),
    http.get(daemonUrl('/models'), () =>
      HttpResponse.json([
        modelRowDto({ model: 'mid-a', name: 'Mid A', availableOn: [DEFAULT_ACCOUNT.id] }),
      ]),
    ),
    http.get(daemonUrl('/models/picks'), () =>
      HttpResponse.json(
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
      ),
    ),
    ...baseHandlers(),
  );
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
