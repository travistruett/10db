import {
  SharingState,
  SharingStep,
  SharingStepStatus,
  type SharingStatusDto,
} from '@10db/contracts';
import { isTendbMapping, type ServeStatus } from './serve-mapping';
import type { TailscaleSelf } from './tailscale-cli';

/** What the checklist and state are worked out from: the service's readings, nothing it must still fetch. */
export interface SharingStatusInput {
  readonly cli: string | null;
  readonly enabled: boolean;
  readonly port: number;
  readonly self: TailscaleSelf | null;
  readonly selfError: string | null;
  /** True while the share listener is open. */
  readonly listening: boolean;
  readonly serve: ServeStatus | null;
  /** The builder pressed Get Certificate for this name. */
  readonly certificateRequested: boolean;
  readonly certificateExists: boolean;
  readonly certificateError: string | null;
  readonly pausedReason: string | null;
  readonly portHolder: string | null;
}

/** The Remote Access checklist and the state it adds up to; pure. */
export function computeSharingStatus(input: SharingStatusInput): SharingStatusDto {
  const { cli, enabled, port, self, selfError } = input;
  const fqdn = self?.fqdn ?? null;
  const mapped =
    input.listening &&
    input.serve !== null &&
    fqdn !== null &&
    isTendbMapping(input.serve, fqdn, port);
  const ok = (detail: string | null) =>
    ({ status: SharingStepStatus.Ok, detail, error: null }) as const;
  const failed = (detail: string | null, error: string) =>
    ({ status: SharingStepStatus.Failed, detail, error }) as const;
  const pending = { status: SharingStepStatus.Todo, detail: null, error: null } as const;

  const connected =
    self === null
      ? selfError === null
        ? pending
        : failed(null, selfError)
      : self.running && fqdn !== null
        ? ok(fqdn)
        : failed(null, 'Open Tailscale and connect');
  const connectedOk = self?.running === true && fqdn !== null;
  const untagged = !connectedOk
    ? pending
    : self.tags.length === 0
      ? ok(null)
      : failed(
          self.tags.join(', '),
          'A tagged Mac gets no identity headers. Untag it in the Tailscale admin console.',
        );
  const https = !connectedOk
    ? pending
    : self.certDomains.includes(fqdn)
      ? ok(fqdn)
      : failed(fqdn, 'Turn on HTTPS in the Tailscale admin console (DNS).');
  const certificate = !connectedOk
    ? pending
    : input.certificateExists
      ? ok(fqdn)
      : ({
          status: SharingStepStatus.Waiting,
          detail: fqdn,
          error: input.certificateRequested ? input.certificateError : null,
        } as const);
  const shared = mapped
    ? ok(fqdn)
    : enabled
      ? failed(null, input.pausedReason ?? 'Not shared yet')
      : pending;

  const steps =
    cli === null
      ? []
      : [
          { step: SharingStep.Installed, ...ok(cli) },
          { step: SharingStep.Connected, ...connected },
          { step: SharingStep.Untagged, ...untagged },
          { step: SharingStep.Https, ...https },
          { step: SharingStep.Certificate, ...certificate },
          { step: SharingStep.Shared, ...shared },
        ];
  const prerequisitesOk =
    cli !== null && steps.slice(0, 5).every((step) => step.status === SharingStepStatus.Ok);
  const allOk = prerequisitesOk && mapped;
  const state = enabled
    ? allOk
      ? SharingState.Ready
      : SharingState.Paused
    : prerequisitesOk
      ? SharingState.Off
      : SharingState.SettingUp;
  return {
    state,
    enabled,
    port,
    fqdn,
    login: self?.login ?? null,
    certificateRequested: input.certificateRequested,
    certificateExists: input.certificateExists,
    url: state === SharingState.Ready && fqdn !== null ? `https://${fqdn}:${String(port)}` : null,
    portHolder: input.portHolder,
    steps,
  };
}
