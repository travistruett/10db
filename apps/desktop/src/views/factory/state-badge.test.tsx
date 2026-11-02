import { WorkstreamState } from '@10db/contracts';
import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { theme } from '../../theme';
import { StateBadge } from './state-badge';
import { STATE_LABELS } from './workstream-state';

describe('StateBadge', () => {
  // Mantine's Badge clips to an ellipsis ("FAI…") once its table column is squeezed. jsdom does no
  // layout, so this pins the style that stops the clipping: the badge neither clips nor wraps.
  it.each(Object.values(WorkstreamState))(
    'shows the whole label of %s, unclipped and on one line',
    (state) => {
      render(
        <MantineProvider theme={theme}>
          <StateBadge state={state} />
        </MantineProvider>,
      );
      const badge = screen
        .getByText(STATE_LABELS[state])
        .closest<HTMLElement>('.mantine-Badge-root');
      expect(badge).not.toBeNull();
      expect(badge?.style.overflow).toBe('visible');
      expect(badge?.style.textOverflow).toBe('clip');
      expect(badge?.style.whiteSpace).toBe('nowrap');
    },
  );
});
