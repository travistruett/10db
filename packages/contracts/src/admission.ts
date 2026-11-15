import { z } from 'zod';

/** What holds new work back on this Mac. */
export const AdmissionHoldKind = {
  /** The load has stayed above twice the cores: new lanes and gates wait. */
  Load: 'load',
  /** Free disk is below the floor: new lanes wait. */
  Disk: 'disk',
  /** Lanes across all projects have reached the machine's cap: queued work waits. */
  LaneCap: 'lane_cap',
} as const;
export type AdmissionHoldKind = (typeof AdmissionHoldKind)[keyof typeof AdmissionHoldKind];

export const AdmissionHoldDto = z.object({
  kind: z.enum([AdmissionHoldKind.Load, AdmissionHoldKind.Disk, AdmissionHoldKind.LaneCap]),
  /** One sentence for Factory, saying what waits and why. */
  line: z.string().min(1),
});
export type AdmissionHoldDto = z.infer<typeof AdmissionHoldDto>;

/** What the admission gate holds now, and the readings behind it. */
export const AdmissionDto = z.object({
  /** In the order load, disk, lane cap; empty when nothing holds. */
  holds: z.array(AdmissionHoldDto),
  /** Free bytes on the volume worktrees are made on; null when the disk is not watched or unreadable. */
  freeBytes: z.number().nonnegative().nullable(),
  diskFloorBytes: z.number().nonnegative(),
  lanesRunning: z.number().int().nonnegative(),
  machineLaneCap: z.number().int().positive(),
});
export type AdmissionDto = z.infer<typeof AdmissionDto>;

/** Settings › This Mac › Capacity: the lane cap across all projects and the free-disk floor. */
export const CapacitySettingsDto = z.object({
  machineLaneCap: z.number().int().min(1).max(32),
  diskFloorGb: z.number().int().min(1).max(10_000),
});
export type CapacitySettingsDto = z.infer<typeof CapacitySettingsDto>;
