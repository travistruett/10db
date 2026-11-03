import { mintId, type ShapeViewDto } from '@10db/contracts';
import { fireEvent, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { projectViewDto } from '../../test/fixtures';
import {
  EMPTY_PREVIEW,
  looseTaskProposal,
  previewDto,
  shapeDto,
  shapeMessageDto,
  shapeViewDto,
} from '../../test/shape-fixtures';

// Shape spec §10.2: the factory preview under the Proposed list. Work already running or queued holds
// its lane first; the critical path is blue; a clash is a dimmed line with arrows-split, no status color.

const project = projectViewDto();

function open(view: ShapeViewDto): void {
  server.use(
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    http.get(daemonUrl('/projects/:projectId/shapes'), () => HttpResponse.json([view.shape])),
    http.get(daemonUrl('/shapes/:shapeId'), () => HttpResponse.json(view)),
    ...baseHandlers(),
  );
  renderApp(`/shape/${view.shape.id}`);
}

function proposedWith(preview: ShapeViewDto['preview']): ShapeViewDto {
  const shape = shapeDto({
    projectId: project.id,
    state: 'proposed',
    proposeUnlocked: true,
    round: 1,
  });
  return shapeViewDto({
    shape,
    messages: [shapeMessageDto(shape.id)],
    proposals: [looseTaskProposal('density', { title: 'Compact density' })],
    preview,
  });
}

describe('Shape: the factory preview', () => {
  it('shows each lane with the work already in the factory first, marked so', async () => {
    open(proposedWith(previewDto()));
    const panel = await screen.findByRole('region', { name: 'Factory preview' });
    const lanes = within(panel).getAllByRole('list');
    expect(lanes).toHaveLength(2);
    const [laneOne] = lanes;
    if (laneOne === undefined) throw new Error('no lane');
    const first = within(laneOne).getAllByRole('listitem');
    expect(first.map((item) => item.textContent)).toEqual([
      expect.stringMatching(/^Fix the gate log.*already in the factory/),
      expect.stringContaining('Compact density'),
      expect.stringContaining('Shape view'),
    ]);
  });

  it('marks the critical path in blue, and only it', async () => {
    open(proposedWith(previewDto()));
    const panel = await screen.findByRole('region', { name: 'Factory preview' });
    const critical = within(panel)
      .getAllByRole('listitem')
      .filter((item) => item.dataset['critical'] === 'true')
      .map((item) => item.dataset['key']);
    expect(critical).toEqual(['tsk_running', 'density', 'shape-view']);
    const bar = within(panel).getByText('Compact density').closest('li');
    expect(bar?.getAttribute('style')).toContain('var(--mantine-color-blue');
    const beside = within(panel).getByText('Thin scrollbars').closest('li');
    expect(beside?.getAttribute('style') ?? '').not.toContain('blue');
    expect(
      within(panel).getByText(/Critical path: Fix the gate log → Compact density → Shape view/),
    ).toBeTruthy();
  });

  it('says a clash as a dimmed line with the arrows-split icon and no status color', async () => {
    open(proposedWith(previewDto()));
    const panel = await screen.findByRole('region', { name: 'Factory preview' });
    const clash = within(panel).getByText(
      "Compact density and Shape view both claim `desktop`: they'll run one after the other",
    );
    const line = clash.closest('[data-clash]');
    expect(line).not.toBeNull();
    expect(line?.querySelector('svg.tabler-icon-arrows-split')).not.toBeNull();
    expect(clash.getAttribute('data-variant') ?? clash.className).not.toMatch(/red|yellow|orange/);
  });

  it('gives the total in lane hours and the end marked as an estimate', async () => {
    open(proposedWith(previewDto()));
    const panel = await screen.findByRole('region', { name: 'Factory preview' });
    expect(
      within(panel).getByText('3 tasks · 4.5 lane hours · ends in about 9 h (estimate)'),
    ).toBeTruthy();
  });

  it('counts the pull requests and CI runs the landings save, against one each', async () => {
    open(
      proposedWith({
        ...previewDto(),
        landings: { pullRequests: 4, pullRequestsAlone: 9, ciRuns: 4, ciRunsAlone: 9 },
      }),
    );
    const panel = await screen.findByRole('region', { name: 'Factory preview' });
    expect(
      within(panel).getByText('4 pull requests instead of 9 · 4 CI runs instead of 9'),
    ).toBeTruthy();
  });

  it('counts the pull requests plainly when no landing saves any', async () => {
    open(
      proposedWith({
        ...previewDto(),
        landings: { pullRequests: 1, pullRequestsAlone: 1, ciRuns: 1, ciRunsAlone: 1 },
      }),
    );
    const panel = await screen.findByRole('region', { name: 'Factory preview' });
    expect(within(panel).getByText('1 pull request · 1 CI run')).toBeTruthy();
  });

  it('shows an opened row its mockup, in the sandboxed frame', async () => {
    const view = proposedWith(EMPTY_PREVIEW);
    open({
      ...view,
      attachments: [
        {
          id: mintId('ShapeAttachment'),
          key: 'density',
          goalId: null,
          taskId: null,
          attachment: { kind: 'mockup', html: '<p>Cards</p><script>alert(1)</script>' },
        },
      ],
    });
    const row = await screen.findByRole('button', { name: /^Compact density/ });
    expect(screen.queryByTitle('Mockup: Compact density')).toBeNull();
    fireEvent.click(row);
    const frame = await screen.findByTitle('Mockup: Compact density');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(document.querySelectorAll('script')).toHaveLength(0);
  });

  it('shows nothing while no task is placed', async () => {
    open(proposedWith(EMPTY_PREVIEW));
    await screen.findByText('Compact density');
    expect(screen.queryByRole('region', { name: 'Factory preview' })).toBeNull();
  });
});
