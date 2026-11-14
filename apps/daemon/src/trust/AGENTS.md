# apps/daemon/src/trust

- `trust/` builds each session's `TrustPolicy` (`@10db/contracts`): the four limits, whose prose lives in one
  place (`trust/limits.ts`), the environment the judge reads them in, and the coordination lines of its surface.
- 10db's judge: `fast-path.ts` (`fastPathAllows`, `namesSecret`) answers the calls that can't cross a limit
  with no model, a shell command only when every segment is in `read-allowlist.ts` (each read command with the
  only options it may carry, and its files regular, non-secret and inside the checkout or the temp dir); `crosses-limit.ts` asks the `crosses_limit` decision the rest, with the call fenced as data, and
  reads `unsure`, a below-floor `allow` and an input over `CALL_INPUT_MAX_CHARS` as a limit; `grants.ts` turns a
  project's grants (`trust_grants`) into the allow lines every judge reads (`grantTargetOf` keeps a note on one line
  or quotes the call). `call-judge.ts` starts a `tendb` session on the rules when 10db's judge isn't ready.
- The hook judge that runs them is `inbox/hook-judge.ts` (`createHookJudge`, `LimitNotes`); the card a noted limit
  raises is `inbox/limit-card.ts`, with the three answers, and Always in this project stores a grant in the
  answer's write (`inbox/service.ts`).
