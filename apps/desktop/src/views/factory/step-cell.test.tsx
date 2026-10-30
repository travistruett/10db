import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import type { WorkstreamStep } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { workstreamDto } from '../../test/fixtures';
import { theme } from '../../theme';
import { StepCell } from './step-cell';

const step = (
  role: 'implement' | 'review',
  personaName: string,
  model: string,
  effort: 'medium' | 'high',
  attempts = 0,
): WorkstreamStep => ({
  role,
  personaId: null,
  personaName,
  tools: role === 'implement' ? 'edit' : 'read_only',
  score: role === 'implement' ? 'coding' : 'intelligence',
  profileId: null,
  model,
  effort,
  need: 40,
  reason: 'cheapest profile at or above 40 coding',
  overBudget: false,
  pinned: false,
  status: 'running',
  attempts,
  startedAt: null,
  sessionFloor: 0,
  result: null,
  earlier: [],
  sentBack: 0,
});

function show(ws: ReturnType<typeof workstreamDto>) {
  render(
    <MantineProvider theme={theme}>
      <StepCell workstream={ws} />
    </MantineProvider>,
  );
}

describe('StepCell', () => {
  it.each([
    {
      name: 'the step, its persona and its profile',
      ws: workstreamDto({
        steps: [
          step('implement', 'Implementer', 'sonnet', 'medium'),
          step('review', 'Reviewer', 'sonnet', 'high'),
        ],
        stepIndex: 1,
      }),
      texts: ['2/2 review', 'Reviewer · sonnet@high'],
      noRetry: true,
    },
    {
      name: 'a retry count once a step was sent back',
      ws: workstreamDto({
        steps: [step('implement', 'Implementer', 'sonnet', 'high', 2)],
        stepIndex: 0,
      }),
      texts: ['1/1 implement', 'Implementer · sonnet@high', 'retry 2'],
      badge: 'retry 2',
    },
    {
      name: 'a workstream started before flows as its model alone',
      ws: workstreamDto({ steps: [], stepIndex: 0, model: 'opus', effort: 'high' }),
      texts: ['opus@high'],
    },
  ])('shows $name', ({ ws, texts, noRetry, badge }) => {
    show(ws);
    for (const text of texts) expect(screen.getByText(text)).toBeTruthy();
    // The light badge takes the theme's AA-checked text color; plain orange text misses AA in light mode.
    if (badge) expect(screen.getByText(badge).closest('.mantine-Badge-root')).not.toBeNull();
    if (noRetry) expect(screen.queryByText(/retry/)).toBeNull();
  });

  it("carries the router's reason as the tooltip of the step label", () => {
    show(
      workstreamDto({
        steps: [step('implement', 'Implementer', 'sonnet', 'medium')],
        stepIndex: 0,
      }),
    );
    expect(screen.getByText('Implementer · sonnet@medium').getAttribute('title')).toBe(
      'cheapest profile at or above 40 coding',
    );
  });
});
