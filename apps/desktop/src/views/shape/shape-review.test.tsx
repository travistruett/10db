import { mintId, type ShapeProposalDto, type ShapeViewDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse, type RequestHandler, type WebSocketHandler } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { projectViewDto } from '../../test/fixtures';
import {
  findingDto,
  goalProposal,
  looseTaskProposal,
  shapeDto,
  shapeMessageDto,
  shapeViewDto,
} from '../../test/shape-fixtures';

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

const open = (view: ShapeViewDto): void => {
  renderApp(`/shape/${view.shape.id}`);
};

async function openConvert(): Promise<HTMLElement> {
  const button = await screen.findByRole('button', { name: 'Convert…' });
  await waitFor(() => {
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
  fireEvent.click(button);
  return screen.findByRole('dialog', { name: 'Convert' });
}

describe('Shape: the implementer rehearsal and Convert', () => {
  it('asks for a rehearsal once when Convert opens with an unrehearsed task', async () => {
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
    open(view);
    const dialog = await openConvert();
    await waitFor(() => {
      expect(posted).toEqual([{ proposalIds: [goal.id] }]);
    });
    expect(within(dialog).getAllByText(/Not rehearsed/)).toHaveLength(2);
    // The refetch after the request must not ask again.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(posted).toHaveLength(1);
  });

  it('does not rehearse a task that already has its mark', async () => {
    const goal = goalProposal('brainstorm', ['one']);
    const view = proposed([goal], { rehearsals: marks(goal, true) });
    const posted: unknown[] = [];
    serve(
      view,
      http.post(daemonUrl('/shapes/:shapeId/rehearse'), async ({ request }) => {
        posted.push(await request.json());
        return HttpResponse.json({ status: 'nothing', tasks: 0 });
      }),
    );
    open(view);
    await openConvert();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(posted).toHaveLength(0);
  });

  it('says how many tasks are being rehearsed, and Convert Anyway stops the turn and converts', async () => {
    const goal = goalProposal('brainstorm', ['one', 'two']);
    const view = proposed([goal], {
      rehearsals: marks(goal, false),
      turn: { running: true, queued: 0, proposing: false, rehearsing: true },
    });
    const converted: unknown[] = [];
    serve(
      view,
      http.post(daemonUrl('/shapes/:shapeId/rehearse'), () =>
        HttpResponse.json({ status: 'running', tasks: 2 }),
      ),
      http.post(daemonUrl('/shapes/:shapeId/convert'), async ({ request }) => {
        converted.push(await request.json());
        return HttpResponse.json({ createdNow: 1, results: [] });
      }),
    );
    open(view);
    const dialog = await openConvert();
    expect(within(dialog).getByText('Rehearsing 2 tasks…')).toBeTruthy();
    // The turn is running, so the plain Convert waits; Convert Anyway does not.
    expect(within(dialog).getByRole('button', { name: 'Convert 1' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Convert Anyway' }));
    await waitFor(() => {
      expect(converted).toEqual([{ proposalIds: [goal.id], interrupt: true }]);
    });
  });

  it('offers no Convert Anyway when no rehearsal is running', async () => {
    const goal = goalProposal('brainstorm', ['one']);
    const view = proposed([goal], { rehearsals: marks(goal, true) });
    serve(view);
    open(view);
    const dialog = await openConvert();
    expect(within(dialog).queryByRole('button', { name: 'Convert Anyway' })).toBeNull();
  });

  it('shows open questions under their task, and warns without blocking Convert', async () => {
    const goal = goalProposal('brainstorm', ['one', 'two']);
    const shapeId = shapeDto({ projectId: project.id }).id;
    const question = findingDto(shapeId, {
      effortKey: 'brainstorm',
      taskKey: 'two',
      reviewer: 'rehearsal',
      kind: 'question',
      severity: null,
      text: 'Which column does a dropped card land in?',
    });
    const view = proposed([goal], { rehearsals: marks(goal, true), findings: [question] });
    serve(view);
    open(view);
    const dialog = await openConvert();
    const asked = within(dialog).getByText(/Which column does a dropped card land in\?/);
    expect(asked.textContent).toContain('two: ');
    expect(within(dialog).getByText('1 rehearsal question is open')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Convert 1' })).toHaveProperty(
      'disabled',
      false,
    );
  });
});

describe('Shape: ceremony and findings under a row', () => {
  const forced = (
    row: ShapeProposalDto,
    change: Partial<ShapeViewDto['ceremony'][number]> = {},
  ): ShapeViewDto['ceremony'] => [
    {
      proposalId: row.id,
      key: row.key,
      ceremony: 'spec',
      reasons: ['loose_l'],
      skippedByYou: false,
      specWritten: false,
      spec: null,
      ...change,
    },
  ];

  it('says why a spec is required, and Skip spec pins the effort to direct', async () => {
    const task = looseTaskProposal('migrate', { title: 'Move the schema' });
    const view = proposed([task], { ceremony: forced(task), rehearsals: marks(task, true) });
    const patched: unknown[] = [];
    serve(
      view,
      http.patch(daemonUrl('/shapes/:shapeId/proposals/:proposalId'), async ({ request }) => {
        patched.push(await request.json());
        return HttpResponse.json(null);
      }),
    );
    open(view);
    expect(await screen.findByText('Spec required: an L task · not written yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Skip spec' }));
    await waitFor(() => {
      expect(patched).toEqual([{ fields: { ceremony: 'direct' } }]);
    });
  });

  it('shows a skipped spec as skipped by you, with Use spec to take it back', async () => {
    const task = looseTaskProposal('migrate', { title: 'Move the schema' });
    const view = proposed([task], {
      ceremony: forced(task, { ceremony: 'direct', skippedByYou: true }),
      rehearsals: marks(task, true),
    });
    const unpinned: unknown[] = [];
    serve(
      view,
      http.post(daemonUrl('/shapes/:shapeId/proposals/:proposalId/unpin'), async ({ request }) => {
        unpinned.push(await request.json());
        return HttpResponse.json(null);
      }),
    );
    open(view);
    expect(await screen.findByText('Spec skipped by you')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use spec' }));
    await waitFor(() => {
      expect(unpinned).toEqual([{ field: 'ceremony' }]);
    });
  });

  it('lists a reviewer’s open finding, and Dismiss posts to the finding', async () => {
    const task = looseTaskProposal('migrate', { title: 'Move the schema' });
    const shapeId = shapeDto({ projectId: project.id }).id;
    const finding = findingDto(shapeId, {
      id: mintId('ShapeFinding'),
      effortKey: 'migrate',
      taskKey: null,
      text: 'Names no migration',
    });
    const view = proposed([task], { findings: [finding], rehearsals: marks(task, true) });
    const dismissed: string[] = [];
    serve(
      view,
      http.post(daemonUrl('/shapes/:shapeId/findings/:findingId/dismiss'), ({ params }) => {
        dismissed.push(String(params['findingId']));
        return HttpResponse.json(null);
      }),
    );
    open(view);
    expect(await screen.findByText(/scope · medium · Names no migration/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss finding: Names no migration' }));
    await waitFor(() => {
      expect(dismissed).toEqual([finding.id]);
    });
  });
});
