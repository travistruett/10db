import type { PassViewDto } from '@10db/contracts';
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { projectViewDto } from '../../test/fixtures';
import { minutesBeforeNow, PASS_NOW, pagesByStatus, passViewDto } from '../../test/pass-fixtures';
import { renderWithTheme } from '../../test/theme';
import { PageStatus } from './page-status';
import { headerLine, PassHeader, type PassHeaderProps } from './pass-header';

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
      name: 'signing off, counted with it',
      statuses: [PageStatus.SigningOff, PageStatus.Waiting],
      line: 'ampsio · Settings pass · 2 signing off',
    },
  ])('$name', ({ statuses, line }) => {
    expect(headerLine('ampsio', 'Settings pass', statuses)).toBe(line);
  });
});

function draw(view: PassViewDto, overrides: Partial<PassHeaderProps> = {}) {
  const props: PassHeaderProps = {
    project,
    view,
    inbox: [],
    now,
    onAddPage: vi.fn(),
    pullRequest: <button type="button">Open Pull Request</button>,
    pullRequestReason: <p>ampsio has no origin</p>,
    onClose: vi.fn(),
    onRename: vi.fn(),
    onAbandon: vi.fn(),
    ...overrides,
  };
  renderWithTheme(<PassHeader {...props} />);
  return props;
}

const menu = () => screen.getByRole('button', { name: 'More pass actions' });

describe('PassHeader', () => {
  it("says the project, the pass and its counts, with the pass's own actions", async () => {
    const { ready, working } = pagesByStatus();
    const props = draw(passViewDto({ pages: [ready, working] }));
    expect(screen.getByText('ampsio · Settings pass · 1 ready · 1 working')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add Page' }));
    expect(props.onAddPage).toHaveBeenCalledTimes(1);
    // No page is signed off, so there is nothing to open a pull request for.
    expect(screen.queryByRole('button', { name: 'Open Pull Request' })).toBeNull();
    expect(screen.queryByText('ampsio has no origin')).toBeNull();
    fireEvent.click(menu());
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close Pass…', hidden: true }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(menu());
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename', hidden: true }));
    expect(props.onRename).toHaveBeenCalledTimes(1);
    fireEvent.click(menu());
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Abandon Pass…', hidden: true }));
    expect(props.onAbandon).toHaveBeenCalledTimes(1);
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
    expect(screen.getByRole('button', { name: 'Add Page' })).toHaveProperty('disabled', true);
    fireEvent.click(menu());
    const close = await screen.findByRole('menuitem', { name: 'Close Pass…', hidden: true });
    expect(close.hasAttribute('disabled')).toBe(true);
    const abandon = await screen.findByRole('menuitem', { name: 'Abandon Pass…', hidden: true });
    expect(abandon.hasAttribute('disabled')).toBe(false);
    fireEvent.click(abandon);
    expect(props.onAbandon).toHaveBeenCalledTimes(1);
  });

  it('while abandoning, keeps Abandon in reach, so a stalled Abandon can be asked again', async () => {
    const { ready } = pagesByStatus();
    const props = draw(passViewDto({ pass: { state: 'ABANDONING' }, pages: [ready] }));
    fireEvent.click(menu());
    const abandon = await screen.findByRole('menuitem', { name: 'Abandon Pass…', hidden: true });
    expect(abandon.hasAttribute('disabled')).toBe(false);
    fireEvent.click(abandon);
    expect(props.onAbandon).toHaveBeenCalledTimes(1);
  });
});
