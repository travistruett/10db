// What the screen's one polite live region says (sessions UI spec §13.1): only what the builder acts on.
// Streaming text is never read aloud.

export type SessionEvent =
  | { readonly kind: 'replied'; readonly label: string; readonly text: string }
  | { readonly kind: 'asks'; readonly label: string }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'paused'; readonly resumes: string | null }
  | { readonly kind: 'needs_you'; readonly title: string; readonly project: string }
  | { readonly kind: 'delta' };

/** The reply's first sentence, or its first line when it has no full stop, at most 160 characters. */
export function firstSentence(text: string): string {
  const line =
    text
      .split('\n')
      .find((l) => l.trim() !== '')
      ?.trim() ?? '';
  const sentence = /^.+?[.!?](?=\s|$)/.exec(line)?.[0] ?? line;
  return sentence.slice(0, 160);
}

export function sessionAnnouncement(event: SessionEvent): string | null {
  switch (event.kind) {
    case 'replied': {
      const sentence = firstSentence(event.text);
      return sentence === '' ? `${event.label} replied` : `${event.label} replied: ${sentence}`;
    }
    case 'asks':
      return `${event.label} asks to run a command. Answer it above the message box.`;
    case 'stopped':
      return 'The session stopped';
    case 'paused':
      return event.resumes === null
        ? 'Paused: usage limit'
        : `Paused: usage limit, resumes ${event.resumes}`;
    case 'needs_you':
      return `${event.title} in ${event.project} needs you`;
    case 'delta':
      return null;
  }
}
