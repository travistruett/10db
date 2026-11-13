import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemonAndRouter, server } from '../../../test/daemon';
import { planRecordHandlers, RECORD_SHAPE_ID } from '../../../test/plan-record-fixtures';
import type { RecordSearch } from './record-tabs';
import { RecordView } from './record-view';

afterEach(() => {
  clearMocks();
});

/** The view with its address held in state, as the route holds it in the URL. */
function Holder({ initial = {} }: { readonly initial?: RecordSearch }) {
  const [search, setSearch] = useState<RecordSearch>(initial);
  return <RecordView shapeId={RECORD_SHAPE_ID} search={search} onSearch={setSearch} />;
}

describe('RecordView', () => {
  it('the record opens on Documents with the latest revision rendered', async () => {
    server.use(...planRecordHandlers(), ...baseHandlers());
    await renderWithDaemonAndRouter(<Holder />);
    expect(await screen.findByText('Revoke it over the tailnet.')).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Documents/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByText('Imported 12 Nov 2026 from Claude Code')).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Decisions/ }).textContent).toContain('2');
  });

  it("export shows the daemon's refusal", async () => {
    mockIPC((command) => (command === 'plugin:dialog|open' ? '/Users/me/demo' : undefined));
    const asked: unknown[] = [];
    server.use(
      ...planRecordHandlers(),
      http.post(daemonUrl('/shapes/:shapeId/export'), async ({ request }) => {
        asked.push(await request.json());
        return HttpResponse.json(
          { error: 'invalid', message: '/Users/me/demo is the checkout of demo' },
          { status: 400 },
        );
      }),
      ...baseHandlers(),
    );
    await renderWithDaemonAndRouter(<Holder />);
    fireEvent.click(await screen.findByRole('button', { name: 'Export as Markdown' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      '/Users/me/demo is the checkout of demo',
    );
    expect(asked).toEqual([{ dir: '/Users/me/demo' }]);
  });

  it('export says how many files it wrote, and where', async () => {
    mockIPC((command) => (command === 'plugin:dialog|open' ? '/Users/me/exports' : undefined));
    server.use(
      ...planRecordHandlers(),
      http.post(daemonUrl('/shapes/:shapeId/export'), () =>
        HttpResponse.json({ dir: '/Users/me/exports', files: ['README.md', 'documents/p1.md'] }),
      ),
      ...baseHandlers(),
    );
    await renderWithDaemonAndRouter(<Holder />);
    fireEvent.click(await screen.findByRole('button', { name: 'Export as Markdown' }));
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe('Exported 2 files to /Users/me/exports');
    });
  });
});
