import { FoundHostDto, type ProjectId } from '@10db/contracts';
import { getAppSetting, setAppSetting, type DbReader, type WriteContext } from '@10db/db';
import { z } from 'zod';

const FoundHostList = z.array(FoundHostDto);

const key = (projectId: ProjectId): string => `network-hosts-found:${projectId}`;

/**
 * The hosts the project's package files named the last time they were read, whether or not they are
 * allowed now. A lane's or a gate's blocked-host card reads it to say a file names the host. Only
 * hosts and file paths are kept: nothing else of a file's text is.
 */
export function readFoundHosts(db: DbReader, projectId: ProjectId): FoundHostDto[] {
  const parsed = FoundHostList.safeParse(getAppSetting(db, key(projectId)));
  return parsed.success ? parsed.data : [];
}

/** Replaces the project's found hosts with those of the latest reading. */
export function writeFoundHosts(
  ctx: WriteContext,
  projectId: ProjectId,
  found: readonly FoundHostDto[],
): void {
  setAppSetting(
    ctx,
    key(projectId),
    found.map(({ host, file }) => ({ host, file })),
  );
}

/**
 * Keeps `found` as the project's reading when it has none, and answers whether it did. A reading made
 * meanwhile (when the project was added, or by another caller) is left as it is: a reading, once kept,
 * is never replaced this way. An empty reading counts as one.
 */
export function writeFoundHostsIfNone(
  ctx: WriteContext,
  projectId: ProjectId,
  found: readonly FoundHostDto[],
): boolean {
  if (getAppSetting(ctx.tx, key(projectId)) !== undefined) return false;
  writeFoundHosts(ctx, projectId, found);
  return true;
}

/** The file that names `host` as a registry or toolchain host, or null when none does. */
export function foundHostFile(db: DbReader, projectId: ProjectId, host: string): string | null {
  const wanted = host.trim().toLowerCase();
  return readFoundHosts(db, projectId).find((f) => f.host === wanted)?.file ?? null;
}
