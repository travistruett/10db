# recovery

Startup recovery (`recover.ts`) runs once, before the scheduler. Its rules for what a restart costs a run are in
`docs/architecture/decisions/2026-11-26-a-freeze-kill-is-not-a-crash-of-every-run.md`:

- A run is charged one recovery attempt only after an unclean restart that was not the app's freeze kill
  (`frozenKill`, read from `daemon.frozen-kill` by `daemon/frozen-kill.ts`), and only if it was past STARTING.
- `recovery.starting_at_unclean_restart` (an app setting) names the runs that were STARTING at the last unclean
  restart. A run found STARTING again at the next one is held with one card (`inbox/start-hold-card.ts`); a clean
  shutdown clears the list. `startTask` closes the card when it queues the held run again.
