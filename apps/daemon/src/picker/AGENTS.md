# apps/daemon/src/picker

- `picker/` is pure like `routing/`: the spec §5.2.1 rules over rows its caller passes in, planned tasks only. `team/candidates.ts` gathers the rows and adds each candidate's claims and step plan; `GET /projects/:projectId/candidates` serves the result. It models no batch: a batch is the delivery spec's entity.
