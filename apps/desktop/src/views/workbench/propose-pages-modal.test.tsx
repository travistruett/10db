import type { AreaDef, PagesProposalDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import {
  baseHandlers,
  daemonUrl,
  renderWithDaemon,
  renderWithDaemonAndRouter,
  server,
} from '../../test/daemon';
import { projectViewDto } from '../../test/fixtures';
import { pagesProposalDto } from '../../test/pass-fixtures';
import { renderWithRouter } from '../../test/theme';
import { NoPageAreas, ProposePagesModal } from './propose-pages-modal';

const src: AreaDef = { name: 'src', globs: ['src/**'] };
const project = projectViewDto({ areas: [src] });
const proposal: PagesProposalDto = pagesProposalDto({
  pages: [
    {
      name: 'settings',
      globs: ['src/settings/**'],
      role: 'page',
      route: '/settings',
      reason: 'The settings screen and its forms',
    },
    {
      name: 'people',
      globs: ['src/people/**'],
      role: 'page',
      route: '/people',
      reason: 'The people list',
    },
  ],
  skipped: [{ name: 'reports', reason: 'It has no route of its own' }],
});

/** Serves the project's PATCH, recording each body; `refuse` answers 409 with its message. */
function servePatch(refuse: string | null = null): unknown[] {
  const sent: unknown[] = [];
  server.use(
    http.patch(daemonUrl('/projects/:projectId'), async ({ request }) => {
      sent.push(await request.json());
      return refuse === null
        ? HttpResponse.json(project)
        : HttpResponse.json({ error: 'conflict', message: refuse }, { status: 409 });
    }),
    ...baseHandlers(),
  );
  return sent;
}

function drawModal(propose: () => Promise<PagesProposalDto>) {
  const onClose = vi.fn();
  renderWithDaemon(
    <ProposePagesModal project={project} opened onClose={onClose} propose={propose} />,
  );
  return { onClose };
}

const saveButton = () => screen.getByRole('button', { name: 'Save Page Areas' });

describe('NoPageAreas', () => {
  it('says why a pass needs a page area, offers the proposer and links to Settings', async () => {
    const { router } = await renderWithRouter(<NoPageAreas onPropose={() => undefined} />);
    expect(
      screen.getByText(/A pass works on pages, and this project has no page area yet/),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Propose Page Areas' })).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Settings › Areas and hazards' }));
    expect(router.state.location.pathname).toBe('/settings/areas');
  });
});

describe('ProposePagesModal', () => {
  it('saves the ticked pages, as edited, after the areas the project has', async () => {
    const sent = servePatch();
    const { onClose } = drawModal(() => Promise.resolve(proposal));
    const settings = await screen.findByRole('group', { name: 'settings' });
    expect(within(settings).getByText('The settings screen and its forms')).toBeTruthy();
    fireEvent.change(within(settings).getByLabelText('Route'), { target: { value: '/account' } });
    fireEvent.change(within(settings).getByLabelText('Name'), {
      target: { value: 'account' },
    });
    fireEvent.click(
      within(screen.getByRole('group', { name: 'people' })).getByRole('checkbox', {
        name: 'Add people',
      }),
    );
    expect(screen.getByText('reports: It has no route of its own')).toBeTruthy();
    fireEvent.click(saveButton());
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(sent).toEqual([
      {
        areas: [
          src,
          { name: 'account', globs: ['src/settings/**'], role: 'page', route: '/account' },
        ],
      },
    ]);
  });

  it('says why there is nothing to save when no page is proposed, and where to add one by hand', async () => {
    servePatch();
    const onClose = vi.fn();
    const { router } = await renderWithDaemonAndRouter(
      <ProposePagesModal
        project={project}
        opened
        onClose={onClose}
        propose={() =>
          Promise.resolve(
            pagesProposalDto({
              pages: [],
              skipped: [{ name: 'admin', reason: 'It has no route of its own' }],
            }),
          )
        }
      />,
    );
    expect(await screen.findByText(/No page areas to propose/)).toBeTruthy();
    expect(screen.getByText('admin: It has no route of its own')).toBeTruthy();
    expect(saveButton()).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('link', { name: 'Settings › Areas and hazards' }));
    expect(router.state.location.pathname).toBe('/settings/areas');
  });

  it('says a failed proposal beside Save, with nothing to save', async () => {
    servePatch();
    drawModal(() => Promise.reject(new Error('The namer did not answer')));
    expect(await screen.findByText('The namer did not answer')).toBeTruthy();
    expect(saveButton()).toHaveProperty('disabled', true);
  });

  it("says the daemon's refusal of the save beside Save", async () => {
    servePatch('Pages "account" and "forms" can share a file');
    const { onClose } = drawModal(() => Promise.resolve(proposal));
    await screen.findByRole('group', { name: 'settings' });
    fireEvent.click(saveButton());
    expect(await screen.findByText('Pages "account" and "forms" can share a file')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});
