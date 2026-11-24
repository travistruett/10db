import type { BrowserAnswer, BrowserToolInputs, ScreenViewport } from '@10db/contracts';
import type { z } from 'zod';
import type { BrowserLaunch } from '../pictures';

/** A file a lane uploads, read and checked by the handler: the driver never opens a path. */
export interface UploadFile {
  readonly name: string;
  readonly mimeType: string;
  readonly buffer: Uint8Array;
}

/** One launched browser, driven for one session; every method settles or throws, never hangs. */
export interface LaneDriver {
  open(
    url: string,
    viewport: ScreenViewport | undefined,
    signal: AbortSignal,
  ): Promise<BrowserAnswer>;
  snapshot(signal: AbortSignal): Promise<BrowserAnswer>;
  act(
    input: z.output<(typeof BrowserToolInputs)['browser_act']>,
    signal: AbortSignal,
  ): Promise<BrowserAnswer>;
  /** The files' bytes, read and checked by the handler (`readUploads`); the driver never opens a path. */
  upload(ref: string, files: readonly UploadFile[], signal: AbortSignal): Promise<BrowserAnswer>;
  screenshot(
    fullPage: boolean,
    signal: AbortSignal,
  ): Promise<{
    readonly png: Uint8Array;
    readonly url: string;
    readonly title: string;
    readonly viewport: ScreenViewport;
  }>;
  isConnected(): boolean;
  close(): Promise<void>;
}

export type LaunchLaneDriver = (options: BrowserLaunch) => Promise<LaneDriver>;
