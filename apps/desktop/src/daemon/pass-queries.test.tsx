import { mintId, type PassState, type ProjectId } from '@10db/contracts';
import { projectDto } from '../test/fixtures';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../test/daemon';
import { passViewDto } from '../test/pass-fixtures';
import { livePassOf, setupKeys, useLivePass } from './pass-queries';
import { usePatchProject } from './queries';

describe('livePassOf', () => {
  const project = mintId('Project');
  const pass = (name: string, state: PassState, openedAt: string, projectId = project) =>
    passViewDto({ pass: { name, state, openedAt, projectId }, pages: [] });

  it.each<{ name: string; passes: ReturnType<typeof pass>[]; shown: string | null }>([
    { name: 'no live pass', passes: [], shown: null },
    {
      name: "another project's pass only",
      passes: [pass('Theirs', 'OPEN', '2026-11-09T12:00:00.000Z', mintId('Project'))],
      shown: null,
    },
    {
      name: 'a pass opened on a closed one still waiting for its merge',
      passes: [
        pass('Closed', 'CLOSED', '2026-11-09T10:00:00.000Z'),
        pass('Open', 'OPEN', '2026-11-09T09:00:00.000Z'),
      ],
      shown: 'Open',
    },
    {
      name: 'a pass abandoning, which still holds its pages',
      passes: [
        pass('Closed', 'CLOSED', '2026-11-09T10:00:00.000Z'),
        pass('Leaving', 'ABANDONING', '2026-11-09T09:00:00.000Z'),
      ],
      shown: 'Leaving',
    },
    {
      name: 'closed passes waiting to settle: the latest',
      passes: [
        pass('Older', 'CLOSED', '2026-11-08T10:00:00.000Z'),
        pass('Newer', 'CLOSED', '2026-11-09T10:00:00.000Z'),
      ],
      shown: 'Newer',
    },
  ])('$name', ({ passes, shown }) => {
    expect(livePassOf(passes, project)?.pass.name ?? null).toBe(shown);
  });
});

function LivePassName({ projectId }: { readonly projectId: ProjectId }) {
  const live = useLivePass(projectId);
  if (live.data === undefined) return null;
  return <span>{live.data?.pass.name ?? 'No pass'}</span>;
}

describe('useLivePass', () => {
  it("asks for every project's live passes and shows the project's own", async () => {
    const project = mintId('Project');
    const asked: string[] = [];
    server.use(
      http.get(daemonUrl('/passes'), ({ request }) => {
        asked.push(new URL(request.url).search);
        return HttpResponse.json([
          passViewDto({ pass: { name: 'Theirs', projectId: mintId('Project') }, pages: [] }),
          passViewDto({ pass: { name: 'Mine', projectId: project }, pages: [] }),
        ]);
      }),
      ...baseHandlers(),
    );
    renderWithDaemon(<LivePassName projectId={project} />);
    expect(await screen.findByText('Mine')).toBeTruthy();
    expect(asked).toEqual(['?live=true']);
  });
});

function SaveAreas({ projectId }: { readonly projectId: ProjectId }) {
  const patch = usePatchProject(projectId);
  return (
    <button
      type="button"
      onClick={() => {
        patch.mutate({ areas: [{ name: 'src', globs: ['src/**'] }] });
      }}
    >
      Save
    </button>
  );
}

describe('usePatchProject', () => {
  it("makes the project's cached setup stale once it saves, so an Apply never sends an old proposal", async () => {
    const project = projectDto();
    server.use(
      http.patch(daemonUrl('/projects/:projectId'), () => HttpResponse.json(project)),
      ...baseHandlers(),
    );
    const { queryClient } = renderWithDaemon(<SaveAreas projectId={project.id} />);
    queryClient.setQueryData(setupKeys.of(project.id), { stale: false });
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(queryClient.getQueryState(setupKeys.of(project.id))?.isInvalidated).toBe(true);
    });
  });
});
