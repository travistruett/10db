import type { ShapeProposalDto, ShapeViewDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse, type RequestHandler, type WebSocketHandler } from 'msw';
import { expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { projectViewDto } from '../../test/fixtures';
import { goalProposal, shapeDto, shapeMessageDto, shapeViewDto } from '../../test/shape-fixtures';

// Shape spec §7: ceremony, reviewers' findings and the implementer rehearsal, as the builder meets them.

const project = projectViewDto();

function serve(view: ShapeViewDto, ...overrides: (RequestHandler | WebSocketHandler)[]): void {
  server.use(
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    http.get(daemonUrl('/projects/:projectId/shapes'), () => HttpResponse.json([view.shape])),
    http.get(daemonUrl('/shapes/:shapeId'), () => HttpResponse.json(view)),
    ...overrides,
    ...baseHandlers(),
  );
}

function proposed(
  proposals: readonly ShapeProposalDto[],
  extra: Partial<ShapeViewDto> = {},
): ShapeViewDto {
  const shape = shapeDto({
    projectId: project.id,
    state: 'proposed',
    proposeUnlocked: true,
    round: 1,
  });
  return shapeViewDto({
    shape,
    messages: [shapeMessageDto(shape.id)],
    proposals: [...proposals],
    ...extra,
  });
}

/** One mark per task of the proposal: read at its current content, or not. */
const marks = (row: ShapeProposalDto, rehearsed: boolean): ShapeViewDto['rehearsals'] =>
  (row.kind === 'goal' ? row.body.tasks.map((t) => t.key) : [row.key]).map((key) => ({
    proposalId: row.id,
    key,
    hash: `hash-${key}`,
    rehearsed,
  }));

async function openConvert(): Promise<HTMLElement> {
  const button = await screen.findByRole('button', { name: 'Accept' });
  await waitFor(() => {
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
  fireEvent.click(button);
  return screen.findByRole('dialog', { name: 'Accept' });
}

it('asks for a rehearsal once when Accept opens with an unrehearsed task', async () => {
  const goal = goalProposal('brainstorm', ['one', 'two']);
  const view = proposed([goal], { rehearsals: marks(goal, false) });
  const posted: unknown[] = [];
  serve(
    view,
    http.post(daemonUrl('/shapes/:shapeId/rehearse'), async ({ request }) => {
      posted.push(await request.json());
      return HttpResponse.json({ status: 'started', tasks: 2 });
    }),
  );
  renderApp(`/shape/${view.shape.id}`);
  const dialog = await openConvert();
  await waitFor(() => {
    expect(posted).toEqual([{ proposalIds: [goal.id] }]);
  });
  expect(within(dialog).getAllByText(/Not rehearsed/)).toHaveLength(2);
  // The refetch after the request must not ask again.
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(posted).toHaveLength(1);
});
