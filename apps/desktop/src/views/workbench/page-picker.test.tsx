import type { AreaDef, PassStartDto } from '@10db/contracts';
import { fireEvent, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { openOptions, optionIn, pickOption, pillsOf } from '../../test/combobox';
import { minutesBeforeNow, PASS_NOW, passStartDto } from '../../test/pass-fixtures';
import { taskDto } from '../../test/fixtures';
import { renderWithTheme } from '../../test/theme';
import { PagePicker } from './page-picker';
import { joinableTasks, type PickTicks } from './start-pass-rules';

const areas: AreaDef[] = [
  { name: 'settings', globs: ['src/settings/**'], role: 'page', route: '/settings' },
  { name: 'people', globs: ['src/people/**'], role: 'page', route: '/people' },
  { name: 'billing', globs: ['src/billing/**'], role: 'page' },
  {
    name: 'forms',
    globs: ['src/**/form.tsx'],
    role: 'page',
    route: '/forms',
    label: 'Sign-up form',
  },
  { name: 'src', globs: ['src/**'], role: 'shared' },
];
const start: PassStartDto = passStartDto({
  pages: [
    ['settings', 'Settings', '/settings', 60 * 24],
    ['people', 'People', '/people', 60],
    ['billing', 'Billing', null, null],
    ['forms', 'Sign-up form', '/forms', null],
  ].map(([area, label, route, ago]) => ({
    area: String(area),
    label: String(label),
    route: typeof route === 'string' ? route : null,
    lastChangedAt: typeof ago === 'number' ? minutesBeforeNow(ago) : null,
    uncommitted: 0,
    heldBy: null,
  })),
});
const peopleTask = taskDto({
  title: 'feat: people list',
  headline: 'The people list breathes',
  areas: ['people'],
});

function Harness() {
  const [ticks, setTicks] = useState<PickTicks>({ pages: [], tasks: [] });
  return (
    <PagePicker
      pages={start.pages}
      tasks={joinableTasks([peopleTask], areas)}
      areas={areas}
      ticks={ticks}
      onTicks={setTicks}
      now={Date.parse(PASS_NOW)}
    />
  );
}

const input = () => screen.getByLabelText('Pages', { selector: 'input' });
function search(text: string) {
  input().focus();
  fireEvent.change(input(), { target: { value: text } });
}

describe('PagePicker', () => {
  it('offers every page with its route and last change, then the open UI tasks, in one search', async () => {
    renderWithTheme(<Harness />);
    const list = await openOptions(input());
    expect(optionIn(list, /^settings/i).textContent).toContain('/settings');
    expect(optionIn(list, /^settings/i).textContent).toContain('changed 1d ago');
    expect(optionIn(list, /^billing/i).textContent).toContain('No route');
    expect(optionIn(list, /^billing/i).textContent).toContain('no changes yet');
    expect(within(list).getByText('Open UI tasks')).toBeTruthy();
  });

  it('shows what is picked as pills and marks it with a check, and disables what shares a file', async () => {
    renderWithTheme(<Harness />);
    await pickOption(input(), /^settings/i);
    expect(within(pillsOf(input())).getByText('/settings')).toBeTruthy();
    const list = await openOptions(input());
    expect(within(optionIn(list, /^settings/i)).queryByLabelText('Picked')).not.toBeNull();
    const forms = optionIn(list, /^sign-up form/i);
    expect(forms.hasAttribute('data-combobox-disabled')).toBe(true);
    expect(forms.textContent).toContain(
      'Settings can share a file with it: src/settings/** and src/**/form.tsx both match one',
    );
  });

  it('finds a page by its route or label, and a task by the pages it works on', async () => {
    renderWithTheme(<Harness />);
    search('peo');
    let list = await openOptions(input());
    expect(within(list).queryByRole('option', { name: /^settings/i, hidden: true })).toBeNull();
    expect(optionIn(list, /^people/i)).toBeTruthy();
    expect(optionIn(list, /^The people list breathes/)).toBeTruthy();
    search('/sett');
    list = await openOptions(input());
    expect(optionIn(list, /^settings/i)).toBeTruthy();
    search('sign-up');
    list = await openOptions(input());
    expect(optionIn(list, /^sign-up form/i).textContent).toContain('/forms');
    search('forms');
    list = await openOptions(input());
    expect(optionIn(list, /^sign-up form/i)).toBeTruthy();
  });
});
