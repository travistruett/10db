// Vitest's default worker count is the machine's core count, which lets one local run take the whole
// Mac and starve the other sessions and the daemon beside it. Spread this into a vitest config's
// `test`: it caps workers locally and adds nothing on CI, where each shard has a runner to itself
// and keeps vitest's default width. A `--maxWorkers` on the command line overrides the cap.
export const localWorkerCap: { maxWorkers?: number } = process.env['CI'] ? {} : { maxWorkers: 4 };
