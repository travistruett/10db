import { fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { renderWithTheme } from '../test/theme';
import { TodoList, type TodoStep } from './todo-list';

const LIST: TodoStep[] = [
  { text: 'Read', status: 'completed' },
  { text: 'Write', status: 'in_progress' },
];

/** A list the agent rewrites when "Next list" is pressed. */
function Rewriting() {
  const [steps, setSteps] = useState(LIST);
  return (
    <>
      <button
        onClick={() => {
          setSteps([...LIST, { text: 'Test', status: 'pending' }]);
        }}
      >
        Next list
      </button>
      <button
        onClick={() => {
          setSteps(LIST.map((step) => ({ ...step, status: 'pending' as const })));
        }}
      >
        Reset statuses
      </button>
      <TodoList steps={steps} working />
    </>
  );
}

describe('TodoList', () => {
  it('opens again when a new list arrives after the builder folded the last', () => {
    renderWithTheme(<Rewriting />);
    const fold = (): HTMLElement => screen.getByRole('button', { name: /^Plan/ });
    expect(fold().getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(fold());
    expect(fold().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Next list' }));
    expect(fold().getAttribute('aria-expanded')).toBe('true');
  });

  it('starts folded while a card waits on the builder, and opens when the builder opens it', () => {
    renderWithTheme(<TodoList steps={LIST} working cardWaiting />);
    const fold = screen.getByRole('button', { name: /^Plan/ });
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(fold);
    expect(fold.getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps the builder’s fold through a status change', () => {
    renderWithTheme(<Rewriting />);
    const fold = screen.getByRole('button', { name: /^Plan/ });
    fireEvent.click(fold);
    fireEvent.click(screen.getByRole('button', { name: 'Reset statuses' }));
    expect(screen.getByRole('button', { name: /^Plan/ }).getAttribute('aria-expanded')).toBe(
      'false',
    );
  });
});
