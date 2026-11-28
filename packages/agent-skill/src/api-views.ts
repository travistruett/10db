import { z } from 'zod';

// The parts of the daemon's answers the commands read. Fields a command only passes on are `unknown`.

export const HazardView = z.looseObject({
  name: z.string(),
  globs: z.array(z.string()),
  commands: z.array(z.string()),
  scope: z.string().optional(),
});
export type HazardView = z.infer<typeof HazardView>;

export const ProjectView = z.looseObject({
  id: z.string(),
  name: z.string(),
  repoPath: z.string(),
  areas: z.array(z.looseObject({ name: z.string(), globs: z.array(z.string()) })),
  defaultRigor: z.unknown(),
  gateCommand: z.unknown(),
  changedCheckCommand: z.unknown(),
  precheckCommand: z.unknown(),
  delivery: z.string(),
  baseBranch: z.string(),
  landing: z.string(),
  landingBranch: z.string().nullable(),
  prTitlePrefix: z.unknown(),
  accountId: z.string().nullable(),
  fallbackAccountId: z.string().nullable(),
  maxLanes: z.unknown(),
  workspaceMode: z.unknown(),
  sandboxLoopback: z.unknown(),
  sandboxDocker: z.unknown(),
  hazards: z.array(HazardView),
});
export type ProjectView = z.infer<typeof ProjectView>;

export const TaskView = z.looseObject({
  id: z.string(),
  title: z.string(),
  projectId: z.string().optional(),
  status: z.string().optional(),
  boardStatus: z.string().optional(),
  // The project's task list leaves out what a task has none of (no dependencies) and, for a task done and
  // merged, its rigor and kinds; only open tasks are shown, and those carry them.
  dependsOn: z.array(z.string()).default([]),
  rigor: z.unknown().optional(),
  effectiveRigor: z.unknown().optional(),
  kinds: z.array(z.object({ key: z.string() })).default([]),
});
export type TaskView = z.infer<typeof TaskView>;

export const KindView = z.object({
  key: z.string(),
  label: z.unknown(),
  description: z.unknown(),
  minimumRigor: z.unknown(),
});
export type KindView = z.infer<typeof KindView>;

export const AccountView = z.looseObject({
  id: z.string(),
  label: z.string(),
  kind: z.unknown(),
  settings: z.record(z.string(), z.unknown()).optional(),
});
export type AccountView = z.infer<typeof AccountView>;

/** A task, batch, card or workstream the daemon answers an action with. */
export const ActedOn = z.looseObject({
  id: z.string(),
  title: z.string(),
  state: z.string().optional(),
  status: z.string().optional(),
  boardStatus: z.string().optional(),
});
export type ActedOn = z.infer<typeof ActedOn>;

export const InboxItemView = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  options: z.array(z.object({ label: z.string() })),
});

export const StartedView = z.object({ id: z.string() }).nullable();
export const HeldView = z.object({ state: z.string() });
export const JoinedBatches = z.array(z.object({ id: z.string(), state: z.string() }));
export const RunNextView = z.object({ waitingOn: z.array(z.unknown()).optional() }).nullable();
export const BoardColumnView = z.object({ id: z.string(), name: z.string() });
export const SavedHazards = z.object({ hazards: z.array(z.unknown()) });
export const Adopted = z.looseObject({ id: z.string(), title: z.string() });
export const Imported = z.looseObject({ created: z.boolean(), shapeId: z.string() });
export const SavedAccount = z.object({ settings: z.unknown().optional() });
