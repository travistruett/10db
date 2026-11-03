import { mintId } from '@10db/contracts';
import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { shapeMessageDto } from '../../test/shape-fixtures';
import { cssVariablesResolver, theme } from '../../theme';
import { Transcript } from './transcript';

// Shape spec §4: a long conversation draws only what is near the viewport.

describe('Transcript', () => {
  it('lets the browser skip every off-screen block of a 2,000-message conversation', () => {
    const shapeId = mintId('Shape');
    const messages = Array.from({ length: 2000 }, (_, i) =>
      shapeMessageDto(shapeId, {
        author: i % 2 === 0 ? 'builder' : 'claude',
        body: `Message ${String(i)}`,
      }),
    );
    render(
      <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver}>
        <Transcript messages={messages} why={null} />
      </MantineProvider>,
    );
    const blocks = screen
      .getByRole('group', { name: 'Messages' })
      .querySelectorAll<HTMLElement>('[data-message-id]');
    expect(blocks).toHaveLength(2000);
    for (const block of blocks) {
      expect(block.style.contentVisibility).toBe('auto');
      expect(block.style.containIntrinsicSize).toBe('auto 40px');
    }
  });
});
