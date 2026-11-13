import {
  mintId,
  PersonDto,
  SlackConnectionDto,
  SlackMemberDto,
  StakeholderSendDto,
} from '@10db/contracts';

const AT = '2026-10-13T12:00:00.000Z';

export function personDto(overrides: Partial<PersonDto> & { readonly name: string }): PersonDto {
  return PersonDto.parse({
    id: mintId('Person'),
    handle: overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    isBuilder: false,
    slack: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}

export function slackContact(
  userId: string,
  over: Partial<{ sendMode: 'review' | 'auto'; dailyLimit: number | null }> = {},
) {
  return {
    teamId: 'T1',
    userId,
    dmChannelId: null,
    sendMode: 'review' as const,
    dailyLimit: 10 as number | null,
    ...over,
  };
}

export const BUILDER_PERSON = personDto({ name: 'Travis', handle: 'travis', isBuilder: true });

export function slackConnection(over: Record<string, unknown> = {}): SlackConnectionDto {
  return SlackConnectionDto.parse({
    state: 'off',
    teamId: null,
    teamName: null,
    botUserId: null,
    checkedAt: null,
    error: null,
    ...over,
  });
}

export function slackMember(over: Record<string, unknown> = {}): SlackMemberDto {
  return SlackMemberDto.parse({
    userId: 'U1',
    teamId: 'T1',
    name: 'mark',
    realName: 'Mark Ellis',
    title: 'Product',
    email: 'mark@acme.test',
    avatarUrl: null,
    ...over,
  });
}

/** A send as the daemon reports it, filling what a test does not care about. */
export function sendDto(over: Record<string, unknown> = {}): StakeholderSendDto {
  return StakeholderSendDto.parse({
    id: mintId('StakeholderSend'),
    inboxItemId: mintId('InboxItem'),
    state: 'draft',
    people: [{ personId: mintId('Person'), userId: 'U1', name: 'Mark', recipient: true }],
    text: "Travis's 10db build of *Demo* has a question for you.",
    hits: [],
    permalink: null,
    sentAt: null,
    remindedAt: null,
    answeredAt: null,
    returnedAt: null,
    returnedReason: null,
    heldBy: 'review',
    proposal: null,
    askedWhichWay: false,
    conversation: [],
    reply: null,
    replyVia: null,
    readAs: null,
    answeredBy: null,
    error: null,
    ...over,
  });
}
