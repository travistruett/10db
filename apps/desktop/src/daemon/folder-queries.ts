import { FolderInspectResult } from '@10db/contracts';
import { useMutation } from '@tanstack/react-query';
import { readJson } from './client';
import { useDaemon } from './provider';

/**
 * What a folder holds, or why it can't become a project. A mutation, not a query: it runs when the
 * builder picks or types a folder, and a refusal is an answer, not an error.
 */
export function useInspectFolder() {
  const { client } = useDaemon();
  return useMutation({
    mutationFn: async (path: string) =>
      readJson(await client.folders.inspect.$post({ json: { path } }), FolderInspectResult),
  });
}
