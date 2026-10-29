import { KeepAwakeStatus } from '@10db/contracts';
import { fireEvent, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../test/daemon';

describe('KeepAwakeControl', () => {
  it("the header's keep-awake menu has no label and checks on the right", async () => {
    server.use(
      http.get(daemonUrl('/settings/keep-awake'), () =>
        HttpResponse.json(KeepAwakeStatus.parse({ mode: 'while_running', active: true })),
      ),
      ...baseHandlers(),
    );
    renderApp('/board');
    fireEvent.click(await screen.findByRole('button', { name: /Keep-awake/ }));
    const menu = await screen.findByRole('menu', { hidden: true });
    expect(within(menu).queryByText('Keep the Mac awake')).toBeNull();
    const items = within(menu).getAllByRole('menuitem', { hidden: true });
    expect(items.map((i) => i.textContent)).toEqual([
      'Never keep the Mac awake',
      'Keep awake while tasks run',
      'Always keep the Mac awake',
    ]);
    const checked = items.filter((i) => i.querySelector('svg') !== null);
    expect(checked.map((i) => i.textContent)).toEqual(['Keep awake while tasks run']);
    // The check sits after the text.
    expect(checked[0]?.querySelector('[data-position="right"]')).not.toBeNull();
  });
});
