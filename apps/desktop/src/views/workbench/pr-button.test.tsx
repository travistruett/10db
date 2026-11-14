import { PassPullRequestDto, PassPullRequestPreviewDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../../test/daemon';
import { passKeys } from '../../daemon/pass-queries';
import { pagesByStatus, passViewDto } from '../../test/pass-fixtures';
import { PrButton, PrReason } from './pr-button';

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
  it('is disabled with its reason under it, which describes it, when the daemon does not offer it', async () => {
    const opened = serve({
      offered: false,
      reason: 'ampsio has no origin, so the pass lands by its close alone',
    });
    const view = passViewDto();
    renderWithDaemon(
      <>
        <PrButton view={view} />
        <PrReason view={view} />
      </>,
    );
    expect(
      await screen.findByText('ampsio has no origin, so the pass lands by its close alone'),
    ).toBeTruthy();
    const open = await button();
    expect(open).toHaveProperty('disabled', true);
    const described = document.getElementById(open.getAttribute('aria-describedby') ?? '');
    expect(described?.textContent).toBe(
      'ampsio has no origin, so the pass lands by its close alone',
    );
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
        'build has 4 commits origin/main lacks from before you started; the pull request lists them too.',
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

  it.each(['CLOSING', 'ABANDONING'] as const)(
    'while the pass is %s, reads nothing and stays disabled',
    async (state) => {
      let reads = 0;
      serve({});
      server.use(
        http.get(daemonUrl('/passes/:passId/pull-request'), () => {
          reads += 1;
          return HttpResponse.json({});
        }),
      );
      renderWithDaemon(<PrButton view={passViewDto({ pass: { state } })} />);
      expect(await button()).toHaveProperty('disabled', true);
      expect(reads).toBe(0);
    },
  );

  it('reads its preview again when a page is signed off, not on every pass event', async () => {
    let reads = 0;
    serve({});
    server.use(
      http.get(daemonUrl('/passes/:passId/pull-request'), () => {
        reads += 1;
        return HttpResponse.json(
          PassPullRequestPreviewDto.parse({
            offered: true,
            reason: null,
            aheadOfBase: 0,
            base: 'main',
            existing: null,
            gate: 'scratch',
          }),
        );
      }),
    );
    const { ready, working } = pagesByStatus();
    const view = passViewDto({ pages: [{ ...ready, signOff: 'done' }, working] });
    const { queryClient, rerender } = renderWithDaemon(<PrButton view={view} />);
    await waitFor(() => {
      expect(reads).toBe(1);
    });
    await queryClient.invalidateQueries({ queryKey: passKeys.all });
    expect(reads).toBe(1);
    rerender(
      <PrButton
        view={{ ...view, pages: [view.pages[0] ?? ready, { ...working, signOff: 'done' }] }}
      />,
    );
    await waitFor(() => {
      expect(reads).toBe(2);
    });
  });

  it('keeps its confirm open while a page signed off meanwhile reads the preview again', async () => {
    serve({});
    let release = (): void => undefined;
    const reread = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    server.use(
      http.get(daemonUrl('/passes/:passId/pull-request'), async () => {
        reads += 1;
        // The read a sign-off starts answers only once the test has looked at the confirm.
        if (reads > 1) await reread;
        return HttpResponse.json(
          PassPullRequestPreviewDto.parse({
            offered: true,
            reason: null,
            aheadOfBase: 0,
            base: 'main',
            existing: null,
            gate: 'scratch',
          }),
        );
      }),
    );
    const { ready, working } = pagesByStatus();
    const view = passViewDto({ pages: [{ ...ready, signOff: 'done' }, working] });
    const { rerender } = renderWithDaemon(<PrButton view={view} />);
    const open = await button();
    await waitFor(() => {
      expect(open).toHaveProperty('disabled', false);
    });
    fireEvent.click(open);
    await screen.findByRole('dialog', { name: 'Open Pull Request' });
    rerender(
      <PrButton
        view={{ ...view, pages: [view.pages[0] ?? ready, { ...working, signOff: 'done' }] }}
      />,
    );
    await waitFor(() => {
      expect(reads).toBe(2);
    });
    expect(screen.getByRole('dialog', { name: 'Open Pull Request' })).toBeTruthy();
    release();
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
