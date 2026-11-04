// Shape spec §5.5: see_screen. The app's window draws its own screens; the daemon asks for them,
// checks what comes back and holds the window's token to reads (render-access.ts).

<<<<<<< 93738ab9eca1046a9861462b59e02b9d10fe8414
export { createScreenBroker } from './broker';
export { readImageSize } from './image-check';
||||||| 83a19a1
export { createScreenBroker } from './broker';
=======
export { createScreenBroker, type ScreenOutcome } from './broker';
export {
  INLINE_CONVERSATION_MAX_BYTES,
  INLINE_IMAGE_MAX_BYTES,
  inlineBytesSpent,
  isImageName,
} from './inline-budget';
>>>>>>> 7bd48fdc156d7ecd81857be284588621434fee9b
export { RENDER_READS, RENDER_REFUSED_READS, renderMayRead } from './render-access';
export { createScreens, type ScreenService } from './screens';
