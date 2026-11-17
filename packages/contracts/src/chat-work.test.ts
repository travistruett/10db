import { describe, expect, it } from 'vitest';
import {
  ArchivePreviewDto,
  ArchiveRequest,
  ChatCommitRequest,
  ChatSearchPage,
  ChatSearchQuery,
  ChatWork,
  ChatWorkChoice,
  ChatWorkStateDto,
  ConversationItemBody,
} from './index';

const AT = '2026-11-17T10:00:00.000Z';
const work = {
  place: 'branch',
  branch: 'fix-login',
  base: 'main',
  worktree: '/w/x',
  askedAt: null,
};
const state = {
  place: 'branch',
  branch: 'fix-login',
  base: 'abc123',
  baseBranch: 'main',
  dirtyFiles: 2,
  ahead: 1,
  uncommittedInCheckout: 0,
  touched: ['a.ts'],
  pullRequest: {
    number: 4,
    url: 'https://github.com/o/r/pull/4',
    checks: { passed: 1, total: 2, failing: 0 },
    mergeable: null,
    merged: false,
  },
  next: 'open_pull_request',
  refusal: null,
  holder: null,
};

interface Schema {
  safeParse(v: unknown): { success: boolean };
}

describe('chat-work contracts', () => {
  it.each<{ name: string; schema: Schema; value: unknown }>([
    { name: 'a branch work', schema: ChatWork, value: work },
    {
      name: 'a choosing work with askedAt',
      schema: ChatWork,
      value: { ...work, place: 'choosing', branch: null, base: null, worktree: null, askedAt: AT },
    },
    { name: 'a branch with no worktree', schema: ChatWork, value: { ...work, worktree: null } },
    { name: 'a choice of here', schema: ChatWorkChoice, value: { place: 'here' } },
    { name: 'a choice of branch', schema: ChatWorkChoice, value: { place: 'branch' } },
    { name: 'a full state', schema: ChatWorkStateDto, value: state },
    {
      name: 'a reading state',
      schema: ChatWorkStateDto,
      value: { ...state, place: null, next: null, pullRequest: null, branch: null, base: null },
    },
    { name: 'a commit', schema: ChatCommitRequest, value: { message: 'Fix', paths: ['a.ts'] } },
    {
      name: 'an archive preview',
      schema: ArchivePreviewDto,
      value: { worktree: null, branch: null, uncommitted: [], ignored: [] },
    },
    { name: 'an empty archive request', schema: ArchiveRequest, value: {} },
    {
      name: 'an archive request',
      schema: ArchiveRequest,
      value: { uncommitted: ['a'], ignored: [] },
    },
    { name: 'a search query', schema: ChatSearchQuery, value: { q: 'login', after: 'c' } },
    { name: 'an empty search page', schema: ChatSearchPage, value: { rows: [], next: null } },
    {
      name: 'a carry-on message',
      schema: ConversationItemBody.message,
      value: { text: 'Carry on', purpose: 'carry_on' },
    },
    {
      name: 'a brief message',
      schema: ConversationItemBody.message,
      value: { text: 'b', purpose: 'brief' },
    },
  ])('$name parses', ({ schema, value }) => {
    expect(schema.safeParse(value).success).toBe(true);
  });

  it.each<{ name: string; schema: Schema; value: unknown }>([
    { name: 'an unknown place', schema: ChatWork, value: { ...work, place: 'reading' } },
    { name: 'a work without a place', schema: ChatWork, value: { branch: null } },
    { name: 'a choice of moving', schema: ChatWorkChoice, value: { place: 'moving' } },
    { name: 'a choice with extra keys', schema: ChatWorkChoice, value: { place: 'here', x: 1 } },
    { name: 'a negative count', schema: ChatWorkStateDto, value: { ...state, ahead: -1 } },
    { name: 'an unknown next step', schema: ChatWorkStateDto, value: { ...state, next: 'push' } },
    {
      name: 'checks that are not counts',
      schema: ChatWorkStateDto,
      value: { ...state, pullRequest: { ...state.pullRequest, checks: { passed: 'a' } } },
    },
    {
      name: 'a commit with no message',
      schema: ChatCommitRequest,
      value: { message: ' ', paths: ['a'] },
    },
    {
      name: 'a commit with no paths',
      schema: ChatCommitRequest,
      value: { message: 'm', paths: [] },
    },
    {
      name: 'a preview with a missing list',
      schema: ArchivePreviewDto,
      value: { worktree: null, branch: null },
    },
    {
      name: 'an archive request with a number',
      schema: ArchiveRequest,
      value: { uncommitted: [1] },
    },
    {
      name: 'a search over 200 characters',
      schema: ChatSearchQuery,
      value: { q: 'a'.repeat(201) },
    },
    { name: 'a page with a bad row', schema: ChatSearchPage, value: { rows: [{}], next: null } },
    {
      name: 'an unknown message purpose',
      schema: ConversationItemBody.message,
      value: { text: 't', purpose: 'other' },
    },
  ])('$name is refused', ({ schema, value }) => {
    expect(schema.safeParse(value).success).toBe(false);
  });
});
