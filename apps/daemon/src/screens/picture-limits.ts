import { AccountKind } from '@10db/contracts';

// Shape spec §5.4. How many picture and PDF bytes a conversation's session may carry, worked out from the
// request limit of the account it runs on. A resumed session resends every earlier picture with each request,
// so these are the limits of the account that resumes the conversation, not only of the one that began it.
//
// The figures are the live docs', checked 2026-11-05:
// - Request size: 128 MB on the Claude API (platform.claude.com/docs/en/api/overview, "Request size limits");
//   20 MB on Amazon Bedrock (platform.claude.com/docs/en/build-with-claude/claude-on-amazon-bedrock).
// - One image: 10 MB as base64 on the Claude API, 5 MB as base64 (3.75 MB raw) on Bedrock; 8000 x 8000 px at
//   most; 600 images a request (platform.claude.com/docs/en/build-with-claude/vision, "Image limits and costs").
// - A request with more than 20 images applies a stricter pixel limit to all of them, counting earlier turns,
//   tool results and, on Bedrock, PDFs; 3000 px a side is safe on every platform.
// - PDFs: 600 pages a request (100 under a 1M context), inside the request size limit
//   (platform.claude.com/docs/en/build-with-claude/pdf-support).

const MIB = 1024 * 1024;

export type PicturePlatform = 'claude' | 'bedrock' | 'gateway';

export interface PictureLimits {
  readonly platform: PicturePlatform;
  /** The request limit, as a notice or a refusal states it: names the platform and the figure. */
  readonly limitText: string;
  /**
   * The largest image sent as a content block. Base64 grows it by 4/3 and the API counts the base64: 7 MiB is
   * 9.8 MB under the Claude API's 10 MB, 3.5 MiB is 4.9 MB under Bedrock's 5 MB.
   */
  readonly imageMaxBytes: number;
  /**
   * The longest side of an image sent as a content block. The API takes at most 8000 px a side, and a request
   * with more than 20 images takes less: a conversation's screens (12) and dropped images (20) can pass that
   * together, and a request that failed on it would fail every later turn too. 3000 px is safe on every
   * platform. Claude Code is not known to shrink an image block, so a larger one goes as a path, which `Read`
   * resizes.
   */
  readonly imageMaxSide: number;
  /**
   * The most image bytes one message carries as content blocks. The docs set no such limit; it keeps one turn
   * from taking a conversation's whole budget.
   */
  readonly messageMaxBytes: number;
  /** The most image bytes a whole conversation carries, dropped images and screens together. */
  readonly inlineMaxBytes: number;
  /**
   * What pictures and PDF pages Claude pulls in with `Read` may add on top of a full inline budget. The two
   * share one pool of their sum (`poolBytes`): Reads may use whatever the inline pictures leave of it, and an
   * inline picture whatever the Reads leave.
   */
  readonly readReserveBytes: number;
}

/**
 * 84 MiB of pictures is 117 MB as base64, which leaves about 10 MB of the 128 MB for text: a 1M-token context
 * is about 4 MB, and the rest is tool calls and framing.
 */
const CLAUDE_LIMITS: PictureLimits = {
  platform: 'claude',
  limitText: "the Claude API's 128 MB request limit",
  imageMaxBytes: 7 * MIB,
  imageMaxSide: 3000,
  messageMaxBytes: 18 * MIB,
  inlineMaxBytes: 72 * MIB,
  readReserveBytes: 12 * MIB,
};

/**
 * 11 MiB of pictures is 15.4 MB as base64, which leaves about 4.6 MB of Bedrock's 20 MB for text. PDFs count
 * here too: a Read PDF's pages are charged to the same pool as its pictures.
 */
const BEDROCK_LIMITS: PictureLimits = {
  platform: 'bedrock',
  limitText: "Amazon Bedrock's 20 MB request limit",
  imageMaxBytes: Math.floor(3.5 * MIB),
  imageMaxSide: 3000,
  messageMaxBytes: 6 * MIB,
  inlineMaxBytes: 8 * MIB,
  readReserveBytes: 3 * MIB,
};

/**
 * A gateway forwards to a platform 10db can't see, so it is held to the smallest request limit of the
 * platforms it knows (Bedrock's).
 */
const GATEWAY_LIMITS: PictureLimits = {
  ...BEDROCK_LIMITS,
  platform: 'gateway',
  limitText:
    'the 20 MB request limit 10db assumes for a gateway (the smallest of the platforms it knows)',
};

/** What an account of a kind 10db can't place is held to: the smallest limits there are. */
export const STRICTEST_LIMITS: PictureLimits = BEDROCK_LIMITS;

/** The limits of the account a session runs on. */
export function pictureLimitsFor(kind: AccountKind): PictureLimits {
  switch (kind) {
    case AccountKind.ClaudeSubscription:
    case AccountKind.AnthropicApiKey:
      return CLAUDE_LIMITS;
    case AccountKind.Bedrock:
      return BEDROCK_LIMITS;
    case AccountKind.Gateway:
      return GATEWAY_LIMITS;
    case AccountKind.OpenaiApiKey:
    case AccountKind.CodexSignin:
    case AccountKind.OpenRouter:
      return STRICTEST_LIMITS;
  }
}

/** The pool inline pictures and Read pictures and PDFs draw on together, in bytes before base64. */
export const poolBytes = (limits: PictureLimits): number =>
  limits.inlineMaxBytes + limits.readReserveBytes;
