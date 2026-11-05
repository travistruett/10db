import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { theme } from '../../theme';
import { GoalRow } from './goal-row';

function Row() {
  const [expanded, setExpanded] = useState(false);
  return (
    <MantineProvider theme={theme}>
      <GoalRow
        title="Greet the visitor"
        line="Not started"
        expanded={expanded}
        onToggle={() => {
          setExpanded(!expanded);
        }}
      >
        <p>Inside the row</p>
      </GoalRow>
    </MantineProvider>
  );
}

describe('GoalRow', () => {
  // fireEvent.click moves no focus, as a click on a button doesn't in macOS WebKit, the app's window.
  it('closes on Escape after a click that gave the button no focus of its own', () => {
    render(<Row />);
    const button = screen.getByRole('button', { name: /Greet the visitor/ });

    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(button);

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });
});
