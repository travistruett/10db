import { PassJoinRequest, type AreaDef, type PassStartDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { baseHandlers, renderWithDaemonAndRouter, server } from '../../test/daemon';
import { projectViewDto } from '../../test/fixtures';
import { PASS_NOW, passPageDto, passStartDto, passViewDto } from '../../test/pass-fixtures';
import { AddPageModal } from './add-page-modal';

const names = ['settings', 'people', 'billing', 'home', 'team', 'reports', 'forms'];
const areas: AreaDef[] = names.map((name) => ({
  name,
  globs: [`src/${name}/**`],
  role: 'page',
  route: `/${name}`,
}));
const project = projectViewDto({ areas });
const start: PassStartDto = passStartDto({
  pages: names.map((area) => ({
    area,
    route: `/${area}`,
    lastChangedAt: null,
    uncommitted: area === 'people' ? 2 : 0,
    heldBy: null,
  })),
  otherUncommitted: 0,
});
const inPass = (count: number) =>
  passViewDto({
    pages: names.slice(0, count).map((area) => passPageDto({ area, title: `${area}: UI work` })),
  });

async function draw(
  count: number,
  add = vi.fn<(request: PassJoinRequest) => Promise<void>>(() => Promise.resolve()),
) {
  server.use(...baseHandlers());
  const onClose = vi.fn();
  await renderWithDaemonAndRouter(
    <AddPageModal
      project={project}
      view={inPass(count)}
      start={start}
      tasks={[]}
      now={Date.parse(PASS_NOW)}
      onClose={onClose}
      add={add}
    />,
  );
  return { add, onClose, dialog: await screen.findByRole('dialog', { name: 'Add Page' }) };
}

describe('AddPageModal', () => {
  it('adds the ticked pages the pass lacks, with their first message', async () => {
    const { add, onClose, dialog } = await draw(1);
    expect(within(dialog).queryByRole('checkbox', { name: /^settings/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /^people/ }));
    expect(within(dialog).getByText(/people: 2 files already changed/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('First message'), {
      target: { value: 'the list is cramped' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Pages (1)' }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(PassJoinRequest.parse(add.mock.calls[0]?.[0])).toEqual({
      pages: ['people'],
      taskIds: [],
      firstMessage: 'the list is cramped',
    });
  });

  it('refuses a seventh page', async () => {
    const { dialog } = await draw(5);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /^reports/ }));
    expect(within(dialog).getByRole('checkbox', { name: /^forms/ })).toHaveProperty(
      'disabled',
      true,
    );
    expect(within(dialog).getAllByText('A pass holds at most 6 pages').length).toBeGreaterThan(0);
  });

  it("says the daemon's refusal beside Add Pages and stays open", async () => {
    const add = vi.fn<(request: PassJoinRequest) => Promise<void>>(() =>
      Promise.reject(new Error('people is held by "Fix the list"')),
    );
    const { onClose, dialog } = await draw(1, add);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /^people/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Pages (1)' }));
    expect(await within(dialog).findByText('people is held by "Fix the list"')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});
