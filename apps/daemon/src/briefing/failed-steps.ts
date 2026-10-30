/** A gate step that failed, as the gate's output names it. */
export interface FailedStep {
  readonly name: string;
  readonly command: string;
  readonly log: string;
}

/** The line a gate prints for each failing step: `FAILED lint: pnpm lint (log .gate/lint.log)`. */
const FAILED_LINE = /^FAILED (\S+): (.+) \(log (\S+)\)$/gm;

/** The failing steps a gate's output names, in order; none when it names none. */
export function failedSteps(output: string): FailedStep[] {
  return [...output.matchAll(FAILED_LINE)].flatMap(([, name, command, log]) =>
    name !== undefined && command !== undefined && log !== undefined
      ? [{ name, command, log }]
      : [],
  );
}
