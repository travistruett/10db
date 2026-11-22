import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { projectDto } from '../../test/fixtures';

it('names the base branch the form shows in the merge choice', async () => {
  const project = projectDto({
    delivery: 'pull_request',
    prTitlePrefix: 'feat(app)',
    baseBranch: 'develop',
  });
  server.use(
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    ...baseHandlers(),
  );
  renderApp('/settings/general');
  await screen.findByLabelText('Name');
  expect(screen.getByRole('radio', { name: 'Merge Into develop' })).toBeTruthy();
  expect(
    screen.getByText(
      'GitHub merges each pull request into develop by itself once its required checks pass. A task can choose another branch, or hold.',
    ),
  ).toBeTruthy();
});
