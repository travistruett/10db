import { fireEvent, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { projectViewDto } from '../../test/fixtures';
import {
  decisionProposal,
  goalProposal,
  looseTaskProposal,
  questionProposal,
  shapeDto,
  shapeMessageDto,
  shapeViewDto,
} from '../../test/shape-fixtures';
import { observeWidthsOf, resetObservedWidth } from '../../test/sized-observer';

// Shape spec §4 D1: under 1100 px the Proposed sidebar is a drawer, and each count in the bar's
// summary line opens it at that count's section.

const project = projectViewDto();

/** Under 1100 px the split pane chooses the drawer layout. */
const SPLIT_WIDTH = 900;

beforeEach(() => {
  observeWidthsOf(SPLIT_WIDTH);
});
afterEach(() => {
  resetObservedWidth();
});

it('opens the drawer at the first row of the section a count names', async () => {
  const base = shapeDto({
    projectId: project.id,
    state: 'proposed',
    proposeUnlocked: true,
    round: 1,
  });
  const view = shapeViewDto({
    shape: base,
    messages: [shapeMessageDto(base.id)],
    proposals: [
      goalProposal('brainstorm', ['one', 'two']),
      looseTaskProposal('density', { title: 'Compact card density' }),
      looseTaskProposal('scrollbars', { title: 'Thin board scrollbars' }),
      decisionProposal('replaces-adopt'),
      questionProposal('ship-date'),
    ],
  });
  server.use(
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    http.get(daemonUrl('/projects/:projectId/shapes'), () => HttpResponse.json([view.shape])),
    http.get(daemonUrl('/shapes/:shapeId'), () => HttpResponse.json(view)),
    ...baseHandlers(),
  );
  renderApp(`/shape/${view.shape.id}`);
  const bar = await screen.findByRole('group', { name: 'Summary' });
  expect(screen.queryByRole('region', { name: 'Proposed' })).toBeNull();
  fireEvent.click(within(bar).getByRole('button', { name: '2 loose' }));
  const sidebar = await screen.findByRole('region', { name: 'Proposed' });
  const first = within(sidebar).getByRole('button', { name: /^Compact card density/ });
  expect(document.activeElement).toBe(first);
});
