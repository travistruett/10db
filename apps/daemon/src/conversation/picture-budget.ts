import { isImageFile, tooBigAlone } from './inline-budget';
import type { PictureLimits } from './picture-limits';

// The API refuses an image over a per-image size (10 MB as base64 on the Claude API, 5 MB on Bedrock), over
// 8000 px a side (less once a request holds more than 20 images) and a request over the account's limit, and a
// resumed session resends every earlier image with each request, so one oversize image would end every later
// turn. An image over a cap goes as a path, which `Read` takes in and resizes itself. The caps are those of the
// account the session runs on (`PictureLimits`).
export interface FileSize {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  /** Where the file is kept; its header is read to find a side the API would refuse. */
  readonly storedPath: string;
}

/**
 * The ids of the image files among `files` that go as content blocks, in order: each within the per-image
 * caps (bytes and pixels), together within the per-message cap, and within what is left of the
 * conversation's cap after `spent` bytes sent earlier (`inlineBytesSpent`). Every other image goes as a path.
 */
export function inlineImageIds(
  files: readonly FileSize[],
  spent: number,
  limits: PictureLimits,
): Set<string> {
  const ids = new Set<string>();
  for (const [id, verdict] of imageVerdicts(files, spent, limits))
    if (verdict === 'inline') ids.add(id);
  return ids;
}

/** Why an image goes as a path: it is too big alone, or a cap on what a message or the conversation carries is full. */
export type PathReason = 'too-big' | 'message-full' | 'conversation-full';

/** What the `[file]` line says of an image that goes as a path, before "; Read it". */
export const pathReasonText = (reason: PathReason, limits: PictureLimits): string => {
  switch (reason) {
    case 'too-big':
      return 'too large to show inline';
    case 'message-full':
      return 'left out to keep this message within the image limit';
    case 'conversation-full':
      return `left out to keep the conversation within the image limit (${limits.limitText})`;
  }
};

/** What becomes of each image among `files`: sent as a block, or as a path for this reason. */
function imageVerdicts(
  files: readonly FileSize[],
  spent: number,
  limits: PictureLimits,
): Map<string, 'inline' | PathReason> {
  const verdicts = new Map<string, 'inline' | PathReason>();
  let total = 0;
  for (const file of files) {
    if (!isImageFile(file)) continue;
    if (tooBigAlone(file, limits)) verdicts.set(file.id, 'too-big');
    else if (total + file.size > limits.messageMaxBytes) verdicts.set(file.id, 'message-full');
    else if (spent + total + file.size > limits.inlineMaxBytes)
      verdicts.set(file.id, 'conversation-full');
    else {
      total += file.size;
      verdicts.set(file.id, 'inline');
    }
  }
  return verdicts;
}

/**
 * The images among `shown` (the files a message names) that reach Claude as a path alone, each with why,
 * when `sent` (the files whose images the message carries) go as `inlineImageIds` says after `spent`
 * bytes sent earlier: an image over the per-image cap or the API's pixel limit ('too-big'), or one of
 * `sent` the per-message or conversation cap left out. Any other shown image outside `sent` was sent earlier.
 */
export function pathImageReasons(
  shown: readonly FileSize[],
  sent: readonly FileSize[],
  spent: number,
  limits: PictureLimits,
): Map<string, PathReason> {
  const verdicts = imageVerdicts(sent, spent, limits);
  const reasons = new Map<string, PathReason>();
  for (const file of shown) {
    if (!isImageFile(file)) continue;
    if (tooBigAlone(file, limits)) {
      reasons.set(file.id, 'too-big');
      continue;
    }
    const verdict = verdicts.get(file.id);
    if (verdict !== undefined && verdict !== 'inline') reasons.set(file.id, verdict);
  }
  return reasons;
}
