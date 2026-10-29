import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { baseHandlers, renderWithDaemon, server } from '../../test/daemon';
import { LabelWithHelp } from './field-help';

describe('LabelWithHelp', () => {
  it('shows its help on hover and names the icon for screen readers', async () => {
    server.use(...baseHandlers());
    renderWithDaemon(
      <LabelWithHelp label="Acceptance criteria">
        <span>Each one is checked.</span>
      </LabelWithHelp>,
    );

    expect(await screen.findByText('Acceptance criteria')).toBeTruthy();
    const icon = screen.getByText('About acceptance criteria').parentElement;
    if (!icon) throw new Error('expected the help icon');
    expect(screen.queryByText('Each one is checked.')).toBeNull();

    fireEvent.mouseEnter(icon);
    expect(await screen.findByText('Each one is checked.')).toBeTruthy();
  });
});
