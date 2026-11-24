# Card 2: reach: the target rules, the ownership rule and the lane proxy

**Size:** Core (sandbox reach). Reviewed in group 1.
**Spec:** "Reach" (Scheme and host, Ownership), and the reach bullets of the brief's "What could go wrong".
**Track:** after card 1.

## Files

- **The pure rules.** `apps/daemon/src/lane-browser/lane-reach.ts` (new). It imports nothing but types.
  - `laneUrlTarget(raw)`:
    - parses with `URL`. The protocol is `http:` or `https:`, with no username or password.
    - The hostname is exactly `localhost`, `127.0.0.1` or `[::1]`. Every other spelling is refused, naming it:
      `0.0.0.0`, `127.0.0.2`, `[::ffff:127.0.0.1]`, `*.localhost`, a decimal or hex address, any name.
    - The port is explicit, else 80 or 443.
    - `file:`, `view-source:`, `chrome:`, `filesystem:`, `javascript:`, `data:` and `blob:` are refused by
      name. A page's own `data:` and `blob:` subresources are the driver's business (card 4), not this function's.
  - `laneProxyTarget(request)`:
    - `CONNECT host:port`: the authority form with an explicit port, read as written (as `proxyAllows` reads it).
    - Or an absolute-form `http://` request. Chromium sends `https` and `ws` through `CONNECT`, so an
      absolute-form `https://` is refused.
    - Refused: origin-form, userinfo, and any host `laneUrlTarget` would refuse.
  - `portVerdict(input)`, in this order:
    1. The daemon's port, and any port in `proxyPorts`, are refused before any reading.
    2. `listeners: 'unread'` is refused "the listeners on P could not be read".
    3. No listener is refused "nothing listens on P".
    4. **The ledger rule.** With `session.loopback` on, and every listener's chain holding a
       `${pid}:${startedAt}` in `members` and no pid in `browserPids`: owned. `connectTo` is `::1` when every
       listener is on `::1`; else `127.0.0.1` (a wildcard `*` or `[::]` listener included).
    5. **The compose rule.** With `compose` a non-empty list whose every entry has a `workingDir` (already a real
       path) equal to or under `copy` or `tempDir`, and under no `registeredCheckouts` entry, and whose every
       `hostIp` is either `127.0.0.1`, or `0.0.0.0` or `::` while no listener on P is bound to `127.0.0.1`: owned
       on `127.0.0.1`. A `::` publication counts only when `0.0.0.0` or `127.0.0.1` is published beside it: alone,
       a builder's server on IPv4 `0.0.0.0:P` would answer `127.0.0.1:P`. Docker publishing on all addresses beside another server bound to `127.0.0.1:P` would hand
       the connection to that server, which is why the listeners are read here too. Any other `hostIp` is
       refused.
    6. Otherwise refused, with the most useful reason first:
       - `compose: 'unanswered'`: "Docker did not answer in 5 s".
       - An entry with no `workingDir`: "P is published by a container not started with Compose; start it with
         `docker compose` from your copy".
       - A compose dir in a registered checkout or elsewhere: "P's stack was started outside this lane's copy".
       - Some listeners are the session's and some not, or a stack on all addresses beside a `127.0.0.1`
         listener: "P is shared with a server that isn't this lane's".
       - A publication on another address: "P is published on <ip>, not loopback".
       - Otherwise "P is not a server this lane started".
  - The constants `PORT_CACHE_MS` and `PORT_CHECKS_PER_MINUTE`.
