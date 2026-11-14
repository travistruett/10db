import type { OutboundHit } from '@10db/contracts';

interface OutboundPattern {
  readonly name: string;
  readonly pattern: RegExp;
  /** A hold stops the send until the builder edits the text; a warning only shows on the preview. */
  readonly severity: 'hold' | 'warn';
}

// A path: a known source root, a relative file with an extension, or an absolute path of two or more parts.
// Product text is full of slashes ("and/or", "24/7", dates), so a bare `a/b` is not one.
const KNOWN_ROOT =
  /(?<![\w/.-])(?:\.{1,2}\/)?(?:src|apps|packages|lib|app|test|tests|docs|node_modules)\/[\w.@-]+(?:\/[\w.@-]+)*/;
const FILE_WITH_EXTENSION =
  /(?<![\w/:.-])(?:\.{0,2}\/)?[\w.@-]+(?:\/[\w.@-]+)*\/[\w@-]+\.[A-Za-z][A-Za-z0-9]{0,4}\b/;
const ABSOLUTE_PATH = /(?<![\w/:.-])\/[\w.@-]+(?:\/[\w.@-]+)+/;

/** What must not leave the laptop unreviewed, and what only deserves a second look. One row per pattern. */
export const OUTBOUND_PATTERNS: readonly OutboundPattern[] = [
  { name: 'private_key', pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/, severity: 'hold' },
  { name: 'aws_access_key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, severity: 'hold' },
  {
    name: 'github_token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})/,
    severity: 'hold',
  },
  {
    name: 'slack_token',
    pattern: /\b(?:xox[abposr]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,})/,
    severity: 'hold',
  },
  { name: 'anthropic_key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/, severity: 'hold' },
  {
    name: 'openai_key',
    pattern: /(?<![A-Za-z0-9])sk-(?!ant-)[A-Za-z0-9_-]{20,}/,
    severity: 'hold',
  },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/,
    severity: 'hold',
  },
  {
    name: 'credential_assignment',
    pattern: /\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\s*=\s*\S+/i,
    severity: 'hold',
  },
  {
    name: 'url',
    pattern: /\b(?:https?|ftp|wss?):\/\/\S+|\bwww\.[A-Za-z0-9-]+\.[A-Za-z]{2,}/i,
    severity: 'hold',
  },
  { name: 'code_block', pattern: /```/, severity: 'hold' },
  {
    name: 'file_path',
    pattern: new RegExp(
      [KNOWN_ROOT, FILE_WITH_EXTENSION, ABSOLUTE_PATH].map((r) => r.source).join('|'),
    ),
    severity: 'warn',
  },
];

/**
 * The patterns a drafted message hits, one hit per pattern per line, in line order. A hit names the
 * pattern and the line and never repeats what matched, so a secret is not copied into a card.
 */
export function scanOutbound(text: string): OutboundHit[] {
  const hits: OutboundHit[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const { name, pattern, severity } of OUTBOUND_PATTERNS) {
      if (pattern.test(line)) hits.push({ pattern: name, line: index + 1, severity });
    }
  });
  return hits;
}
