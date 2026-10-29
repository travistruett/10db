import { z } from 'zod';
import { AreaDef } from './entities';

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
});
export type FolderInspection = z.infer<typeof FolderInspection>;

export const FolderInspectResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), inspection: FolderInspection }),
  z.object({ ok: z.literal(false), reason: z.enum(FolderRefusalReason), message: z.string() }),
]);
export type FolderInspectResult = z.infer<typeof FolderInspectResult>;

/** The folder to propose areas for: a repository's top level, as an absolute path. */
export const AreaProposalInput = z.object({ path: z.string().startsWith('/') });
export type AreaProposalInput = z.infer<typeof AreaProposalInput>;

/** An area as proposed: what a project stores, plus why the builder is offered it. */
export const ProposedArea = AreaDef.extend({
  /** One line on what the area holds and why it stands alone. */
  reason: z.string().min(1).max(300),
});
export type ProposedArea = z.infer<typeof ProposedArea>;

/** Who named and merged the areas. */
export const AreaProposalSource = {
  /** A model named and merged the candidates. */
  Model: 'model',
  /** The candidates as the repository's structure and history gave them: no model answered. */
  Structure: 'structure',
} as const;
export type AreaProposalSource = (typeof AreaProposalSource)[keyof typeof AreaProposalSource];

export const AreaProposal = z.object({
  areas: z.array(ProposedArea).min(1),
  namedBy: z.enum(AreaProposalSource),
});
export type AreaProposal = z.infer<typeof AreaProposal>;

export const AreaProposalResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), proposal: AreaProposal }),
  z.object({ ok: z.literal(false), message: z.string() }),
]);
export type AreaProposalResult = z.infer<typeof AreaProposalResult>;
