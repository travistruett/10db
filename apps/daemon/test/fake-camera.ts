import type { BrowserStatus, PageCamera, ShootInput, Shot, ShotOutcome } from '../src/pictures';
import { pngOfSize } from './png';

// The browser for pictures is a child process 10db does not own: daemon tests take pictures with this.

/** The browser, faked: answers each shot with the page's current bytes, or as told. */
export class FakeCamera implements PageCamera {
  readonly shots: ShootInput[] = [];
  /** The browser's state as each shot was asked. */
  readonly shotWhile: string[] = [];
  readonly signIns: string[] = [];
  /** Told of each shot as it is asked, before it is answered. */
  onShoot: ((input: ShootInput) => void) | null = null;
  /** The app's look: changes the bytes a clean shot answers. */
  version = 1;
  /** Outcomes to answer, in order, before answering clean. */
  outcomes: ShotOutcome[] = [];
  /** What an `overlay` answer says the dev server's error overlay shows. */
  overlayText = 'Failed to compile';
  private browser: BrowserStatus = { state: 'ready', problem: null };
  private held: { release: () => void } | null = null;
  private holdNext = false;

  /** The next shot waits until the answer is released. */
  hold(): void {
    this.holdNext = true;
  }
  release(): void {
    this.held?.release();
    this.held = null;
  }
  get holding(): boolean {
    return this.held !== null;
  }
  /** The browser's build was refused, saying why. */
  refuse(problem: string): void {
    this.browser = { state: 'refused', problem };
  }
  fetching(): () => void {
    let done: (ok: boolean) => void = () => undefined;
    const ready = new Promise<boolean>((resolve) => {
      done = resolve;
    });
    this.browser = { state: 'fetching', problem: null, ready };
    return () => {
      this.browser = { state: 'ready', problem: null };
      done(true);
    };
  }

  async shoot(input: ShootInput): Promise<Shot> {
    this.shots.push(input);
    this.shotWhile.push(this.browser.state);
    this.onShoot?.(input);
    if (this.holdNext) {
      this.holdNext = false;
      await new Promise<void>((resolve, reject) => {
        this.held = { release: resolve };
        input.signal.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
    }
    const outcome = this.outcomes.shift() ?? 'clean';
    const png =
      outcome === 'clean' || outcome === 'overlay'
        ? pngOfSize(input.viewport.width, input.viewport.height, this.version)
        : null;
    return {
      outcome,
      png,
      width: input.viewport.width,
      height: input.viewport.height,
      landedUrl: `${input.appUrl}${input.route}`,
      overlayText: outcome === 'overlay' ? this.overlayText : null,
      reason: outcome === 'failed' ? 'HTTP 500' : null,
    };
  }
  signIn(input: { url: string }): Promise<never> {
    this.signIns.push(input.url);
    return Promise.resolve({ cookies: [], origins: [] } as never);
  }
  status(): BrowserStatus {
    return this.browser;
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}
