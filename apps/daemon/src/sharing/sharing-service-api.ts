import { DomainError, type PutSharingBody, type SharingStatusDto } from '@10db/contracts';
import type { ListenerAllowlists } from '../listeners';

export interface SharingService {
  /** The cache, at once; also starts a refresh (not awaited) when the last one is over 10 s old. */
  status(): SharingStatusDto;
  /** Share, Stop or change the port. Throws `SharingRefusedError`. */
  set(body: PutSharingBody): Promise<SharingStatusDto>;
  /** The builder's Get Certificate: runs the first probe for a name with no certificate. */
  requestCertificate(): Promise<SharingStatusDto>;
  /** Turn on Tailscale: runs `tailscale up`, then reads the status again. Throws `SharingRefusedError` with the CLI's words. */
  connect(): Promise<SharingStatusDto>;
  /** For the share listener; null until sharing is Ready with a known name. */
  allowlists(): ListenerAllowlists | null;
  hostLogin(): string | null;
  /** At daemon start; never throws. */
  start(): Promise<void>;
  /** At shutdown: unshare, then close. */
  stop(): Promise<void>;
}

/** A Share, Stop or certificate request 10db refuses; the API answers it as a 409 with its sentence. */
export class SharingRefusedError extends DomainError {
  override readonly name: string = 'SharingRefusedError';
  constructor(message: string) {
    super('conflict', message);
  }
}
