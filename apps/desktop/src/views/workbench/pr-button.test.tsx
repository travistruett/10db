import { PassPullRequestDto, PassPullRequestPreviewDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../../test/daemon';
import { passViewDto } from '../../test/pass-fixtures';
import { PrButton } from './pr-button';

/** Answers the pull request's preview with `preview`; records the passes asked to open one. */
function serve(preview: Partial<PassPullRequestPreviewDto>, url: string | null = null) {
  const opened: string[] = [];
  server.use(
    http.get(daemonUrl('/passes/:passId/pull-request'), () =>
      HttpResponse.json(
        PassPullRequestPreviewDto.parse({
          offered: true,
          reason: null,
          aheadOfBase: 0,
          base: 'main',
          existing: null,
          gate: 'scratch',
          ...preview,
        }),
      ),
    ),
    http.post(daemonUrl('/passes/:passId/pull-request'), ({ params }) => {
      opened.push(String(params['passId']));
      return HttpResponse.json(
        PassPullRequestDto.parse({ url, base: 'main', gate: 'scratch', review: 'started' }),
        { status: 202 },
      );
    }),
    ...baseHandlers(),
  );
  return opened;
}

const button = () => screen.findByRole('button', { name: 'Open Pull Request' });

describe('PrButton', () => {
  it('is disabled with its reason beside it when the daemon does not offer it', async () => {
    const opened = serve({
      offered: false,
      reason: 'ampsio has no origin, so the pass lands by its close alone',
    });
    renderWithDaemon(<PrButton view={passViewDto()} />);
    expect(
      await screen.findByText('ampsio has no origin, so the pass lands by its close alone'),
    ).toBeTruthy();
    const open = await button();
    expect(open).toHaveProperty('disabled', true);
    fireEvent.click(open);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opened).toEqual([]);
  });

  it('says the commits origin lacks and where the gate runs, then opens it for this pass', async () => {
    const opened = serve({ aheadOfBase: 4 }, 'https://github.com/acme/ampsio/pull/7');
    const view = passViewDto({ pass: { returnBranch: 'build' } });
    renderWithDaemon(<PrButton view={view} />);
    const open = await button();
    await waitFor(() => {
      expect(open).toHaveProperty('disabled', false);
    });
    fireEvent.click(open);
    const dialog = await screen.findByRole('dialog', { name: 'Open Pull Request' });
    expect(
      within(dialog).getByText(
        'build has 4 commits origin/main lacks from before the pass; the pull request lists them too.',
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        'The gate runs on the pushed commit in a separate copy, so you can keep working.',
      ),
    ).toBeTruthy();
    // Opening the confirm sends nothing.
    expect(opened).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open Pull Request' }));
    await waitFor(() => {
      expect(opened).toEqual([view.pass.id]);
    });
    expect(await screen.findByRole('link', { name: 'Pull request' })).toHaveProperty(
      'href',
      'https://github.com/acme/ampsio/pull/7',
    );
  });

  it("links the pass's pull request once the view has one", async () => {
    serve({});
    const view = passViewDto({
      rest: {
        pullRequest: {
          url: 'https://github.com/acme/ampsio/pull/7',
          draft: true,
          state: 'open',
          failingChecks: [],
        },
      },
    });
    renderWithDaemon(<PrButton view={view} />);
    expect(await screen.findByRole('link', { name: 'Pull request' })).toBeTruthy();
  });
});
