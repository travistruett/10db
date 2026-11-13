import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pickOption } from '../../../test/combobox';
import { baseHandlers, renderWithDaemonAndRouter, server } from '../../../test/daemon';
import {
  P1_REVISION_2,
  planRecordDto,
  planRecordHandlers,
  RECORD_SHAPE_ID,
} from '../../../test/plan-record-fixtures';
import { bodyPieces, DocumentsTab } from './documents-tab';
import type { RecordSearch } from './record-tabs';

// jsdom has no layout and no scrollIntoView; the stub records which piece was asked to scroll.
const scrolled: string[] = [];
beforeEach(() => {
  scrolled.length = 0;
  Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
    scrolled.push(this.getAttribute('data-section') ?? '');
  });
});
afterEach(() => {
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
});

function Holder({ initial = {} }: { readonly initial?: RecordSearch }) {
  const [search, setSearch] = useState<RecordSearch>(initial);
  return (
    <DocumentsTab
      shapeId={RECORD_SHAPE_ID}
      record={planRecordDto()}
      search={search}
      onSearch={setSearch}
    />
  );
}

describe('bodyPieces', () => {
  it('cuts a body at its sections and loses nothing', () => {
    const sections = planRecordDto().documents[0]?.revisions[1]?.sections ?? [];
    const pieces = bodyPieces(P1_REVISION_2, sections);
    expect(pieces.map((p) => p.text).join('')).toBe(P1_REVISION_2);
    expect(pieces.map((p) => p.slug)).toEqual([
      'remote-host-plan',
      'starting-point',
      'what-holds',
      'task-12',
    ]);
  });
});

describe('DocumentsTab', () => {
  it('picking revision 1 shows its body', async () => {
    server.use(...planRecordHandlers(), ...baseHandlers());
    await renderWithDaemonAndRouter(<Holder />);
    expect(await screen.findByText('Revoke it over the tailnet.')).toBeTruthy();
    await pickOption(await screen.findByRole('combobox', { name: 'Revision' }), /Revision 1/);
    expect(await screen.findByText('Pair it first.')).toBeTruthy();
    expect(screen.queryByText('Revoke it over the tailnet.')).toBeNull();
  });

  it('the outline lists sections by level and opens one', async () => {
    server.use(...planRecordHandlers(), ...baseHandlers());
    await renderWithDaemonAndRouter(<Holder />);
    const outline = await screen.findByRole('navigation', { name: 'Outline' });
    const links = within(outline).getAllByRole('button');
    expect(links.map((l) => l.textContent)).toEqual([
      'Remote host plan',
      'Starting point',
      'What holds',
      'Task 12: Revoke a device',
    ]);
    const indent = (l: HTMLElement) => Number.parseFloat(l.style.paddingLeft || '0');
    expect(indent(links[2] ?? links[0] ?? outline)).toBeGreaterThan(indent(links[1] ?? outline));
    await screen.findByText('Revoke it over the tailnet.');
    fireEvent.click(within(outline).getByRole('button', { name: 'Task 12: Revoke a device' }));
    await waitFor(() => {
      expect(scrolled).toContain('task-12');
    });
    expect(
      within(outline)
        .getByRole('button', { name: 'Task 12: Revoke a device' })
        .getAttribute('aria-current'),
    ).toBe('location');
  });

  it('a section named in the address opens it', async () => {
    server.use(...planRecordHandlers(), ...baseHandlers());
    await renderWithDaemonAndRouter(
      <Holder initial={{ doc: 'p1', rev: 2, section: 'what-holds' }} />,
    );
    await waitFor(() => {
      expect(scrolled).toEqual(['what-holds']);
    });
  });
});
