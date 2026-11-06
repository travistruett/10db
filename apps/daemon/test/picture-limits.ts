import type { PictureLimits } from '../src/screens';

const MIB = 1024 * 1024;

/**
 * Round, small figures for tests that exercise how the picture budget works (what goes inline, what goes as a
 * path, when a Read is refused) without dropping tens of megabytes: an 18 MiB inline budget and a 3 MiB Read
 * reserve, 2 MiB an image, 6 MiB a message, 2000 px a side. They are not an account's limits; the tests that
 * check those use `pictureLimitsFor`.
 */
export const ROUND_LIMITS: PictureLimits = {
  platform: 'claude',
  limitText: 'the round test limit',
  imageMaxBytes: 2 * MIB,
  imageMaxSide: 2000,
  messageMaxBytes: 6 * MIB,
  inlineMaxBytes: 18 * MIB,
  readReserveBytes: 3 * MIB,
};
