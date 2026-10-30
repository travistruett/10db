import { z } from 'zod';
import { FoundHostDto } from './entities';

/** Where a candidate gate command was found in a folder. */
export const GateSource = {
  Makefile: 'makefile',
  PackageJson: 'package_json',
  Cargo: 'cargo',
  Go: 'go',
} as const;
export type GateSource = (typeof GateSource)[keyof typeof GateSource];

/** A folder the builder chose to inspect: an absolute path. */
export const FolderInspectInput = z.object({ path: z.string().startsWith('/') });
export type FolderInspectInput = z.infer<typeof FolderInspectInput>;

/** Why a folder can't become a project; the UI shows the message on the folder box. */
export const FolderRefusalReason = {
  NotFound: 'not_found',
  NotADirectory: 'not_a_directory',
  NotARepository: 'not_a_repository',
  BareRepository: 'bare_repository',
  AlreadyAProject: 'already_a_project',
  InsideAProject: 'inside_a_project',
  ProtectedPath: 'protected_path',
  Unreadable: 'unreadable',
} as const;
export type FolderRefusalReason = (typeof FolderRefusalReason)[keyof typeof FolderRefusalReason];

/** What a folder holds that a new project is prefilled from. */
export const FolderInspection = z.object({
  /** The repository's top level, as a real path. */
  root: z.string(),
  /** The root's folder name. */
  suggestedName: z.string(),
  /** Origin's branches first, then local branches not on origin. */
  branches: z.array(z.object({ name: z.string(), remote: z.boolean() })),
  /** origin/HEAD's target, else the current branch when it has commits, else null. */
  defaultBranch: z.string().nullable(),
  /** `owner/name` when origin is a github.com repository. */
  github: z.string().nullable(),
  /** Best first; the first is prefilled. */
  gateCandidates: z.array(z.object({ command: z.string(), source: z.enum(GateSource) })),
  /**
   * The hosts the folder's package files name (lockfiles, package manager settings, toolchain
   * files), which adding the folder as a project allows, each with the file that names it.
   */
  registryHosts: z.array(FoundHostDto),
});
export type FolderInspection = z.infer<typeof FolderInspection>;

export const FolderInspectResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), inspection: FolderInspection }),
  z.object({ ok: z.literal(false), reason: z.enum(FolderRefusalReason), message: z.string() }),
]);
export type FolderInspectResult = z.infer<typeof FolderInspectResult>;
