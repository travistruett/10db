// Shape spec §5.5: see_screen. The app's window draws its own screens; the daemon asks for them,
// checks what comes back and holds the window's token to reads (render-access.ts).

export { createScreenBroker, type ScreenOutcome } from './broker';
export { refuseMislabelledBytes, safeFileName } from './file-check';
export { readImageSize } from './image-check';
export {
  STRICTEST_LIMITS,
  pictureLimitsFor,
  poolBytes,
  type PictureLimits,
} from './picture-limits';
export {
  FRESH_START_LINE,
  READ_CHARGE_MAX_BYTES,
  carriedTooMuch,
  inlineBytesSpent,
  inlinePictureBytes,
  isImageName,
  largestReadMeasured,
  parseScreenBody,
  readAllowance,
  readBytesSpent,
  readPictureCap,
  readCountedLine,
  readMeasuredLine,
  tooBigAlone,
  unmeasuredRead,
  type ReadKind,
} from './inline-budget';
export { DEV_UI_READS, DEV_UI_REFUSED_READS, devUiMayRead } from './dev-ui-access';
export { RENDER_READS, RENDER_REFUSED_READS, renderMayRead } from './render-access';
export { createScreens, type ScreenService } from './screens';
