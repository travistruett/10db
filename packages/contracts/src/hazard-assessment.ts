import { z } from 'zod';
import { AreaName } from './entities';

/** What a hazard entry is: a path pattern or the start of a command. */
export const HazardEntryKind = { Glob: 'glob', Command: 'command' } as const;
export type HazardEntryKind = (typeof HazardEntryKind)[keyof typeof HazardEntryKind];

/** Where an entry came from: a file of the repository, and the line when a line named it. */
export const HazardEvidence = z.object({
  /** A tracked path of the repository. */
  file: z.string().min(1).max(300),
  line: z.int().min(1).optional(),
});
export type HazardEvidence = z.infer<typeof HazardEvidence>;

/** One glob or command 10db added to a project's hazards by itself, and why. */
export const HazardAdditionDto = z.object({
  id: z.string().min(1),
  /** The hazard it was added to. */
  hazard: AreaName,
  kind: z.enum([HazardEntryKind.Glob, HazardEntryKind.Command]),
  /** The glob or the command prefix, as stored in the hazard. */
  value: z.string().min(1),
  /** One line in plain words. */
  reason: z.string(),
  evidence: HazardEvidence,
  addedAt: z.iso.datetime(),
});
export type HazardAdditionDto = z.infer<typeof HazardAdditionDto>;

/** What the last assessment of a project's repository did. */
export const HazardAssessmentDto = z.object({
  /** Additions still in the project's hazards, oldest first. */
  additions: z.array(HazardAdditionDto),
  /** When the repository was last read to the end; null before the first. */
  assessedAt: z.iso.datetime().nullable(),
  /** The commit it read. */
  commit: z.string().nullable(),
  /** The changes waiting for the builder's yes, as the one Inbox card lists them. */
  pendingRemovals: z.int().min(0),
});
export type HazardAssessmentDto = z.infer<typeof HazardAssessmentDto>;

/** What Look again did. A model that could not answer changes nothing. */
export const HazardLookAgainResult = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    assessment: HazardAssessmentDto,
    /** How many entries this look added. */
    added: z.int().min(0),
  }),
  z.object({ ok: z.literal(false), message: z.string() }),
]);
export type HazardLookAgainResult = z.infer<typeof HazardLookAgainResult>;

/** An addition the model proposed, before the checks and before it has an id. */
export const HazardAdditionDraft = HazardAdditionDto.omit({ id: true, addedAt: true });
export type HazardAdditionDraft = z.infer<typeof HazardAdditionDraft>;

/** A removal waiting on the builder's yes: what leaves which hazard, and the evidence. */
export const HazardRemoval = z.object({
  hazard: AreaName,
  kind: z.enum([HazardEntryKind.Glob, HazardEntryKind.Command]),
  value: z.string().min(1),
  reason: z.string(),
  evidence: HazardEvidence,
});
export type HazardRemoval = z.infer<typeof HazardRemoval>;
