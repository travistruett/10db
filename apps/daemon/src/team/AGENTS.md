# apps/daemon/src/team

- `team/` seeds the team configuration at start and turns a task into its stored step plan. Read the step a workstream is on with `currentStep` from `@10db/contracts`. Daemon tests get profiles from `test/seed-profiles.ts` (the catalogue fixture, ranked like a real one) and invented measurements from `test/catalogue.ts`; `seedTeam` writes no model profile. `routingInputs` (`team/routing-inputs.ts`) gathers what `chooseModel` reads for a project: its account's profiles, the role settings and the patterns.
