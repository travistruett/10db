import {
  KindDto,
  mintId,
  PersonaDto,
  PlaybookDto,
  RIGORS,
  StepRole,
  type KindId,
  type PlaybookCellDto,
  type PlaybookRowDto,
  type PlaybookSource,
  type Rigor,
} from '@10db/contracts';

const AT = '2026-10-01T10:00:00.000Z';

/** The steps each rigor runs before any scope changes them. */
const DEFAULT_STEPS: Readonly<Record<Rigor, readonly StepRole[]>> = {
  light: [StepRole.Implement],
  standard: [StepRole.Implement, StepRole.Review],
  careful: [StepRole.Plan, StepRole.Implement, StepRole.Review],
  critical: [StepRole.Plan, StepRole.PlanReview, StepRole.Implement, StepRole.Review, StepRole.Qa],
};

const DEFAULT_MINIMUM: Readonly<Record<Rigor, number>> = {
  light: 35,
  standard: 40,
  careful: 45,
  critical: 50,
};

/** The process each rigor runs before any scope changes it. */
const DEFAULT_PROCESS: Readonly<
  Record<
    Rigor,
    {
      readonly reviewRounds: number;
      readonly fixBy: 'resumed' | 'fresh';
      readonly approvesPlan: boolean;
      readonly ships: 'with_goal' | 'alone';
    }
  >
> = {
  light: { reviewRounds: 1, fixBy: 'resumed', approvesPlan: false, ships: 'with_goal' },
  standard: { reviewRounds: 1, fixBy: 'resumed', approvesPlan: false, ships: 'with_goal' },
  careful: { reviewRounds: 2, fixBy: 'fresh', approvesPlan: false, ships: 'alone' },
  critical: { reviewRounds: 2, fixBy: 'fresh', approvesPlan: true, ships: 'alone' },
};

const own = <T>(value: T, source: PlaybookSource = 'default') => ({ value, source });

/**
 * A playbook as the daemon answers it: every rigor's row and a cell for every rigor and role, all from 10db's
 * defaults unless a test changes one.
 */
export function playbookDto(
  over: {
    readonly rows?: readonly (Pick<PlaybookRowDto, 'rigor'> & Partial<PlaybookRowDto>)[];
    readonly cells?: readonly PlaybookCellDto[];
  } = {},
): PlaybookDto {
  const rows = RIGORS.map((rigor): PlaybookRowDto => ({
    rigor,
    steps: own([...DEFAULT_STEPS[rigor]]),
    reviewRounds: own(DEFAULT_PROCESS[rigor].reviewRounds),
    fixBy: own(DEFAULT_PROCESS[rigor].fixBy),
    approvesPlan: own(DEFAULT_PROCESS[rigor].approvesPlan),
    ships: own(DEFAULT_PROCESS[rigor].ships),
    ...over.rows?.find((r) => r.rigor === rigor),
  }));
  const cells = RIGORS.flatMap((rigor) =>
    Object.values(StepRole).map(
      (role): PlaybookCellDto =>
        over.cells?.find((c) => c.rigor === rigor && c.role === role) ?? {
          rigor,
          role,
          personaId: own(null),
          model: own(
            DEFAULT_STEPS[rigor].includes(role)
              ? { kind: 'automatic' as const, minimum: DEFAULT_MINIMUM[rigor] }
              : null,
          ),
          effort: own(null),
        },
    ),
  );
  return PlaybookDto.parse({ rows, cells });
}

/** A kind with the neutral defaults of a new one; a test names only what it is about. */
export function kindDto(over: Partial<KindDto> & { key: string }): KindDto {
  return KindDto.parse({
    id: mintId('Kind') satisfies KindId,
    label: over.key,
    description: '',
    minimumRigor: null,
    alwaysReviewed: false,
    failsAtLimit: false,
    ownCopy: false,
    toInbox: false,
    addsSteps: [],
    overrides: {},
    impliedBy: [],
    skills: [],
    position: 0,
    ...over,
  });
}

export function personaDto(
  over: Partial<PersonaDto> & { key: string; role: StepRole },
): PersonaDto {
  return PersonaDto.parse({
    id: mintId('Persona'),
    name: over.key,
    tools: 'read_only',
    instructions: '',
    skills: [],
    archived: false,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  });
}
