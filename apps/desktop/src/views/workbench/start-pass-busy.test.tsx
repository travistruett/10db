import {
  FolderHolderKind,
  type AreaDef,
  type FolderDto,
  type PassOpenRequest,
} from '@10db/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemonAndRouter, server } from '../../test/daemon';
import { projectViewDto } from '../../test/fixtures';
import { folderDto, folderHolder } from '../../test/folder-fixtures';
import { PASS_NOW, passStartDto } from '../../test/pass-fixtures';
import { StartPass } from './start-pass';

// B10 on the Workbench: a Start Pass refused only because chats' turns hold Your folder has two ways out.

const areas: AreaDef[] = [
  { name: 'settings', globs: ['src/settings/**'], role: 'page', route: '/settings' },
];
const project = projectViewDto({ name: 'ampsio', areas });
const refused = passStartDto({
  pages: [
    {
      area: 'settings',
      label: 'Settings',
      route: '/settings',
      lastChangedAt: null,
      uncommitted: 0,
      heldBy: null,
    },
  ],
  refusal: { code: 'folder_in_use', message: 'Your folder is in use.' },
});

async function draw(folder: FolderDto | null) {
  const onStart = vi.fn<(request: PassOpenRequest) => void>();
  server.use(...baseHandlers());
  await renderWithDaemonAndRouter(
    <StartPass
      project={project}
      start={refused}
      tasks={[]}
      initial={{ pages: ['settings'], taskIds: [] }}
      goalId={null}
      now={Date.parse(PASS_NOW)}
      onStart={onStart}
      starting={false}
      error={null}
      folder={folder}
    />,
  );
  // The daemon provider draws the screen once it has connected.
  await screen.findByRole('button', { name: 'Start Pass' });
  return { onStart };
}

describe('Start Pass refused by chats’ turns', () => {
  it('offers both ways out, and each sends its whenBusy with the ticked page', async () => {
    const chat = folderHolder(FolderHolderKind.ChatTurn, 'Login fails');
    const { onStart } = await draw(folderDto({ projectId: project.id, holders: [chat] }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop the Turn and Open' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open When It Ends' }));
    expect(onStart.mock.calls.map(([request]) => request.whenBusy)).toEqual(['stop_turns', 'wait']);
    expect(onStart.mock.calls[0]?.[0].pages).toEqual(['settings']);
    expect(screen.getByRole('button', { name: 'Start Pass' })).toHaveProperty('disabled', true);
  });

  it.each([
    { name: 'a lane', holder: folderHolder(FolderHolderKind.Lane, 'Bump vite') },
    { name: 'a takeover', holder: folderHolder(FolderHolderKind.Takeover, 'Login fails') },
  ])('offers neither while $name holds it', async ({ holder }) => {
    await draw(folderDto({ projectId: project.id, holders: [holder] }));
    expect(screen.queryByRole('button', { name: 'Stop the Turn and Open' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open When It Ends' })).toBeNull();
  });

  it('shows the waiting open with Cancel, which deletes it', async () => {
    const cancelled: string[] = [];
    server.use(
      http.delete(daemonUrl('/projects/:projectId/pending-open'), ({ params }) => {
        cancelled.push(String(params['projectId']));
        return HttpResponse.json(folderDto({ projectId: project.id }));
      }),
    );
    await draw(
      folderDto({
        projectId: project.id,
        holders: [folderHolder(FolderHolderKind.ChatTurn, 'Login fails')],
        pendingOpen: { name: 'Settings pass', waitsFor: 'the chat ‘Login fails’' },
      }),
    );
    expect(screen.getByText('Opens when the chat ‘Login fails’ ends its turn')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open When It Ends' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(cancelled).toEqual([project.id]);
    });
  });
});
