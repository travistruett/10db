// Shape spec §5.5: see_screen. The app's window draws its own screens; the daemon asks for them,
// checks what comes back and holds the window's token to reads (render-access.ts).

export { createScreenBroker, type ScreenOutcome } from './broker';
export { readImageSize } from './image-check';
export {
  FRESH_START_LINE,
  INLINE_CONVERSATION_MAX_BYTES,
  PICTURE_POOL_BYTES,
  READ_CHARGE_MAX_BYTES,
  READ_RESERVE_BYTES,
  inlineBytesSpent,
  inlinePictureBytes,
  isImageName,
  largestReadMeasured,
  parseScreenBody,
  readAllowance,
  readBytesSpent,
  readCountedLine,
  readMeasuredLine,
  tooBigAlone,
  unmeasuredRead,
  type ReadKind,
} from './inline-budget';
export { RENDER_READS, RENDER_REFUSED_READS, renderMayRead } from './render-access';
export { createScreens, type ScreenService } from './screens';
