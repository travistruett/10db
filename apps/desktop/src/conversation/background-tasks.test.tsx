import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithTheme } from '../test/theme';
import { BackgroundTasks } from './background-tasks';

const CAPS = { backgroundTasks: true, label: 'Claude Code' };

describe('BackgroundTasks', () => {
  it('folds to its heading, and names a backgrounded main session as one', () => {
    renderWithTheme(
      <BackgroundTasks
        capabilities={CAPS}
        tasks={[{ id: 'm', description: 'the build', kind: 'agent', agent: 'main-session' }]}
      />,
    );
    expect(screen.getByText('Main session')).toBeTruthy();
    const fold = screen.getByRole('button', { name: /Running in the background/ });
    fireEvent.click(fold);
    expect(fold.getAttribute('aria-expanded')).toBe('false');
  });
});
