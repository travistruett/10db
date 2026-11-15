import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { cssVariablesResolver, theme } from '../../theme';
import { AgentsLine } from './agents-line';

// Sessions UI spec §11, design spec S8: Plan on an agent with no subagents (Codex) says it runs without
// its research and review agents.

const WITHOUT = 'Codex has no research or review agents here. This conversation runs without them.';

describe('AgentsLine', () => {
  it.each([
    { subagents: true, words: '' },
    { subagents: false, words: WITHOUT },
  ])('with subagents $subagents says "$words"', ({ subagents, words }) => {
    render(
      <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver}>
        <div data-testid="line">
          <AgentsLine subagents={subagents} agentLabel="Codex" />
        </div>
      </MantineProvider>,
    );
    expect(screen.getByTestId('line').textContent.trim()).toBe(words);
  });
});
