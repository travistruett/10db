import { KindDto, mintId } from '@10db/contracts';

/** A kind with no minimum rigor and no switches, as the daemon lists it. */
export function kindDto(overrides: Partial<KindDto> = {}): KindDto {
  return KindDto.parse({
    id: mintId('Kind'),
    key: 'docs',
    label: 'Docs',
    description: '',
    minimumRigor: null,
    alwaysReviewed: false,
    failsAtLimit: false,
    ownCopy: false,
    toInbox: false,
    addsSteps: [],
    overrides: {},
    position: 0,
    ...overrides,
  });
}
