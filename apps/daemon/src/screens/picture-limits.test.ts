import { AccountKind } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import {
  STRICTEST_LIMITS,
  pictureLimitsFor,
  poolBytes,
  type PictureLimits,
} from './picture-limits';

// Shape spec §5.4. The picture budget is worked out from the request limit of the account a conversation runs
// on. The figures are the docs' as checked 2026-11-05: 128 MB a request on the Claude API, 20 MB on Amazon
// Bedrock; 10 MB (Claude API) or 5 MB (Bedrock) an image as base64; 8000 px a side, and 3000 px a side as the
// most that is safe once a request holds more than 20 images.

const base64Of = (bytes: number): number => Math.ceil(bytes / 3) * 4;
const REQUEST_LIMIT = { claude: 128_000_000, bedrock: 20_000_000 } as const;
const IMAGE_LIMIT = { claude: 10_000_000, bedrock: 5_000_000 } as const;

describe('the picture limits of an account', () => {
  it.each([
    [AccountKind.ClaudeSubscription, 'claude'],
    [AccountKind.AnthropicApiKey, 'claude'],
    [AccountKind.Bedrock, 'bedrock'],
  ] as const)('%s runs on the %s platform', (kind, platform) => {
    expect(pictureLimitsFor(kind).platform).toBe(platform);
  });

  it('holds a gateway to the smallest limits it knows, since nothing says what stands behind it', () => {
    const gateway = pictureLimitsFor(AccountKind.Gateway);
    expect(gateway.platform).toBe('gateway');
    expect({ ...gateway, platform: 'bedrock', limitText: '' }).toEqual({
      ...pictureLimitsFor(AccountKind.Bedrock),
      limitText: '',
    });
  });

  it.each(['claude', 'bedrock'] as const)(
    'keeps the pool, as base64, under the %s request limit with room left for text',
    (platform) => {
      const limits = pictureLimitsFor(
        platform === 'claude' ? AccountKind.ClaudeSubscription : AccountKind.Bedrock,
      );
      expect(base64Of(poolBytes(limits))).toBeLessThan(REQUEST_LIMIT[platform]);
      // A 1M-token context is about 4 MB of text; the rest of the request is tool calls and framing.
      expect(REQUEST_LIMIT[platform] - base64Of(poolBytes(limits))).toBeGreaterThanOrEqual(
        4_500_000,
      );
    },
  );

  it.each(['claude', 'bedrock'] as const)(
    'keeps one picture, as base64, under the %s per-image limit',
    (platform) => {
      const limits = pictureLimitsFor(
        platform === 'claude' ? AccountKind.ClaudeSubscription : AccountKind.Bedrock,
      );
      expect(base64Of(limits.imageMaxBytes)).toBeLessThan(IMAGE_LIMIT[platform]);
      expect(limits.imageMaxBytes).toBeLessThanOrEqual(limits.inlineMaxBytes);
      expect(limits.messageMaxBytes).toBeLessThanOrEqual(limits.inlineMaxBytes);
    },
  );

  it('is sized from 128 MB on the Claude API, well over what 32 MB allowed, and from 20 MB on Bedrock', () => {
    const claude = pictureLimitsFor(AccountKind.ClaudeSubscription);
    const bedrock = pictureLimitsFor(AccountKind.Bedrock);
    expect(poolBytes(claude)).toBeGreaterThan(21 * 1024 * 1024);
    expect(poolBytes(claude)).toBeGreaterThan(poolBytes(bedrock) * 5);
    expect(bedrock.imageMaxBytes).toBeGreaterThan(2 * 1024 * 1024);
    expect(claude.imageMaxBytes).toBeGreaterThan(bedrock.imageMaxBytes);
  });

  it('keeps pictures to 3000 px a side on every platform: the most that is safe past 20 images', () => {
    for (const kind of [
      AccountKind.ClaudeSubscription,
      AccountKind.AnthropicApiKey,
      AccountKind.Bedrock,
      AccountKind.Gateway,
    ])
      expect(pictureLimitsFor(kind).imageMaxSide).toBe(3000);
  });

  it('names the limit that applies, and never 32 MB', () => {
    const texts = [
      AccountKind.ClaudeSubscription,
      AccountKind.AnthropicApiKey,
      AccountKind.Bedrock,
      AccountKind.Gateway,
    ].map((kind) => pictureLimitsFor(kind).limitText);
    expect(texts[0]).toContain('128 MB');
    expect(texts[2]).toContain('20 MB');
    expect(texts[3]).toContain('20 MB');
    for (const text of texts) expect(text).not.toMatch(/32 ?M/);
  });

  it('answers the strictest limits for an account kind it does not know', () => {
    expect(pictureLimitsFor(AccountKind.OpenaiApiKey)).toBe(STRICTEST_LIMITS);
    expect(poolBytes(STRICTEST_LIMITS)).toBe(poolBytes(pictureLimitsFor(AccountKind.Bedrock)));
  });

  it('keeps every figure whole bytes', () => {
    const limits: PictureLimits = pictureLimitsFor(AccountKind.Bedrock);
    for (const value of [
      limits.imageMaxBytes,
      limits.messageMaxBytes,
      limits.inlineMaxBytes,
      limits.readReserveBytes,
    ])
      expect(Number.isInteger(value)).toBe(true);
  });
});
