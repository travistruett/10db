import { ChatWorkStateDto } from '@10db/contracts';

/** A session's work state as the daemon reads it: reading, nothing changed, nothing to do next. */
export function chatWorkStateDto(overrides: Partial<ChatWorkStateDto> = {}): ChatWorkStateDto {
  return ChatWorkStateDto.parse({
    place: null,
    branch: null,
    base: null,
    baseBranch: 'main',
    dirtyFiles: 0,
    ahead: 0,
    uncommittedInCheckout: 0,
    touched: [],
    pullRequest: null,
    next: null,
    refusal: null,
    holder: null,
    ...overrides,
  });
}
