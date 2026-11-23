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
  const choice = screen.getByRole<HTMLInputElement>('combobox', { name: 'When Checks Pass' });
  expect(choice.value).toBe('Merge Into develop');
  expect(screen.getByText('GitHub merges each pull request once its checks pass.')).toBeTruthy();
});
