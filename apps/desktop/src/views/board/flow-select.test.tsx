import type { FlowId } from '@10db/contracts';
import { fireEvent, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../../test/daemon';
import { flowDto } from '../../test/fixtures';
import { FlowSelect, flowTitle } from './flow-select';

describe('flowTitle', () => {
  it.each([
    ['quick', 'Quick'],
    ['plan-first', 'Plan First'],
    ['thorough', 'Thorough'],
  ])('%s reads as %s', (name, title) => {
    expect(flowTitle(name)).toBe(title);
  });
});

describe('FlowSelect', () => {
  it('orders flows by step count and shows steps as a byline', async () => {
    const quick = flowDto({
      name: 'quick',
      steps: [
        { role: 'implement', need: 40, skip: [], persona: null },
        { role: 'review', need: 40, skip: [], persona: null },
      ],
    });
    const full = flowDto({
      name: 'plan-first',
      steps: [
        { role: 'plan', need: 40, skip: [], persona: null },
        { role: 'implement', need: 40, skip: [], persona: null },
        { role: 'review', need: 40, skip: [], persona: null },
      ],
    });
    server.use(
      http.get(daemonUrl('/flows'), () => HttpResponse.json([full, quick])),
      ...baseHandlers(),
    );
    const picked: (FlowId | null)[] = [];
    renderWithDaemon(
      <FlowSelect
        label="Flow"
        value={null}
        onChange={(id) => {
          picked.push(id);
        }}
      />,
    );

    fireEvent.click(await screen.findByRole('combobox', { name: 'Flow' }));
    const options = await screen.findAllByRole('option', { hidden: true });
    expect(options.map((o) => o.textContent)).toEqual([
      'QuickBuild → Review',
      'Plan FirstPlan → Build → Review',
    ]);

    const [, second] = options;
    if (!second) throw new Error('expected two flow options');
    fireEvent.click(second);
    expect(picked).toEqual([full.id]);
  });
});
