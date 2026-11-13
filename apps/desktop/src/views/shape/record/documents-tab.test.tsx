import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pickOption } from '../../../test/combobox';
import { baseHandlers, renderWithDaemonAndRouter, server } from '../../../test/daemon';
import { mintId, type PlanRecordDto } from '@10db/contracts';
import {
  P1_DOCUMENT_ID,
  P1_REVISION_2,
  planRecordDto,
  planRecordHandlers,
  RECORD_SHAPE_ID,
  sectionsOf,
} from '../../../test/plan-record-fixtures';
import { DocumentsTab, sectionLine } from './documents-tab';
import type { RecordSearch } from './record-tabs';

// jsdom has no layout and no scrollIntoView; the stub records which heading was asked to scroll.
const scrolled: string[] = [];
beforeEach(() => {
  scrolled.length = 0;
  Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
    scrolled.push(this.textContent);
  });
});
afterEach(() => {
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
});

function Holder({
  initial = {},
  record = planRecordDto(),
}: {
  readonly initial?: RecordSearch;
  readonly record?: PlanRecordDto;
}) {
  const [search, setSearch] = useState<RecordSearch>(initial);
  return (
    <DocumentsTab shapeId={RECORD_SHAPE_ID} record={record} search={search} onSearch={setSearch} />
  );
}

describe('sectionLine', () => {
  it.each<[string, string, number]>([
    ['the first line', '# A\nb\n', 1],
    ['after LF lines', 'a\nb\n## C\n', 3],
    ['after CR LF lines', 'a\r\nb\r\n## C\r\n', 3],
    ['after a lone CR', 'a\rb\n## C\n', 3],
  ])('%s', (_, body, line) => {
    expect(sectionLine(body, body.indexOf('#'))).toBe(line);
  });

  it("names each fixture section's heading line", () => {
    const sections = planRecordDto().documents[0]?.revisions[1]?.sections ?? [];
    const lines = P1_REVISION_2.split('\n');
    expect(sections.map((s) => lines[sectionLine(P1_REVISION_2, s.start) - 1])).toEqual(
      sections.map((s) => `${'#'.repeat(s.level)} ${s.title}`),
    );
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
      expect(scrolled).toContain('Task 12: Revoke a device');
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
      <Holder initial={{ doc: P1_DOCUMENT_ID, rev: 2, section: 'what-holds' }} />,
    );
    await waitFor(() => {
      expect(scrolled).toEqual(['What holds']);
    });
  });

  it('a spec and an eval sharing a key each open their own text', async () => {
    const specId = mintId('ShapeAttachment');
    const evalId = mintId('ShapeAttachment');
    const revisions = (planRecordDto().documents[1]?.revisions ?? []).map((r) => ({
      ...r,
      sections: [],
    }));
    const shared = { key: 'g1', effortKey: 'g1', revisions };
    const record = planRecordDto({
      documents: [
        { ...shared, id: specId, kind: 'spec', title: 'Pairing spec' },
        { ...shared, id: evalId, kind: 'eval', title: 'Pairing eval' },
      ],
    });
    server.use(
      ...planRecordHandlers({
        record,
        bodies: {
          [`${specId}#1`]: 'The spec says pair.',
          [`${evalId}#1`]: 'The eval checks pairing.',
        },
      }),
      ...baseHandlers(),
    );
    await renderWithDaemonAndRouter(<Holder record={record} />);
    expect(await screen.findByText('The spec says pair.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Pairing eval/ }));
    expect(await screen.findByText('The eval checks pairing.')).toBeTruthy();
    expect(screen.queryByText('The spec says pair.')).toBeNull();
    const docs = within(screen.getByRole('navigation', { name: 'Documents' }));
    expect(docs.getByRole('button', { name: /Pairing eval/ }).getAttribute('data-active')).toBe(
      'true',
    );
  });

  it('a footnote and a reference link keep their definitions in a later section', async () => {
    const body = [
      '# Notes',
      'See the port[^1] and [the docs][docs].',
      '## Sources',
      '[^1]: Port 7443 over the tailnet.',
      '',
      '[docs]: https://ok.example/docs',
      '',
    ].join('\n');
    const id = mintId('ShapeAttachment');
    const [revision] = planRecordDto().documents[1]?.revisions ?? [];
    if (!revision) throw new Error('no revision');
    const record = planRecordDto({
      documents: [
        {
          id,
          key: 'n1',
          kind: 'research',
          title: 'Notes',
          effortKey: null,
          revisions: [{ ...revision, sections: sectionsOf(body) }],
        },
      ],
    });
    server.use(...planRecordHandlers({ record, bodies: { [`${id}#1`]: body } }), ...baseHandlers());
    await renderWithDaemonAndRouter(<Holder record={record} initial={{ section: 'sources' }} />);
    const region = await screen.findByRole('region', { name: 'Notes' });
    await waitFor(() => {
      expect(region.textContent).toContain('Port 7443 over the tailnet.');
    });
    const shown = region.textContent.replace(/\s+/g, ' ');
    expect(within(region).getByRole('link', { name: 'the docs' }).getAttribute('href')).toBe(
      'https://ok.example/docs',
    );
    expect(shown).not.toContain('[^1]');
    expect(shown).not.toContain('[docs]');
    await waitFor(() => {
      expect(scrolled).toContain('Sources');
    });
  });
});
