import { PASS_MOVE_CHOICE, type PassMoveDetail, type PassViewDto } from '@10db/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../../test/daemon';
import { passCard, passViewDto } from '../../test/pass-fixtures';
import { ClosedPassLine, closedPassWords } from './closed-pass-line';

const PR = 'https://github.com/acme/ampsio/pull/7';
const closed = passViewDto({
  pass: { state: 'CLOSED', returnBranch: 'main' },
  rest: { pullRequest: { url: PR, draft: false, state: 'open', failingChecks: [] } },
});
const moveCard = passCard(closed, {
  kind: 'pass_move',
  passId: closed.pass.id,
  returnBranch: 'main',
  base: 'main',
  reason: 'closed',
  prUrl: PR,
});

/** Answers each card with `answer`; records the cards answered and with what. */
function serve(answer: () => Response) {
  const sent: { id: string; body: unknown }[] = [];
  server.use(
    http.post(daemonUrl('/inbox/:id/answer'), async ({ params, request }) => {
      sent.push({ id: String(params['id']), body: await request.json() });
      return answer();
    }),
    ...baseHandlers(),
  );
  return sent;
}

describe('ClosedPassLine', () => {
  it('says the pass closed with its pull request, and offers no Move without its card', async () => {
    serve(() => HttpResponse.json({}));
    renderWithDaemon(<ClosedPassLine view={closed} inbox={[]} />);
    expect(
      await screen.findByText('Settings pass finished; it settles once its pull request merges.'),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Pull request' })).toHaveProperty('href', PR);
    expect(screen.queryByRole('button', { name: /^Move/ })).toBeNull();
  });

  it("answers the pass's Move card, and says why when it is refused", async () => {
    const sent = serve(() =>
      HttpResponse.json(
        { error: 'conflict', message: 'src/app.css is uncommitted where the move would write' },
        { status: 409 },
      ),
    );
    const other = passCard(passViewDto(), {
      kind: 'pass_move',
      passId: passViewDto().pass.id,
      returnBranch: 'main',
      base: 'main',
      reason: 'closed',
      prUrl: null,
    });
    renderWithDaemon(<ClosedPassLine view={closed} inbox={[other, moveCard]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Move main to origin/main' }));
    await waitFor(() => {
      expect(sent).toEqual([{ id: moveCard.id, body: { choice: PASS_MOVE_CHOICE } }]);
    });
    expect(
      await screen.findByText('src/app.css is uncommitted where the move would write'),
    ).toBeTruthy();
  });
});

describe('closedPassWords', () => {
  const pr = (state: 'open' | 'merged' | 'closed' | null): PassViewDto['pullRequest'] => ({
    url: PR,
    draft: false,
    state,
    failingChecks: [],
  });
  const move = (reason: PassMoveDetail['reason']): PassMoveDetail => ({
    kind: 'pass_move',
    passId: closed.pass.id,
    returnBranch: 'main',
    base: 'main',
    reason,
    prUrl: PR,
  });
  it.each<{
    name: string;
    pullRequest: PassViewDto['pullRequest'];
    card: PassMoveDetail | null;
    words: string;
  }>([
    {
      name: 'its pull request open',
      pullRequest: pr('open'),
      card: null,
      words: 'Settings pass finished; it settles once its pull request merges.',
    },
    {
      name: 'its pull request not read yet',
      pullRequest: pr(null),
      card: move('closed'),
      words: 'Settings pass finished; it settles once its pull request merges.',
    },
    {
      name: 'no pull request',
      pullRequest: null,
      card: null,
      words: 'Settings pass finished with no pull request.',
    },
    {
      name: 'closed unmerged, by its card',
      pullRequest: pr('open'),
      card: move('closed_unmerged'),
      words: 'Settings pass finished; its pull request closed without merging.',
    },
    {
      name: 'closed unmerged, read before a card',
      pullRequest: pr('closed'),
      card: null,
      words: 'Settings pass finished; its pull request closed without merging.',
    },
    {
      name: 'merged after other work reached the base',
      pullRequest: pr('merged'),
      card: move('drift'),
      words:
        'Settings pass finished; its pull request merged, but other work reached main first, so the folder waits to move.',
    },
    {
      name: 'a CI fix pushed to it',
      pullRequest: pr('open'),
      card: move('ci_fix'),
      words:
        'Settings pass finished; a fix was pushed to its pull request, so the folder waits to move.',
    },
    {
      name: 'merged, realigning by itself',
      pullRequest: pr('merged'),
      card: null,
      words:
        'Settings pass finished; its pull request merged, and the folder moves to the base next.',
    },
  ])('$name', ({ pullRequest, card, words }) => {
    expect(closedPassWords({ ...closed, pullRequest }, card)).toBe(words);
  });
});