- **The readers and the cache.** `apps/daemon/src/lane-browser/port-owner.ts` (new).
  - `systemPortReaders(home, env, table)`:
    - **`listeners`** runs `/usr/sbin/lsof -nP -a -iTCP:<port> -sTCP:LISTEN -F pn` through `execFile`, with a 5 s
      deadline and `env: { LC_ALL: 'C' }`, and parses the `p` and `n` lines. The address is the `n` field
      before its last `:`. lsof exits 1 when nothing listens, which is an empty list, not a failure.
    - **`table`** is the lane sandbox's process table (`LaneProcessSetup.table`, given by card 3's wiring).
    - **`compose`** finds docker as `environment/system-check.ts` does: export `findDocker` from
      `environment/index.ts`, unchanged. It runs `docker ps --filter publish=<port> --format
      '{{.Label "com.docker.compose.project.working_dir"}}\t{{.Ports}}'`.
      - Its env is `HOME`, a `PATH` of docker's own directory plus `/usr/bin:/bin`, and the daemon env's
        `dockerEnvNames` with their values.
      - It has a 5 s deadline.
      - It reads every mapping in `.Ports` that publishes exactly that host port (`<ip>:<port>->`,
        `[::]:<port>->`), one entry per mapping with its `hostIp`; the filter alone is not trusted.
      - It resolves each working dir to its real path; one that doesn't resolve counts as no label.
      - With no docker found, `compose` is null.
  - `createPortOwner(deps, session)`:
    - Builds the `PortSession` from the `LaneBrowserSession` and `browserPids`.
    - Reads the listeners. For each, it builds the chain from one process-table reading: the listener, then each
      parent up to pid 1, with start times. A pid missing from the table ends its chain.
    - Asks Docker only when the project's Docker is on (`session.docker`) and the ledger rule did not own the
      port, so a check makes at most one `docker ps`. Otherwise `compose` is null.
    - Keeps each port's verdict for `PORT_CACHE_MS` (owned or refused) on the injected clock.
    - A fresh check past `PORT_CHECKS_PER_MINUTE` in the last minute is refused "this lane checked 20 ports in a
      minute; wait before trying another". That refusal is not cached; cached verdicts still answer.
    - A reader that throws makes the verdict refused, saying which reading failed.
- **The proxy.** `apps/daemon/src/lane-browser/lane-proxy.ts` (new), modelled on `pictures/app-proxy.ts`. Read it
  once; do not edit it, and do not import its private helpers.
  - It listens on `127.0.0.1:0`.
  - **Absolute-form `http://`:** `laneProxyTarget`, then `owner.check(port)`. Owned: forward with
    `http.request` to `connectTo:port`, the path and query, the headers without hop-by-hop ones, `agent: false`.
  - **`CONNECT`:** the same check, then a tunnel `net.connect(port, connectTo)`.
  - A refusal answers 403 (`refuse` as in `app-proxy.ts`) and goes on the refused list as
    `<method> <origin><path>: <why>`, never the query.
  - Kept from `app-proxy.ts`:
    - a plain `upgrade` is refused;
    - a status outside 200-599 is a 502;
    - an answer cut off ends the browser's;
    - `close` destroys tunnels and forwards;
    - no error a page or server sends can throw out of a handler.
  - It never resolves a name: it connects only to `connectTo`.
  - The log names refused targets by origin and path only, never the query or a body.
- **The session's shape.** `apps/daemon/src/lane-browser/session.ts` (new): `LaneBrowserSession`, as below. It is
  only a type here; card 3's runner builds it.
