import { JudgeKind } from '@10db/contracts';
import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { cssVariablesResolver, theme } from '../theme';
import { JudgeLine } from './judge-line';

// Sessions UI spec §11: only a session judged by 10db's rules says how it is judged.

const RULES_LINE =
  'Judged by 10db’s rules. Add an OpenRouter key in Settings › Decisions for 10db’s judge.';

describe('JudgeLine', () => {
  it.each([
    { judge: JudgeKind.Native, words: '' },
    { judge: JudgeKind.Tendb, words: '' },
    { judge: JudgeKind.Rules, words: RULES_LINE },
  ])('$judge says "$words"', ({ judge, words }) => {
    render(
      <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver}>
        <div data-testid="line">
          <JudgeLine judge={judge} />
        </div>
      </MantineProvider>,
    );
    expect(screen.getByTestId('line').textContent.trim()).toBe(words);
  });
});
