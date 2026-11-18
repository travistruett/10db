import { GithubStatusDto } from '@10db/contracts';

/** gh signed in as octocat, no Sign In running. */
export function githubStatusDto(overrides: Partial<GithubStatusDto> = {}): GithubStatusDto {
  return GithubStatusDto.parse({
    state: 'signed_in',
    login: 'octocat',
    checkedAt: '2026-11-12T10:00:00.000Z',
    signingIn: null,
    ...overrides,
  });
}
