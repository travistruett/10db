import type { GoalDigestDto, GoalSummaryDto } from '@10db/contracts';
import { fireEvent, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, eventStream, renderApp, server } from '../../test/daemon';
import { workstreamDto } from '../../test/fixtures';
import { goalListDto, goalSummaryDto, ungroupedDto } from '../../test/goal-fixtures';

function goal(
  title: string,
  status: GoalDigestDto['status'],
  digest: Partial<GoalDigestDto> = {},
): GoalSummaryDto {
  return goalSummaryDto({ title }, { status, ...digest });
}

/** The titles of the collapsed rows on screen, top to bottom: each row's text starts with its title. */
function rowTitles(known: readonly string[]): (string | undefined)[] {
  return within(screen.getByRole('group', { name: 'Goals' }))
    .getAllByRole('button', { expanded: false })
    .map((row) => known.find((title) => row.textContent.startsWith(title)));
}

describe('FactoryView goal list', () => {
  it('orders goals failed, waiting on you, running, not started, Not in a goal, then Done, all collapsed', async () => {
    const loose = workstreamDto({ taskTitle: 'Loose run', state: 'RUNNING' });
    server.use(
      ...baseHandlers(),
      eventStream.addEventListener('connection', () => undefined),
    );
    server.use(
      http.get(daemonUrl('/projects/:projectId/goals'), () =>
        HttpResponse.json({
          ...goalListDto(
            goal('Finished', 'done'),
            goal('Idle', 'not_started'),
            goal('Busy', 'running'),
            goal('Asking', 'waiting_on_you'),
            goal('Broken', 'failed'),
            goal('Landing', 'shipping', { openPullRequests: 3 }),
          ),
          ungrouped: ungroupedDto({
            workstreams: [
              {
                workstreamId: loose.id,
                taskId: loose.taskId,
                taskTitle: 'Loose run',
                state: 'RUNNING',
              },
            ],
          }),
        }),
      ),
      http.get(daemonUrl('/workstreams'), () => HttpResponse.json([loose])),
    );
    renderApp('/factory');

    await screen.findByRole('button', { name: /^Broken/ });
    expect(
      rowTitles(['Broken', 'Asking', 'Busy', 'Landing', 'Idle', 'Not in a goal', 'Done']),
    ).toEqual(['Broken', 'Asking', 'Busy', 'Landing', 'Idle', 'Not in a goal', 'Done']);
    expect(screen.queryAllByRole('button', { expanded: true })).toEqual([]);
    expect(screen.queryAllByRole('region')).toEqual([]);
    // Done goals sit behind one collapsed line and show once it opens.
    expect(screen.queryByRole('button', { name: /^Finished/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Done/ }));
    expect(screen.getByRole('button', { name: /^Finished/ }).getAttribute('aria-expanded')).toBe(
      'false',
    );
  });
});
