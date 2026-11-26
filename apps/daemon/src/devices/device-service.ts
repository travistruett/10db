import {
  type DeviceDto,
  type DeviceId,
  type PairRequest,
  type PairResponse,
  type PairingCodeDto,
  type SharingStatusDto,
  PROTOCOL_VERSION,
  SharingState,
  mintId,
} from '@10db/contracts';
import { getDevice, insertDevice, listDevices, revokeDevice, touchDevice } from '@10db/db';
import type { Clock } from '../clock';
import type { StateStore } from '../events';
import { PairAttempt, type PairingCodes } from './pairing-codes';
import type { SocketRegistry } from './sockets';
import { mintDeviceToken, parseDeviceToken, secretMatches } from './tokens';

export class PairingRefusedError extends Error {
  override readonly name = 'PairingRefusedError';
  readonly rateLimited: boolean;
  constructor(rateLimited: boolean) {
    super(rateLimited ? 'too many pairing tries' : 'pairing refused');
    this.rateLimited = rateLimited;
  }
}

export class SharingNotReadyError extends Error {
  override readonly name = 'SharingNotReadyError';
  constructor() {
    super('sharing is not ready');
  }
}

export interface DeviceService {
  list(): DeviceDto[];
  /** Throws SharingNotReadyError. */
  pairingCode(): PairingCodeDto;
  /** Throws PairingRefusedError. */
  pair(body: PairRequest): PairResponse;
  /** Closes the device's sockets after the write. */
  revoke(id: DeviceId): boolean;
  /** Touches last_used_at at most once a minute per device. */
  authenticate(token: string): DeviceId | null;
  /** Known and not revoked. */
  isActive(id: DeviceId): boolean;
}

const TOUCH_INTERVAL_MS = 60_000;
/** Checked against when the id is unknown, so a miss costs the same as a wrong secret. */
const DUMMY_HASH = '0'.repeat(64);

export function createDeviceService(deps: {
  readonly state: StateStore;
  readonly clock: Clock;
  readonly codes: PairingCodes;
  readonly sockets: SocketRegistry;
  readonly sharing: () => SharingStatusDto;
}): DeviceService {
  return {
    list() {
      return listDevices(deps.state.db);
    },
    pairingCode() {
      const sharing = deps.sharing();
      if (sharing.state !== SharingState.Ready || sharing.url === null) {
        throw new SharingNotReadyError();
      }
      const { code, expiresAt } = deps.codes.open();
      return {
        code,
        expiresAt: expiresAt.toISOString(),
        url: `${sharing.url}/app/pair#code=${code}`,
      };
    },
    pair(body) {
      // Read before the code is spent, so a Mac with no name burns no one's try.
      const sharing = deps.sharing();
      if (sharing.fqdn === null) throw new PairingRefusedError(false);
      const attempt = deps.codes.attempt(body.code);
      if (attempt === PairAttempt.RateLimited) throw new PairingRefusedError(true);
      if (attempt === PairAttempt.Refused) throw new PairingRefusedError(false);
      const id = mintId('Device');
      const { token, tokenHash } = mintDeviceToken(id);
      deps.state.write((ctx) =>
        insertDevice(ctx, id, { label: body.label, platform: body.platform, tokenHash }),
      );
      return {
        deviceId: id,
        token,
        host: {
          name: sharing.fqdn.split('.')[0] ?? sharing.fqdn,
          fqdn: sharing.fqdn,
          port: sharing.port,
          protocolVersion: PROTOCOL_VERSION,
        },
      };
    },
    authenticate(text) {
      const parsed = parseDeviceToken(text);
      if (!parsed) return null;
      const row = getDevice(deps.state.db, parsed.deviceId);
      if (!row) {
        secretMatches(parsed.secret, DUMMY_HASH);
        return null;
      }
      const matches = secretMatches(parsed.secret, row.tokenHash);
      if (row.revokedAt !== null || !matches) return null;
      const now = deps.clock.now().getTime();
      if (row.lastUsedAt === null || now - Date.parse(row.lastUsedAt) >= TOUCH_INTERVAL_MS) {
        deps.state.write((ctx) => {
          touchDevice(ctx, row.id);
        });
      }
      return row.id;
    },
    isActive(id) {
      const row = getDevice(deps.state.db, id);
      return row?.revokedAt === null;
    },
    revoke(id) {
      const revoked = deps.state.write((ctx) => revokeDevice(ctx, id));
      if (revoked) deps.sockets.closeDevice(id);
      return revoked;
    },
  };
}