- **Module notes.** `apps/daemon/src/lane-browser/AGENTS.md` (new): the module's job, the reach rule in four lines
  (targets, fixed refusals, the ledger rule, the compose rule with its host addresses), the cache and rate, and
  that the proxy is what holds (Playwright's routing is a first check). Also its known limit: `lsof` run as the
  builder doesn't list another user's sockets (a root listener), so such a listener is invisible to the
  `127.0.0.1` check of the compose rule. Cards 3-5 add their lines. `apps/daemon/src/lane-browser/index.ts`
  exports what the index lists for this card.

## Interfaces it implements

From the index, word for word:

```ts
// apps/daemon/src/lane-browser/lane-reach.ts (card 2), pure
/** A browser's request target, read before any reading: a loopback port, or why not. */
export type LaneTarget =
  | { readonly kind: 'port'; readonly port: number }
  | { readonly kind: 'refused'; readonly why: string };
/** A URL a tool loads or a navigation goes to: http or https, host exactly localhost, 127.0.0.1 or [::1]. */
export function laneUrlTarget(raw: string): LaneTarget;
/** What the proxy is asked: absolute-form `http://` only, or `CONNECT host:port`; userinfo and origin-form refused. */
export function laneProxyTarget(request: { readonly method: string; readonly target: string }): LaneTarget;
export interface PortReadings {
  /** `lsof`'s listeners on the port: each one's address and its process chain, itself first, up to launchd. */
  readonly listeners: readonly {
    readonly address: string;
    readonly chain: readonly { readonly pid: number; readonly startedAt: string }[];
  }[] | 'unread';
  /** Each publication of the port by a running container: its compose working dir (null without the label)
   * and the host address Docker bound (`127.0.0.1`, `0.0.0.0`, `::`, or another); null when Docker is off for
   * the project, 'unanswered' when `docker ps` failed or passed 5 s. */
  readonly compose: readonly { readonly workingDir: string | null; readonly hostIp: string }[] | null | 'unanswered';
}
export interface PortSession {
  /** `${pid}:${startedAt}` of every process the session's ledger holds. */
  readonly members: ReadonlySet<string>;
  /** Every lane browser's pids (`BrowserLedger.pids`): never an owner. Pictures' browser and every proxy run
   * as the daemon or its children, whose chains reach no session's member. */
  readonly browserPids: ReadonlySet<number>;
  /** Real paths. */
  readonly copy: string;
  readonly tempDir: string;
  readonly registeredCheckouts: readonly string[];
  /** The project lets lane commands bind localhost (`sandboxLoopback`). */
  readonly loopback: boolean;
}
export type PortVerdict =
  | { readonly kind: 'owned'; readonly connectTo: '127.0.0.1' | '::1' }
  | { readonly kind: 'refused'; readonly why: string };
/** The ownership rule. The daemon's and every lane proxy's port are refused before any reading. */
export function portVerdict(input: {
  readonly port: number;
  readonly daemonPort: number | null;
  readonly proxyPorts: ReadonlySet<number>;
  readonly session: PortSession;
  readonly readings: PortReadings;
}): PortVerdict;
/** How long a port's verdict is kept, and how many fresh checks a session gets a minute. */
export const PORT_CACHE_MS = 5_000;
export const PORT_CHECKS_PER_MINUTE = 20;

// apps/daemon/src/lane-browser/port-owner.ts (card 2)
export interface PortReaders {
  /** `lsof -nP -a -iTCP:<port> -sTCP:LISTEN`, each listener's pid and address; rejects on failure. */
  listeners(port: number): Promise<readonly { readonly pid: number; readonly address: string }[]>;
  /** The process table, for each listener's chain and start times. */
  readonly table: ProcessTable;
  /** `docker ps` for the port's publications: compose working dir and host address; null when no docker is found. */
  readonly compose: ((port: number) => Promise<readonly { readonly workingDir: string | null; readonly hostIp: string }[]>) | null;
}
export function systemPortReaders(
  home: string, env: Readonly<Record<string, string | undefined>>, table: ProcessTable,
): PortReaders;
export interface PortOwner {
  /** The verdict for a connection now: cached `PORT_CACHE_MS`, read again after, at most
   * `PORT_CHECKS_PER_MINUTE` fresh reads a minute (past it, refused). */
  check(port: number): Promise<PortVerdict>;
}
export function createPortOwner(deps: {
  readonly clock: Clock;
  readonly readers: PortReaders;
  readonly daemonPort: () => number | null;
  readonly proxyPorts: () => ReadonlySet<number>;
  readonly browserPids: () => ReadonlySet<number>;
}, session: LaneBrowserSession): PortOwner;

// apps/daemon/src/lane-browser/lane-proxy.ts (card 2)
export interface LaneProxy {
  readonly port: number;
  /** The refusals since the last call, worded for the answer; empties the list. */
  takeRefused(): string[];
  close(): Promise<void>;
}
export function startLaneProxy(owner: PortOwner, logger: Logger): Promise<LaneProxy>;
```

## Interfaces it calls

From the index, word for word (`LaneBrowserSession` is declared here too):

```ts
// apps/daemon/src/sandbox/docker-access.ts
export function dockerEnvNames(env: Readonly<Record<string, string>>): string[]

// apps/daemon/src/git/install-prefixes.ts (exported from git/index.ts)
export function firstExecutable(candidates: readonly string[]): string | null
export function installCandidates(name: string): string[]

// packages/contracts/src/entities.ts
export function isDaemonAddress(appUrl: AppUrl, daemonPort: number): boolean

// apps/daemon/src/lane-browser/session.ts (card 2 declares it, card 3 fills it from the runner)
/** What a lane session lends its browser; the runner builds it from the session's sandbox. */
export interface LaneBrowserSession {
  readonly sessionId: SessionId;
  readonly projectId: ProjectId;
  readonly taskId: TaskId;
  readonly workstreamId: WorkstreamId;
  /** Real paths: the session's checkout and its own temp dir. */
  readonly copy: string;
  readonly tempDir: string;
  readonly fileAccess: FileAccessContext;
  /** Every project's checkout, real paths: a compose dir inside one owns nothing. */
  readonly registeredCheckouts: readonly string[];
  readonly loopback: boolean;
  readonly docker: boolean;
  /** The session's process ledger as it reads now. */
  members(): readonly ProcessMember[];
}
```

`isDaemonAddress` compares an app URL. Here the daemon's port comes in as a number (`daemonPort`), so compare
ports directly; the reference is only for what "the daemon's port" means.

## State-table rows

| State | Event | Next |
| --- | --- | --- |
| any | `browser_open` of `file:`, `data:`, `javascript:` or a non-loopback host, `0.0.0.0`, `127.0.0.2`, `[::ffff:127.0.0.1]`, `*.localhost` | refused before `goto`, saying why (cards 2, 4) |
| a connection to port P | P is the daemon's, or any lane proxy's | refused before any reading (card 2) |
| a connection to P | loopback on, and every listener on P has a chain that reaches a member of the session's ledger | owned; the proxy connects to the address the listeners reported (`::1` when all are on `::1`, else `127.0.0.1`) (card 2) |
| a connection to P | one listener on P is the session's and another is not (one on `127.0.0.1`, one on `*`) | refused "P is shared with a server that isn't this lane's" (card 2) |
| a connection to P | the listener belongs to another session, the builder, or a browser pid | refused "not this lane's server" (card 2) |
| a connection to P | Docker on; every publication of P is by a container whose compose working dir is in the session's copy or temp dir (not inside a registered checkout), bound to `127.0.0.1` | owned, reached on `127.0.0.1` (card 2) |
| a connection to P | the same, bound to `0.0.0.0` or `::` | owned only when no listener on P is bound to `127.0.0.1`; else refused "P is shared with a server that isn't this lane's" (card 2) |
| a connection to P | a publication bound to any other address | refused (card 2) |
| a connection to P | a stack published only on `::` | refused: IPv4 `127.0.0.1:P` may be another server's (card 2) |
| two tasks batched in one worktree | one's Compose stack | the other owns it too (one copy); accepted, since they are one batch's work (card 2) |
| a connection to P | the compose dir is inside a registered checkout (the builder's stack on 8800), elsewhere, or no label (`docker run -p`) | refused; a plain `docker run` refusal says to start it with Compose from the copy (card 2) |
| a connection to P | `docker ps` fails or passes 5 s, or `lsof` fails | refused, saying which reading failed (card 2) |
| P owned within the last 5 s | another connection | the cached verdict; after 5 s it is read again, so a port the lane's server gave up and another took is refused (card 2) |
| a session past 20 fresh checks this minute | a new port | refused "too many ports"; cached verdicts still answer (card 2) |
| Docker off, loopback off | any port | refused: nothing can own one (card 2) |
| next session of the task (review, QA) | first call | a fresh browser; the stack the implement step left is the new session's only by the rule as read now (its compose dir is the shared copy) (cards 2, 3) |
| Your-folder task | a stack the builder runs from the checkout | refused: the copy is a registered checkout, which owns nothing (card 2) |

## Tests

One pure table, `apps/daemon/src/lane-browser/lane-reach.test.ts`, in `pictures/origin-guard.test.ts`'s style
(core: sandbox reach). Rows:

- **Schemes:** the seven refused ones, `http`, `https`.
- **Host spellings:** the three allowed, and the refused ones above, uppercase `LOCALHOST` included (`URL` lowers it,
  so it passes: say so in the row).
- **`laneProxyTarget` forms:** `CONNECT` with and without a port, `CONNECT` to `example.com:443`, userinfo,
  origin-form, absolute `https://`.
- **Fixed refusals:** the daemon's port, a proxy port.
- **The ledger rule:**
  - a listener whose chain reaches a member;
  - one whose chain reaches only another session's pid;
  - a browser pid in the chain;
  - loopback off;
  - a pid reused with another start time;
  - a member listener beside a non-member one on another address.
- **The compose rule:**
  - a dir in the copy, in the temp dir, in a registered checkout, elsewhere;
  - `hostIp` `127.0.0.1`; `0.0.0.0` with no listener on `127.0.0.1`; `0.0.0.0` beside a `127.0.0.1` listener;
    `::` beside `0.0.0.0`; `::` alone (refused); `192.168.1.5`;
  - no label;
  - `unanswered`;
  - Docker off (`null`).
- **`connectTo`:** `::1` only, `127.0.0.1`, `*`.

The cache and the rate (a port that changed owner after the cache; the twenty-first check) go in the same file
against `createPortOwner` with fake `PortReaders` and a fake clock. The readers are the boundary, so faking them
mocks no 10db code. Prove each red first, by breaking the rule it guards. The value card's `why_new` is "core:
sandbox reach".

## Done when

- The checks in Global Constraints pass.
- The table runs green and each group was seen red.
- `lsof` and `docker ps` run only through `execFile` with an argument list, a deadline and a fixed env.
