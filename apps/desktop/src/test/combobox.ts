import { fireEvent, waitFor, within } from '@testing-library/react';
import { expect } from 'vitest';

/** Opens a Select or MultiSelect and returns the list of options it controls. */
export async function openOptions(input: HTMLElement): Promise<HTMLElement> {
  fireEvent.click(input);
  return waitFor(() => {
    const id = input.getAttribute('aria-controls');
    const list = id === null ? null : document.getElementById(id);
    expect(list).not.toBeNull();
    return list ?? document.body;
  });
}

/** The option whose accessible name matches, in a list `openOptions` returned. */
export const optionIn = (list: HTMLElement, name: RegExp | string): HTMLElement =>
  within(list).getByRole('option', { name, hidden: true });

/** Opens the select and picks the option whose accessible name matches. */
export async function pickOption(input: HTMLElement, name: RegExp | string): Promise<void> {
  fireEvent.click(optionIn(await openOptions(input), name));
}

/** The pills a MultiSelect shows for what is picked, beside its search box. */
export function pillsOf(input: HTMLElement): HTMLElement {
  const pills = input.closest<HTMLElement>('.mantine-MultiSelect-pillsList');
  expect(pills).not.toBeNull();
  return pills ?? document.body;
}

/** The Workbench picker's search box, in the whole screen or one dialog. */
export const findPagesInput = (container: HTMLElement = document.body): Promise<HTMLElement> =>
  within(container).findByLabelText('Pages', { selector: 'input' });
