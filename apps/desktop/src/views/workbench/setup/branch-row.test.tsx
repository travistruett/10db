import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithTheme } from '../../../test/theme';
import { BranchRow } from './branch-row';

const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(() => {
  writeText.mockClear();
  if (original) Object.defineProperty(navigator, 'clipboard', original);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

describe('BranchRow', () => {
  it('says what origin lacks and copies the push command, never running it', async () => {
    renderWithTheme(
      <BranchRow note={{ branch: 'build', ahead: 39, command: 'git push origin build' }} />,
    );
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === 'P' &&
          el.textContent === 'build has 39 commits origin lacks: a pull request would carry them.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('git push origin build')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy command' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('git push origin build');
    });
  });

  it('says one commit', () => {
    renderWithTheme(
      <BranchRow note={{ branch: 'main', ahead: 1, command: 'git push origin main' }} />,
    );
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === 'P' &&
          el.textContent === 'main has 1 commit origin lacks: a pull request would carry it.',
      ),
    ).toBeTruthy();
  });
});
