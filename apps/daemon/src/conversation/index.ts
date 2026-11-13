// Sessions spec §6.1: what every conversation shares, whoever owns it: the picture limits and budget,
// the checks a file or a pasted picture must pass and how a picture is kept, the delivery rules and
// library, and the builder-message intake.

export { heldInlineBytes } from './block-pictures';
export { createDelivery } from './delivery';
export {
  ExploreEffect,
  reduceExplore,
  type ExploreEvent,
  type ExploreFacts,
  type ExploreOutcome,
} from './explore-state';
export { outgoingMessage, type DeliverableMessage, type OutgoingMessage } from './delivery-rules';
export { refuseMislabelledBytes, safeFileName } from './file-check';
export { keepBuilderMessage, removeKeptFiles, type PastedFile } from './intake';
export { readImageHeader, readImageSize } from './image-check';
export {
  FRESH_START_LINE,
  READ_CHARGE_MAX_BYTES,
  carriedTooMuch,
  inlineBytesSpent,
  inlinePictureBytes,
  largestReadMeasured,
  parseScreenBody,
  readAllowance,
  readBytesSpent,
  readCountedLine,
  readMeasuredLine,
  readPictureCap,
  unmeasuredRead,
  type ReadKind,
} from './inline-budget';
export { inlineImageIds, pathImageReasons, pathReasonText } from './picture-budget';
export {
  STRICTEST_LIMITS,
  pictureLimitsFor,
  poolBytes,
  type PictureLimits,
} from './picture-limits';
