// Sessions spec §6.1: what every conversation shares, whoever owns it: the picture limits and budget,
// the checks a file or a pasted picture must pass, and how a picture is kept.

export { blockPictures, heldInlineBytes, type HeldFile } from './block-pictures';
export { createDelivery, type Delivery, type DeliveryDeps } from './delivery';
export {
  clientUuid,
  outgoingMessage,
  pushedAgainAfter,
  type DeliverableFile,
  type DeliverableMessage,
  type MessageText,
  type OutgoingMessage,
} from './delivery-rules';
export { refuseMislabelledBytes, safeFileName } from './file-check';
export { keepBuilderMessage, removeKeptFiles, type MessageLimits, type PastedFile } from './intake';
export { readImageHeader, readImageSize, type ImageHeader, type ImageSize } from './image-check';
export {
  FRESH_START_LINE,
  READ_CHARGE_MAX_BYTES,
  carriedTooMuch,
  inlineBytesSpent,
  inlinePictureBytes,
  isImageName,
  largestReadMeasured,
  liveMessages,
  parseScreenBody,
  readAllowance,
  readBytesSpent,
  readCountedLine,
  readMeasuredLine,
  readPictureCap,
  tooBigAlone,
  unmeasuredRead,
  type CarriedTooMuch,
  type ReadKind,
} from './inline-budget';
export {
  inlineImageIds,
  pathImageReasons,
  pathReasonText,
  type FileSize,
  type PathReason,
} from './picture-budget';
export {
  STRICTEST_LIMITS,
  pictureLimitsFor,
  poolBytes,
  type PictureLimits,
  type PicturePlatform,
} from './picture-limits';
export { checkPicture, keepPicture, type CheckedPicture, type KeptPicture } from './pictures';
