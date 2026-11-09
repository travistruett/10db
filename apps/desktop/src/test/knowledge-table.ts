import { fireEvent, screen, waitFor, within } from '@testing-library/react';

/** The first column of every Knowledge list (a principle's or proposal's statement, a decision's question): its filter holds the shelf and the search. */
const FIRST_COLUMN = ['statement', 'question'];
const SCOPE_COLUMN = ['scope'];
const TYPE_COLUMN = ['principleKind'];

/**
 * The filter button in the header of the first column whose accessor is one of `accessors`. A sortable
 * header is a button rather than a column header to assistive tech, so it is found by its accessor; and
 * mantine-datatable gives the filter's button no name, so it is found by its class.
 */
async function filterButton(accessors: readonly string[]): Promise<HTMLElement> {
  return waitFor(() => {
    for (const accessor of accessors) {
      const button = document.querySelector(
        `th[data-accessor="${accessor}"] .mantine-datatable-header-cell-filter-action-icon`,
      );
      if (button instanceof HTMLElement) return button;
    }
    throw new Error(`no filter on ${accessors.join(' or ')}`);
  });
}

/** Opens the first column's filter. */
export async function openColumnFilter(): Promise<void> {
  fireEvent.click(await filterButton(FIRST_COLUMN));
}

/**
 * Opens a column's filter until `shown` finds its control. The button toggles, and a popover that is still
 * leaving the page reads as closed, so one click may close what it meant to open.
 */
async function withFilterOpen(
  column: readonly string[],
  shown: () => HTMLElement | null,
): Promise<HTMLElement> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const found = shown();
    if (found) return found;
    fireEvent.click(await filterButton(column));
    try {
      return await waitFor(() => {
        const el = shown();
        if (el === null) throw new Error('the filter is not open');
        return el;
      });
    } catch {
      // Clicked a popover closed; the next attempt opens it.
    }
  }
  throw new Error(`the ${column.join(' or ')} filter would not open`);
}

/** Types into the search, opening the first column's filter when it is closed. */
export async function typeSearch(value: string): Promise<void> {
  const box = await withFilterOpen(FIRST_COLUMN, () =>
    screen.queryByRole('textbox', { name: 'Search' }),
  );
  fireEvent.change(box, { target: { value } });
}

/** Chooses a shelf (Pending, Current, Past), opening the first column's filter when it is closed. */
export async function chooseShelf(name: string | RegExp): Promise<void> {
  fireEvent.click(await withFilterOpen(FIRST_COLUMN, () => screen.queryByRole('radio', { name })));
}

/** Picks a scope in the Scope column's filter. */
export async function chooseScope(name: string): Promise<void> {
  const input = await withFilterOpen(
    SCOPE_COLUMN,
    () => screen.queryAllByLabelText('Scope').find((el) => el.tagName === 'INPUT') ?? null,
  );
  fireEvent.click(input);
  const id = input.getAttribute('aria-controls');
  const list = await waitFor(() => {
    const el = id === null ? null : document.getElementById(id);
    if (el === null) throw new Error('the scope list is not open');
    return el;
  });
  fireEvent.click(within(list).getByRole('option', { name, hidden: true }));
}

/** Picks each of `names` in the Type column's filter. Its list stays open between picks. */
export async function chooseTypes(names: readonly string[]): Promise<void> {
  const input = await withFilterOpen(
    TYPE_COLUMN,
    () => screen.queryAllByLabelText('Types shown').find((el) => el.tagName === 'INPUT') ?? null,
  );
  const options = () => {
    const id = input.getAttribute('aria-controls');
    return id === null ? null : document.getElementById(id);
  };
  if (options() === null) fireEvent.click(input);
  const list = await waitFor(() => {
    const el = options();
    if (el === null) throw new Error('the type list is not open');
    return el;
  });
  for (const name of names)
    fireEvent.click(within(list).getByRole('option', { name, hidden: true }));
}

/** Sorts the table by the column with this accessor, as a click on its header does. */
export function sortBy(accessor: string): void {
  const header = document.querySelector(`th[data-accessor="${accessor}"]`);
  if (!(header instanceof HTMLElement)) throw new Error(`no column ${accessor}`);
  fireEvent.click(header);
}
