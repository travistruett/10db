import { createHash } from 'node:crypto';
import { SHARE_PORT_DEFAULT } from '@10db/contracts';
import { deleteAppSetting, getAppSetting, setAppSetting } from '@10db/db';
import { z } from 'zod';
import type { StateStore } from '../events';

const KEY_ENABLED = 'sharing.enabled';
const KEY_PORT = 'sharing.port';
const KEY_CERTIFICATE_FOR = 'sharing.certificateFor';
/** The port whose mapping a failed unserve left behind; start and the monitor retry it. */
const KEY_UNSERVE_OWED = 'sharing.unserveOwed';

const EnabledSetting = z.boolean();
const PortSetting = z.int().min(1024).max(65535);
const HashSetting = z.string();
const OwedSetting = z.array(PortSetting);

/** The hash `sharing.certificateFor` stores in place of the name, so the name is never written. */
export function hashOf(fqdn: string): string {
  return createHash('sha256').update(fqdn).digest('hex');
}

/** What sharing keeps in `app_settings`; an unreadable value reads as its default. */
export interface SharingSettings {
  enabled(): boolean;
  setEnabled(enabled: boolean): void;
  port(): number;
  /** Turns sharing on at `port`: both keys in one write. */
  enable(port: number): void;
  unserveOwed(): number[];
  writeUnserveOwed(ports: readonly number[]): void;
  /** True when the builder pressed Get Certificate for `fqdn`. */
  certificateRequestedFor(fqdn: string): boolean;
  requestCertificateFor(fqdn: string): void;
}

export function createSharingSettings(state: StateStore): SharingSettings {
  return {
    enabled() {
      const parsed = EnabledSetting.safeParse(getAppSetting(state.db, KEY_ENABLED));
      return parsed.success && parsed.data;
    },
    setEnabled(enabled) {
      state.write((ctx) => {
        setAppSetting(ctx, KEY_ENABLED, enabled);
      });
    },
    port() {
      const parsed = PortSetting.safeParse(getAppSetting(state.db, KEY_PORT));
      return parsed.success ? parsed.data : SHARE_PORT_DEFAULT;
    },
    enable(port) {
      state.write((ctx) => {
        setAppSetting(ctx, KEY_ENABLED, true);
        setAppSetting(ctx, KEY_PORT, port);
      });
    },
    unserveOwed() {
      const parsed = OwedSetting.safeParse(getAppSetting(state.db, KEY_UNSERVE_OWED));
      return parsed.success ? parsed.data : [];
    },
    writeUnserveOwed(ports) {
      state.write((ctx) => {
        if (ports.length === 0) deleteAppSetting(ctx, KEY_UNSERVE_OWED);
        else setAppSetting(ctx, KEY_UNSERVE_OWED, [...ports]);
      });
    },
    certificateRequestedFor(fqdn) {
      const parsed = HashSetting.safeParse(getAppSetting(state.db, KEY_CERTIFICATE_FOR));
      return parsed.success && parsed.data === hashOf(fqdn);
    },
    requestCertificateFor(fqdn) {
      state.write((ctx) => {
        setAppSetting(ctx, KEY_CERTIFICATE_FOR, hashOf(fqdn));
      });
    },
  };
}
