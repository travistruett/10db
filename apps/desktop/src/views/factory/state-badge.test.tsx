import { WorkstreamState } from '@10db/contracts';
import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { theme } from '../../theme';
import { StateBadge } from './state-badge';
import { STATE_LABELS } from './workstream-state';

describe('StateBadge', () => {
  // Mantine's Badge root is an `inline-grid` and its label span (`.mantine-Badge-label`) is
  // `overflow: hidden; text-overflow: ellipsis`. A scroll-container grid item has an automatic
  // minimum width of 0, so an auto-layout table can squeeze the badge's track below the text and
  // the label clips itself to "FAI…". jsdom does no layout, so this pins the two styles that stop
  // that: the root never gets narrower than its content, and the label itself does not clip.
  // Not checked in a real layout engine: the e2e harness (e2e/, WebKit against a live daemon) has
  // no Factory fixture with workstreams in every state.
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
      expect(badge?.style.minWidth).toBe('max-content');
      const label = screen.getByText(STATE_LABELS[state]);
      expect(label.classList.contains('mantine-Badge-label')).toBe(true);
      expect(label.style.overflow).toBe('visible');
      expect(label.style.textOverflow).toBe('clip');
    },
  );
});
