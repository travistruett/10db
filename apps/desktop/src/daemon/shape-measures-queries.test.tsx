import { mintId } from '@10db/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../test/daemon';
import { useSetOneWayPaths } from './shape-measures-queries';
import { useShapes } from './shape-queries';

const PROJECT_ID = mintId('Project');

function Open() {
  useShapes(PROJECT_ID);
  return null;
}

function Save() {
  const save = useSetOneWayPaths(PROJECT_ID);
  return (
    <button
      onClick={() => {
        save.mutate(['infra/**']);
      }}
    >
      save
    </button>
  );
}

describe('useSetOneWayPaths', () => {
  it('asks the Shape queries again, because the ceremony is worked out from the paths', async () => {
    // Saving the paths emits no event, so an open conversation would keep the old ceremony lines.
    let listed = 0;
    server.use(
      http.get(daemonUrl('/projects/:projectId/shapes'), () => {
        listed += 1;
        return HttpResponse.json([]);
      }),
      http.put(daemonUrl('/projects/:projectId/one-way-paths'), () =>
        HttpResponse.json({ paths: ['infra/**'] }),
      ),
      ...baseHandlers(),
    );
    renderWithDaemon(
      <>
        <Open />
        <Save />
      </>,
    );
    await waitFor(() => {
      expect(listed).toBe(1);
    });
    fireEvent.click(screen.getByText('save'));
    await waitFor(() => {
      expect(listed).toBe(2);
    });
  });
});
