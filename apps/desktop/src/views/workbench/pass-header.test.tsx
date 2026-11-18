import { mintId } from '@10db/contracts';
import type { PassNotice, PassViewDto } from '@10db/contracts';
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { projectViewDto } from '../../test/fixtures';
import { minutesBeforeNow, PASS_NOW, pagesByStatus, passViewDto } from '../../test/pass-fixtures';
import { FrameSlots, titleRowOf } from '../../test/frame';
import { renderWithTheme } from '../../test/theme';
import { PageStatus } from './page-status';
import { countsLine, headerLine, PassHeader, type PassHeaderProps } from './pass-header';

const project = projectViewDto({ name: 'ampsio' });
const now = Date.parse(PASS_NOW);

describe('headerLine', () => {
  it.each<{ name: string; statuses: PageStatus[]; line: string }>([
    {
      name: 'nothing counted yet',
      statuses: [PageStatus.NotStarted],
      line: 'ampsio · Settings pass',
    },
    {
      name: 'signed off and ready first, then what else waits or works',
      statuses: [
        PageStatus.Working,
        PageStatus.Ready,
        PageStatus.SignedOff,
        PageStatus.Asks,
        PageStatus.SignedOff,
        PageStatus.Failed,
        PageStatus.Paused,
      ],
      line: 'ampsio · Settings pass · 2 signed off · 1 ready · 1 asking · 1 failed · 2 working',
    },
    {
      name: 'a page that broke the preview, counted after the failures',
      statuses: [PageStatus.PreviewBroken, PageStatus.Ready],
      line: 'ampsio · Settings pass · 1 ready · 1 preview broken',
    },
    {
      name: 'signing off, counted with it',
      statuses: [PageStatus.SigningOff, PageStatus.Waiting],
      line: 'ampsio · Settings pass · 2 signing off',
    },
  ])('$name', ({ statuses, line }) => {
    expect(headerLine('ampsio', 'Settings pass', statuses)).toBe(line);
  });
});

describe('countsLine', () => {
  it('is the counts alone, empty when nothing counts', () => {
    expect(countsLine([PageStatus.NotStarted])).toBe('');
    expect(countsLine([PageStatus.Ready, PageStatus.Working, PageStatus.Ready])).toBe(
      '2 ready · 1 working',
    );
  });
});

function draw(view: PassViewDto, overrides: Partial<PassHeaderProps> = {}, panelShown = false) {
  const props: PassHeaderProps = {
    project,
    view,
    inbox: [],
    now,
    pullRequest: <button type="button">Open Pull Request</button>,
    pullRequestReason: <p>ampsio has no origin</p>,
    onClose: vi.fn(),
    onRename: vi.fn(),
    onAbandon: vi.fn(),
    ...overrides,
  };
  renderWithTheme(
    <FrameSlots panelShown={panelShown}>
      <PassHeader {...props} />
    </FrameSlots>,
  );
  return props;
}

const menu = () => screen.getByRole('button', { name: 'More actions' });

