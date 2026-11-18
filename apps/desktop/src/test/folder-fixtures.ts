import { FolderDto, FolderHolderKind, mintId, type ProjectId } from '@10db/contracts';

// Who holds Your folder, as the daemon's `GET /projects/:id/folder` says it. Every DTO is parsed with its
// contract.

/** Your folder as `GET /projects/:id/folder` answers: free, on `main`, unless the test says otherwise. */
export function folderDto(
  overrides: Partial<FolderDto> & { readonly projectId?: ProjectId } = {},
): FolderDto {
  const holders = overrides.holders ?? [];
  const closed = holders.find((h) => h.kind === FolderHolderKind.PassClosed);
  return FolderDto.parse({
    projectId: mintId('Project'),
    branch: 'main',
    holders,
    limits: closed === undefined ? [] : ['folder_git_until_merge'],
    limitPass: closed?.name ?? null,
    pendingOpen: null,
    ...overrides,
  });
}
