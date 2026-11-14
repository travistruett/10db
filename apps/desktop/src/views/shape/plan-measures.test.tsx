import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { shapeMeasureKeys } from '../../daemon/shape-measures-queries';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../../test/daemon';
import { shapeMeasuresDto } from '../../test/judge-fixtures';
import { PlanMeasures } from './plan-measures';

function serve(options: { readonly measures?: ReturnType<typeof shapeMeasuresDto> } = {}) {
  server.use(
    http.get(daemonUrl('/shape-measures'), () =>
      HttpResponse.json(options.measures ?? shapeMeasuresDto()),
    ),
    ...baseHandlers(),
  );
  renderWithDaemon(<PlanMeasures />);
}

describe('PlanMeasures', () => {
  it('is a section named How Plan is doing, for all projects', async () => {
    serve();
    const section = await screen.findByRole('region', { name: 'How Plan is doing' });
    expect(section.textContent).toContain('All projects');
  });

  it('draws nothing when the measures cannot be read', async () => {
    server.use(
      http.get(daemonUrl('/shape-measures'), () =>
        HttpResponse.json({ message: 'down' }, { status: 500 }),
      ),
      ...baseHandlers(),
    );
    const { queryClient } = renderWithDaemon(<PlanMeasures />);
    await waitFor(() => {
      expect(queryClient.getQueryState(shapeMeasureKeys.measures)?.status).toBe('error');
    });
    expect(screen.queryByRole('region', { name: 'How Plan is doing' })).toBeNull();
  });

  it('shows the Sizing hit rate with n, per bucket, and overrides beside it', async () => {
    serve({
      measures: shapeMeasuresDto({
        sizing: {
          n: 5,
          within: 4,
          buckets: {
            S: { n: 2, within: 2 },
            M: { n: 3, within: 2 },
            L: { n: 0, within: 0 },
            XL: { n: 0, within: 0 },
          },
          overrides: 1,
        },
      }),
    });
    const sizing = await screen.findByRole('group', { name: 'Sizing' });
    expect(sizing.textContent).toContain('80% within one bucket (4 of 5)');
    expect(sizing.textContent).toContain('S 2 of 2');
    expect(sizing.textContent).toContain('M 2 of 3');
    expect(sizing.textContent).toContain('1 set by you, not counted');
  });

  it('says Sizing has nothing to measure until a converted task finishes', async () => {
    serve();
    const sizing = await screen.findByRole('group', { name: 'Sizing' });
    expect(sizing.textContent).toContain('No converted task has finished yet');
  });

  it("shows Inbox question cards per converted task against the project's other tasks (spec §7)", async () => {
    serve({
      measures: shapeMeasuresDto({
        questions: { converted: { tasks: 4, cards: 2 }, other: { tasks: 10, cards: 9 } },
      }),
    });
    const questions = await screen.findByRole('group', { name: 'Questions' });
    expect(questions.textContent).toContain('0.5 question cards per task (4 tasks) converted');
    expect(questions.textContent).toContain(
      "0.9 question cards per task (10 tasks) for the project's other tasks",
    );
  });

  it('says Questions has nothing to measure until a converted task starts', async () => {
    serve();
    const questions = await screen.findByRole('group', { name: 'Questions' });
    expect(questions.textContent).toContain('No converted task has started yet');
  });
});
