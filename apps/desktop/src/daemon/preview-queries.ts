import type { ProjectId } from '@10db/contracts';
import { useMutation } from '@tanstack/react-query';
import { z } from 'zod';
import { readJson } from './client';
import { useDaemon } from './provider';

/**
 * Restart Preview: the daemon runs the project's preview command again, its restarts forgotten. The
 * pass header follows by its own events.
 */
export function useRestartPreview() {
  const { client } = useDaemon();
  return useMutation({
    mutationFn: async (projectId: ProjectId) => {
      // The answer is 204 with no body; a refusal throws with the daemon's message.
      await readJson(
        await client.projects[':projectId'].preview.restart.$post({ param: { projectId } }),
        z.unknown(),
      );
    },
  });
}