describe('PassHeader', () => {
  it("says the project, the pass and its counts, with the pass's own actions", async () => {
    const { ready, working } = pagesByStatus();
    const props = draw(passViewDto({ pages: [ready, working] }));
    // The line and the pass's own actions are in the title row.
    const row = within(titleRowOf());
    expect(
      row.getByRole('heading', { name: 'ampsio · Settings pass · 1 ready · 1 working' }),
    ).toBeTruthy();
    expect(row.getByRole('button', { name: 'More actions' })).toBeTruthy();
    // No page is signed off, so there is nothing to open a pull request for.
    expect(screen.queryByRole('button', { name: 'Open Pull Request' })).toBeNull();
    expect(screen.queryByText('ampsio has no origin')).toBeNull();
    fireEvent.click(menu());
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Finish', hidden: true }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(menu());
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename', hidden: true }));
    expect(props.onRename).toHaveBeenCalledTimes(1);
    fireEvent.click(menu());
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Abandon', hidden: true }));
    expect(props.onAbandon).toHaveBeenCalledTimes(1);
  });

  it('leaves the pass line and its menu to the panel while the frame draws it, and keeps the timing hint', () => {
    const { ready } = pagesByStatus();
    const readyFor = () => ({
      ...ready,
      taskId: mintId('Task'),
      turn: ready.turn && { ...ready.turn, readyAt: minutesBeforeNow(15) },
    });
    draw(passViewDto({ pages: [readyFor(), readyFor()] }), {}, true);
    expect(within(titleRowOf()).queryByRole('heading')).toBeNull();
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
    expect(screen.queryByText('ampsio has no origin')).toBeNull();
    expect(screen.getByText('2 pages have been ready for over 10 minutes')).toBeTruthy();
  });

  it('draws the pass line itself while the panel is shown and the pass has no page to name', () => {
    draw(passViewDto({ pages: [] }), {}, true);
    expect(
      within(titleRowOf()).getByRole('heading', { name: 'ampsio · Settings pass' }),
    ).toBeTruthy();
    expect(within(titleRowOf()).getByRole('button', { name: 'More actions' })).toBeTruthy();
  });

  it('shows Open Pull Request, and why it is not offered, once a page is signed off', () => {
    const { ready, working } = pagesByStatus();
    draw(passViewDto({ pages: [ready, { ...working, signOff: 'done' }] }));
    expect(screen.getByRole('button', { name: 'Open Pull Request' })).toBeTruthy();
    expect(screen.getByText('ampsio has no origin')).toBeTruthy();
  });

  it.each([
    { name: 'two pages ready for long', minutes: 15, hint: true },
    { name: 'two pages ready a moment ago', minutes: 3, hint: false },
  ])(
    'says the timing hint under the line only when it has something: $name',
    ({ minutes, hint }) => {
      const readyFor = () => {
        const { ready } = pagesByStatus();
        return {
          ...ready,
          turn: ready.turn && { ...ready.turn, readyAt: minutesBeforeNow(minutes) },
        };
      };
      draw(passViewDto({ pages: [readyFor(), readyFor()] }));
      expect(screen.queryByText('2 pages have been ready for over 10 minutes') !== null).toBe(hint);
    },
  );

  it('while closing, says so, holds the page actions and keeps Abandon in reach', async () => {
    const { ready } = pagesByStatus();
    const props = draw(
      passViewDto({ pass: { state: 'CLOSING' }, pages: [ready], rest: { closeStep: 4 } }),
    );
    // The project delivers locally with a gate, so the gate runs in its folder next.
    expect(
      within(screen.getByRole('status')).getByText('Running the gate in your folder…'),
    ).toBeTruthy();
    fireEvent.click(menu());
    const close = await screen.findByRole('menuitem', { name: 'Finish', hidden: true });
    expect(close.hasAttribute('disabled')).toBe(true);
    const abandon = await screen.findByRole('menuitem', { name: 'Abandon', hidden: true });
    expect(abandon.hasAttribute('disabled')).toBe(false);
    fireEvent.click(abandon);
    expect(props.onAbandon).toHaveBeenCalledTimes(1);
  });

  it.each<{ name: string; notice: PassNotice; underWay: boolean }>([
    {
      name: 'its close stopped on an error, shows no step under way',
      notice: {
        id: 'close',
        kind: 'close',
        text: "The close stopped while taking out pages. 10db's log has the detail.",
        sendable: false,
        cardId: null,
        at: PASS_NOW,
      },
      underWay: false,
    },
    {
      name: 'its pull request could not be made ready, still shows the step under way',
      notice: {
        id: 'close-pr-ready',
        kind: 'pr_not_opened',
        text: "The pass's branch is pushed, but its pull request could not be made ready for review.",
        sendable: false,
        cardId: null,
        at: PASS_NOW,
      },
      underWay: true,
    },
    {
      name: 'its follow-on pull request did not open, still shows the step under way',
      notice: {
        id: 'follow-on',
        kind: 'pr_not_opened',
        text: 'The pull request merged while the pass was open, and the pages did not reach a follow-on pull request.',
        sendable: false,
        cardId: null,
        at: PASS_NOW,
      },
      underWay: true,
    },
  ])('while closing with a notice that $name', ({ notice, underWay }) => {
    const { ready } = pagesByStatus();
    draw(
      passViewDto({
        pass: { state: 'CLOSING' },
        pages: [ready],
        rest: { closeStep: 4, notices: [notice] },
      }),
    );
    expect(screen.queryAllByText('Running the gate in your folder…').length > 0).toBe(underWay);
  });

  it('while abandoning, keeps Abandon in reach, so a stalled Abandon can be asked again', async () => {
    const { ready } = pagesByStatus();
    const props = draw(passViewDto({ pass: { state: 'ABANDONING' }, pages: [ready] }));
    fireEvent.click(menu());
    const abandon = await screen.findByRole('menuitem', { name: 'Abandon', hidden: true });
    expect(abandon.hasAttribute('disabled')).toBe(false);
    fireEvent.click(abandon);
    expect(props.onAbandon).toHaveBeenCalledTimes(1);
  });
});
