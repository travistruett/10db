import { MantineProvider, Menu } from '@mantine/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SplitButton } from './split-button';

function renderButton(onClick: () => void) {
  return render(
    <MantineProvider>
      <SplitButton
        onClick={onClick}
        menuLabel="More actions"
        menu={<Menu.Item>Other thing</Menu.Item>}
      >
        Do it
      </SplitButton>
    </MantineProvider>,
  );
}

describe('SplitButton', () => {
  it('runs the primary action', () => {
    const onClick = vi.fn();
    renderButton(onClick);
    fireEvent.click(screen.getByRole('button', { name: 'Do it' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('opens the menu from the chevron named by menuLabel', async () => {
    const onClick = vi.fn();
    renderButton(onClick);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Other thing' })).toBeTruthy();
    expect(onClick).not.toHaveBeenCalled();
  });
});
