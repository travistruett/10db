import type { TaskId } from '@10db/contracts';
import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { baseHandlers, renderWithDaemon, server } from '../../test/daemon';
import { projectViewDto } from '../../test/fixtures';
import {
  askItem,
  PASS_NOW,
  passHandlers,
  pagesByStatus,
  passViewDto,
} from '../../test/pass-fixtures';
import { clockTime } from './page-status';
import { PassWorkspace } from './pass-workspace';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse(PASS_NOW) });
  server.use(...passHandlers(), ...baseHandlers());
});

afterEach(() => {
  vi.useRealTimers();
});

async function renderWorkspace(selected: (pages: Pages) => TaskId | null = () => null) {
  const pages = pagesByStatus();
  const onSelect = vi.fn();
  renderWithDaemon(
    <PassWorkspace
      view={passViewDto({ pages: Object.values(pages) })}
      inbox={[askItem(pages.asks)]}
      project={projectViewDto()}
      selected={selected(pages)}
      onSelect={onSelect}
    />,
  );
  await screen.findByRole('list', { name: 'Pages in this pass' });
  return { pages, onSelect };
}

type Pages = ReturnType<typeof pagesByStatus>;

function queueRows() {
  return within(screen.getByRole('list', { name: 'Pages in this pass' })).getAllByRole('button');
}

describe('PassWorkspace queue', () => {
  it('lists the pages as buttons in queue order, each with its state line', async () => {
    const { pages } = await renderWorkspace();
    expect(queueRows().map((row) => row.textContent)).toEqual([
      'PeopleAsks a question',
      'ReportsThe session kept crashing or could not start.',
      'SettingsReady · 3 min',
      'BillingWorking · 4 min · median 5',
      `TeamPaused: usage limit, resumes ${clockTime(pages.paused.pausedUntil ?? '')}`,
      'HomeNot started',
    ]);
  });

  it('marks the selected page current and selects another on a click', async () => {
    const { pages, onSelect } = await renderWorkspace();
    // Nothing selected: the queue's first row is the one shown.
    expect(queueRows().filter((row) => row.getAttribute('aria-current') === 'true')).toHaveLength(
      1,
    );
    expect(queueRows()[0]?.getAttribute('aria-current')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /^Settings/ }));
    expect(onSelect).toHaveBeenCalledWith(pages.ready.taskId);
  });

  it('draws the selected page as current when the route names it', async () => {
    await renderWorkspace((pages) => pages.working.taskId);
    const current = queueRows().filter((row) => row.getAttribute('aria-current') === 'true');
    expect(current.map((row) => row.textContent)).toEqual(['BillingWorking · 4 min · median 5']);
    const thread = screen.getByRole('region', { name: 'Billing' });
    expect(await within(thread).findByText('Billing is at')).toBeTruthy();
  });

  it('names a page that waits on the builder heavier, and dims the rest', async () => {
    await renderWorkspace();
    const name = (page: string) =>
      within(screen.getByRole('button', { name: new RegExp(`^${page}`) })).getByText(page);
    expect(['Settings', 'People', 'Billing'].map((page) => name(page).style.fontWeight)).toEqual([
      '500',
      '500',
      '400',
    ]);
    const dimmed = queueRows().map((row) =>
      row.style.color === 'var(--mantine-color-dimmed)' ? 'dimmed' : 'plain',
    );
    expect(dimmed).toEqual(['plain', 'plain', 'plain', 'dimmed', 'dimmed', 'dimmed']);
  });
});
