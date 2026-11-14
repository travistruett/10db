import { describe, expect, it } from 'vitest';
import { sessionAnnouncement, type SessionEvent } from './session-announcements';

describe('sessionAnnouncement', () => {
  const rows: readonly {
    readonly name: string;
    readonly event: SessionEvent;
    readonly want: string | null;
  }[] = [
    {
      name: 'a reply says its first sentence',
      event: {
        kind: 'replied',
        label: 'Claude Code',
        text: '\nIt retries once. Then it gives up.\nMore.',
      },
      want: 'Claude Code replied: It retries once.',
    },
    {
      name: 'a reply with no full stop says its first line',
      event: { kind: 'replied', label: 'Claude Code', text: 'Looks fine\nsecond' },
      want: 'Claude Code replied: Looks fine',
    },
    {
      name: 'an empty reply still says who replied',
      event: { kind: 'replied', label: 'Claude Code', text: '' },
      want: 'Claude Code replied',
    },
    {
      name: 'a card asks',
      event: { kind: 'asks', label: 'Claude Code' },
      want: 'Claude Code asks to run a command. Answer it above the message box.',
    },
    { name: 'a stop', event: { kind: 'stopped' }, want: 'The session stopped' },
    {
      name: 'a pause with its time',
      event: { kind: 'paused', resumes: '15:40' },
      want: 'Paused: usage limit, resumes 15:40',
    },
    {
      name: 'a pause with no time',
      event: { kind: 'paused', resumes: null },
      want: 'Paused: usage limit',
    },
    {
      name: 'another tab that needs you',
      event: { kind: 'needs_you', title: 'Login fails', project: 'ampsio' },
      want: 'Login fails in ampsio needs you',
    },
    { name: 'a streaming delta is never read', event: { kind: 'delta' }, want: null },
  ];
  it.each(rows)('$name', ({ event, want }) => {
    expect(sessionAnnouncement(event)).toBe(want);
  });
});
