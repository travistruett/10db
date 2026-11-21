// Sessions spec §6.1: what every conversation shares, whoever owns it: the picture limits and budget,
// the checks a file or a pasted picture must pass and how a picture is kept, the delivery rules and
// library, the builder-message intake, and the engine that runs every explore conversation's session.

export { heldInlineBytes } from './block-pictures';
export { createDelivery } from './delivery';
export {
  outgoingMessage,
  readBackAsk,
  type DeliverableMessage,
  type OutgoingMessage,
} from './delivery-rules';
export { BUSY } from './explore-runtime';
export { openTerminalRefusal } from './explore-state';
export { createExploreEngine, type ExploreEngine } from './explore-engine';
export { itemsWithFull, readFullOutput } from './full-output';
export { itemDtoOf } from './item-dto';
export { createItemRecorder, type ItemRecorder } from './item-recorder';
export { createLiveRegistry, type LiveRegistry } from './live-registry';
export type { ExploreOwnerHooks, ExploreStart, Outgoing, TurnEnd } from './explore-hooks';
export { safeFileName } from './file-check';
export { classifyBytes, DroppedKind } from './file-kind';
export { officeText } from './office-text';
export { keepPdfText, pdfTextPath } from './pdf-text';
export { keepBuilderMessage, type PastedFile } from './intake';
export { buildThreadDigest, builderMessageText, FRESH_SESSION_NOTICE } from './lane-text';
export { readConversationPicture } from './pictures';
export { taskFilesDir } from './task-files';
export { createTaskThread, type TaskThread } from './task-thread';
export { readImageHeader } from './image-check';
export {
  FRESH_START_LINE,
  READ_CHARGE_MAX_BYTES,
  carriedTooMuch,
  inlineBytesSpent,
  inlinePictureBytes,
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
