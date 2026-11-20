import { screen } from '@testing-library/react';
import { useState } from 'react';
import { expect, it } from 'vitest';
import { baseHandlers, renderWithDaemonAndRouter, server } from '../../../../test/daemon';
import { FrameSlots } from '../../../../test/frame';
import { planRecordHandlers, RECORD_SHAPE_ID } from '../../../../test/plan-record-fixtures';
import type { RecordSearch } from './record-tabs';
import { RecordView } from './record-view';

/** The view with its address held in state, as the route holds it in the URL. */
function Holder({ initial = {} }: { readonly initial?: RecordSearch }) {
  const [search, setSearch] = useState<RecordSearch>(initial);
  return <RecordView shapeId={RECORD_SHAPE_ID} search={search} onSearch={setSearch} />;
}

it('the record opens on Documents with the latest revision rendered', async () => {
  server.use(...planRecordHandlers(), ...baseHandlers());
  await renderWithDaemonAndRouter(
    <FrameSlots>
      <Holder />
    </FrameSlots>,
  );
  expect(await screen.findByText('Revoke it over the tailnet.')).toBeTruthy();
  expect(screen.getByRole('tab', { name: /Documents/ }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByText('Imported 12 Nov 2026 from Claude Code')).toBeTruthy();
  expect(screen.getByRole('tab', { name: /Decisions/ }).textContent).toContain('2');
});
