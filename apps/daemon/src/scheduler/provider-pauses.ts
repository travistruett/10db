import { EventType, Provider, WorkstreamState, type ProjectId } from '@10db/contracts';
import {
  deleteAppSetting,
  getAppSetting,
  getProject,
  listWorkstreams,
  setAppSetting,
  transitionWorkstream,
} from '@10db/db';
import { z } from 'zod';
import type { Clock, Timer } from '../clock';
import type { StateStore } from '../events';
import type { InboxService } from '../inbox';

export interface ProviderPauses {
  pause(provider: Provider, until: Date | null, projectId: ProjectId): void;
  isPaused(provider: Provider): boolean;
  /** Re-arms pauses persisted before a restart. */
  restore(): void;
  stop(): void;
}

const PauseSetting = z.object({ until: z.iso.datetime() });
const key = (provider: Provider) => `provider_pause.${provider}`;

/** A usage limit pauses every lane on that provider until the reset time (spec §5.4). */
export function createProviderPauses(opts: {
  readonly state: StateStore;
  readonly clock: Clock;
  readonly inbox: InboxService;
  stopProvider(provider: Provider): Promise<void>;
  onResume(): void;
  readonly defaultPauseMs: number;
}): ProviderPauses {
  const until = new Map<Provider, Date>();
  const timers = new Map<Provider, Timer>();

  function resume(provider: Provider): void {
    until.delete(provider);
    timers.delete(provider);
    opts.state.write((ctx) => {
      deleteAppSetting(ctx, key(provider));
      for (const ws of listWorkstreams(ctx.tx, { states: [WorkstreamState.PausedLimit] })) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the provider set has one member today; the filter is needed once it has two.
        if (getProject(ctx.tx, ws.projectId).provider !== provider) continue;
        transitionWorkstream(ctx, ws.id, {
          to: WorkstreamState.Queued,
          fence: null,
          patch: { pausedUntil: null },
          reason: 'usage limit reset',
        });
      }
      ctx.emit({ type: EventType.ProviderResumed, entityType: 'provider', entityId: provider });
    });
    opts.onResume();
  }

  function arm(provider: Provider, at: Date): void {
    timers.get(provider)?.cancel();
    until.set(provider, at);
    timers.set(
      provider,
      opts.clock.setTimeout(
        () => {
          resume(provider);
        },
        Math.max(0, at.getTime() - opts.clock.now().getTime()),
      ),
    );
  }

  return {
    pause(provider, reportedUntil, projectId) {
      const now = opts.clock.now();
      const at =
        reportedUntil && reportedUntil > now
          ? reportedUntil
          : new Date(now.getTime() + opts.defaultPauseMs);
      const current = until.get(provider);
      if (!current || at > current) {
        arm(provider, at);
        opts.state.write((ctx) => {
          setAppSetting(ctx, key(provider), { until: at.toISOString() });
          ctx.emit({
            type: EventType.ProviderPaused,
            entityType: 'provider',
            entityId: provider,
            data: { until: at.toISOString() },
          });
        });
        opts.inbox.flag({
          projectId,
          workstreamId: null,
          title: `${provider} usage limit reached`,
          body: `Every lane on ${provider} is paused until ${at.toISOString()}. Work resumes automatically.`,
          foldKey: `provider-pause:${provider}`,
        });
      }
      void opts.stopProvider(provider);
    },
    isPaused: (provider) => until.has(provider),
    restore() {
      for (const provider of Object.values(Provider)) {
        const parsed = PauseSetting.safeParse(getAppSetting(opts.state.db, key(provider)));
        if (!parsed.success) continue;
        const at = new Date(parsed.data.until);
        if (at > opts.clock.now()) arm(provider, at);
        else resume(provider);
      }
    },
    stop() {
      for (const timer of timers.values()) timer.cancel();
      timers.clear();
    },
  };
}
