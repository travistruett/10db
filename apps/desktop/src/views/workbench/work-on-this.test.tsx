import { mintId, type AreaDef } from '@10db/contracts';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { taskDto } from '../../test/fixtures';
import { goalPassPagesDto } from '../../test/pass-fixtures';
import { renderWithRouter } from '../../test/theme';
import { WorkOnThis } from './work-on-this';

const areas: AreaDef[] = [
  { name: 'settings', globs: ['src/settings/**'], role: 'page', route: '/settings' },
];
const goalId = mintId('Goal');
const done = taskDto({ areas: ['settings'], boardStatus: 'done', status: 'done' });
const running = taskDto({ areas: ['settings'], boardStatus: 'in_progress' });
const waiting = taskDto({ areas: ['settings'], boardStatus: 'ready' });

describe('WorkOnThis', () => {
  it("opens the Workbench on the goal's pages once its UI work is nearly done", async () => {
    const { router } = await renderWithRouter(
      <WorkOnThis
        goalId={goalId}
        passPages={goalPassPagesDto({ pages: ['settings'] })}
        tasks={[done, running]}
        areas={areas}
      />,
    );
    fireEvent.click(screen.getByRole('link', { name: 'Work on This' }));
    expect(router.state.location.pathname).toBe('/workbench');
    expect(router.state.location.search).toEqual({ goal: goalId });
  });

  it.each([
    { name: 'its tasks committed in no page', pages: [], tasks: [done, running] },
    { name: 'two UI tasks are still to go', pages: ['settings'], tasks: [done, running, waiting] },
  ])('offers nothing when $name', async ({ pages, tasks }) => {
    await renderWithRouter(
      <WorkOnThis
        goalId={goalId}
        passPages={goalPassPagesDto({ pages })}
        tasks={tasks}
        areas={areas}
      />,
    );
    expect(screen.queryByRole('link', { name: 'Work on This' })).toBeNull();
  });
});
