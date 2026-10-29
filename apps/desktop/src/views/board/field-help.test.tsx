import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { baseHandlers, renderWithDaemon, server } from '../../test/daemon';
import { LabelWithHelp } from './field-help';

describe('LabelWithHelp', () => {
  it('shows its help on hover from a named button that is not part of the label', async () => {
    server.use(...baseHandlers());
    renderWithDaemon(
      <LabelWithHelp label="Acceptance criteria" htmlFor="criteria">
        <span>Each one is checked.</span>
      </LabelWithHelp>,
    );

    expect(await screen.findByText('Acceptance criteria')).toBeTruthy();
    const help = screen.getByRole('button', { name: 'About acceptance criteria' });
    expect(help.getAttribute('type')).toBe('button');
    expect(screen.queryByText('Each one is checked.')).toBeNull();

    fireEvent.mouseEnter(help);
    expect(await screen.findByText('Each one is checked.')).toBeTruthy();
  });

  it('keeps the button out of the label so the field name is only the label', async () => {
    server.use(...baseHandlers());
    renderWithDaemon(
      <>
        <LabelWithHelp label="Acceptance criteria" htmlFor="criteria">
          <span>Each one is checked.</span>
        </LabelWithHelp>
        <textarea id="criteria" />
      </>,
    );
    const field = await screen.findByRole('textbox', { name: 'Acceptance criteria' });
    expect(field).toBeTruthy();
    const help = screen.getByRole('button', { name: 'About acceptance criteria' });
    expect(help.closest('label')).toBeNull();
  });
});
