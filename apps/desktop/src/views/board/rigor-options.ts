import { effectiveRigor, RIGORS, rigorAtLeast, type KindDto, type Rigor } from '@10db/contracts';
import { RIGOR_LABEL } from './rigor-labels';

export interface RigorOption {
  readonly value: Rigor;
  readonly label: string;
  readonly disabled: boolean;
}

/**
 * The rigors a task can be given: one below the highest minimum of its kinds is disabled, and says which
 * kind sets that floor. A key no kind has adds no floor.
 */
export function rigorOptions(
  kinds: readonly KindDto[],
  taskKeys: readonly string[],
): RigorOption[] {
  const floors = kinds.filter((k) => taskKeys.includes(k.key) && k.minimumRigor !== null);
  const strongest = floors.reduce<KindDto | undefined>(
    (best, k) =>
      best?.minimumRigor == null ||
      (k.minimumRigor !== null && !rigorAtLeast(best.minimumRigor, k.minimumRigor))
        ? k
        : best,
    undefined,
  );
  const floor = strongest?.minimumRigor ?? null;
  return RIGORS.map((value) => {
    const below = floor !== null && strongest !== undefined && !rigorAtLeast(value, floor);
    return {
      value,
      disabled: below,
      label: below
        ? `${RIGOR_LABEL[value]} (${strongest.label} needs ${RIGOR_LABEL[floor]} or more)`
        : RIGOR_LABEL[value],
    };
  });
}

/**
 * The "follow the project" option, with the rigor it comes to for this task: the project's default, or the
 * stronger minimum of one of the task's kinds, which it names.
 */
export function projectDefaultLabel(
  kinds: readonly KindDto[],
  taskKeys: readonly string[],
  projectDefault: Rigor,
): string {
  const effective = effectiveRigor({
    rigor: null,
    projectDefault,
    taskKinds: taskKeys.map((key) => ({ key })),
    kinds,
  });
  if (effective === projectDefault) return `Project default (${RIGOR_LABEL[effective]})`;
  const raiser = kinds.find((k) => taskKeys.includes(k.key) && k.minimumRigor === effective);
  return `Project default (${RIGOR_LABEL[effective]}${raiser === undefined ? '' : `, raised by ${raiser.label}`})`;
}
