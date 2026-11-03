// Shape spec §5.5: see_screen. The app's window draws its own screens; the daemon asks for them,
// checks what comes back and holds the window's token to reads (render-access.ts).

export {
  createScreenBroker,
  type ScreenBroker,
  type ScreenOutcome,
  type ScreenSpec,
} from './broker';
export { RENDER_READS, RENDER_REFUSED_READS, renderMayRead } from './render-access';
export { createScreens, type ScreenService } from './screens';
