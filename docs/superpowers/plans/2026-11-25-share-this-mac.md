# Plan: share this Mac on the tailnet (slice 1)

**Size: Core** (security and permissions: a new listener reachable off the Mac, a new credential, the auth
middleware). Spec: `docs/superpowers/specs/2026-11-25-10db-remote-host-design.md` §1–§8 and §10–§12. Mock-ups:
`docs/superpowers/specs/2026-11-25-10db-remote-host-mockups.html`, frames 0–3 (approved 2026-11-25). Task S
(lanes can't read Tailscale) is #869 and is not part of this plan.

## Brief

The spec's brief stands. This milestone builds everything but the phone:

- **Settings › Connections › Remote Access**: says up front that it runs over Tailscale (with the link), shows the
  "needs Tailscale" card until Tailscale is found, then the checklist. It ends in **Share** and **Stop Sharing**.
- **Settings › Connections › Devices**: lists paired devices with Revoke. No Pair button yet; it comes with the
  phone app in slice 2.
- Under them: the share listener on `127.0.0.1:4319` behind `tailscale serve` (never Funnel), Host and Origin
  allowlists on both listeners, one auth matrix, device tokens, pairing codes, stream tickets, and revoke.

**It buys:** the whole server side of the phone, reviewed once as one Core change; slice 2 is then UI.
**Could go wrong:** a cell of the auth matrix is wrong. One table test walks every cell, and one wiring test runs
it through `app.request` on both listeners. The desktop's stream breaks when `?token=` goes away, which the
existing e2e flows catch. **You might disagree with:** device tokens are refused on the main listener; the
desktop moves to tickets in the same milestone. **Needed from you:** screenshots of Remote Access and Devices in
the running app before task 11 merges.

## Global Constraints

- Root `AGENTS.md`, `apps/daemon/AGENTS.md`, `apps/desktop/AGENTS.md`, `packages/db/AGENTS.md`,
  `packages/contracts/AGENTS.md` if present; `.claude/rules/code-style.md` and `.claude/rules/testing.md`.
- **The daemon never binds beyond `127.0.0.1`.** Both listeners pass `hostname: '127.0.0.1'`. Nothing runs
  `tailscale funnel`, and no code path builds a serve command with `--funnel`, `--tcp` or `--tls-terminated-tcp`.
- **The listener a request came on is an env binding set by the listener's own `fetch` wrapper**, never a header
  or a URL. A request with no binding (a test's `app.request` with none) is a main-listener request.
- **A remote request never passes on a UI, dev-UI, render or MCP session token.** It passes only on a device
  token, a device ticket, or one of the open routes in the matrix. **On the share listener only `tdb_` tokens and
  tickets are compared;** any other bearer is `Credential.Unknown` and never reaches `sameToken`.
- **A header sign never swaps the listener.** A main-listener request marked remote by a header is authorised as
  `Main`, then refused 401 everywhere but `/health` (short shape). Device tokens and pairing never work on the
  main listener.
- **A lane's MCP calls keep working.** A bearer that matches none of 10db's credentials is `Credential.Unknown`:
  it passes `/mcp` (whose handler checks the session token, as today) and `/health` (short shape) on the main
  listener.
- **One answer for every bad credential:** an unknown device id, a revoked device, a wrong secret, a spent or
  expired ticket and a wrong pairing code all get the same 401 body, `{ error: 'unauthorized' }`.
- **Secrets never land in a log, an event, an error message or a URL.** Tokens, ticket values and pairing codes
  are compared with `crypto.timingSafeEqual` over equal-length buffers (hash first where lengths differ).
- **10db removes only the serve mapping it made** (`isTendbMapping`), and unshares before the listener closes.
- **Sharing never throws out of `startDaemon`.** A missing CLI, a timeout or an unreadable answer is logged and
  shows as Paused or a failed step.
- **zod at every boundary:** each Tailscale CLI output, every new HTTP body, `app_settings` values on read.
- **One migration** (`devices`, `push_subscriptions`). Task 2's generated file is a branch-only placeholder, so CI
  is green on the branch. Task 12, after the branch's final merge of `main`, restores the folder from main
  (`git checkout --no-overlay origin/main -- packages/db/drizzle`, run by the coordinator) and runs the generator once; nothing in `drizzle/` is edited by
  hand. Before task 2 generates, and again before task 12, run `gh pr list --state open` and check no other open
  pull request adds a file under `packages/db/drizzle/`. Any database that ran the branch's placeholder is
  throwaway: task 11's screenshots and every by-hand run use a fresh `TENDB_DATA_DIR`.
- **The first certificate is the builder's click** (their call, 2026-11-25): 10db never runs `tailscale cert`
  for a name with no certificate until the builder presses **Get Certificate**, because the first issue publishes
  the name for good. Once one exists, 10db re-checks on its own.
- New files are small and do one job. No grab-bags. `apps/daemon/src/api/app.ts` gains only route lines that call
  a service; the middleware lives in its own files.
- Tests: only those named on the cards, each shown red first (break the code it guards, see it fail, restore).
  Each test-adding commit carries a value card.
- **Not in this milestone:** the phone app, `/app/*` content (it answers 404), the Pair dialog, push sending, the
  heartbeat, replay, the host switcher, Stay reachable, Open at login.

## Provider parity

| | Claude plan | Bedrock or API key | ChatGPT/Codex plan | OpenRouter |
| --- | --- | --- | --- | --- |
| Share, Stop, Devices, Revoke | same on all | same | same | same |
| Sessions started from a device (slice 2) | run on the host's account as from This Mac | same | same | same |
| Sign-ins | stay on the host; no sign-in UI on a device in this slice | same | same (port 1455 is the host's) | key in the host's Keychain |

No account kind is read or written by this milestone.

## Interfaces

```ts
// packages/contracts/src/ids.ts — ID_SCHEMAS gains
Device: idSchema(['dev'], 'DeviceId'),
PushSubscription: idSchema(['psh'], 'PushSubscriptionId'),
// and the usual exports: export const DeviceId = ID_SCHEMAS.Device; export type DeviceId = z.infer<typeof DeviceId>; (same for PushSubscriptionId)

// packages/contracts/src/protocol.ts
export const PROTOCOL_VERSION = 16 as const;

// packages/contracts/src/sharing.ts
export const SHARE_PORT_DEFAULT = 4319;
/** Tailscale Funnel's ports; 443 also holds the builder's own serve config. Share refuses them. */
export const FUNNEL_PORTS = [443, 8443, 10000] as const;
export const SharingState = { Off: 'off', SettingUp: 'setting_up', Ready: 'ready', Paused: 'paused' } as const;
export type SharingState = (typeof SharingState)[keyof typeof SharingState];
export const SharingStep = {
  Installed: 'installed', Connected: 'connected', Untagged: 'untagged',
  Https: 'https', Certificate: 'certificate', Shared: 'shared',
} as const;
export type SharingStep = (typeof SharingStep)[keyof typeof SharingStep];
// Named SharingStepStatus because contracts' states.ts already exports a StepStatus (task 1).
export const SharingStepStatus = { Ok: 'ok', Waiting: 'waiting', Failed: 'failed', Todo: 'todo' } as const;
export type SharingStepStatus = (typeof SharingStepStatus)[keyof typeof SharingStepStatus];
export const SharingStepDto = z.object({
  step: z.enum(SharingStep), status: z.enum(SharingStepStatus),
  detail: z.string().nullable(),   // a path, a version, the tailnet name, a certificate's expiry
  error: z.string().nullable(),    // the CLI's stderr or 10db's reason, verbatim, for a failed or waiting step
});
export const SharingStatusDto = z.object({
  state: z.enum(SharingState),
  enabled: z.boolean(),            // sharing.enabled
  port: z.int().min(1024).max(65535),
  fqdn: z.string().nullable(),     // Self.DNSName without its trailing dot; never stored
  login: z.string().nullable(),
  certificateRequested: z.boolean(), // the builder pressed Get Certificate for this name (sharing.certificateFor)
  certificateExists: z.boolean(),  // a probe passed for this name, so it is already in the logs
  url: z.string().nullable(),      // https://<fqdn>:<port> once Ready
  portHolder: z.string().nullable(), // "<command> (pid <n>)" when the share port is taken by another process
  steps: z.array(SharingStepDto),  // in SharingStep order; empty while the CLI isn't found
});
export type SharingStatusDto = z.infer<typeof SharingStatusDto>;
export const PutSharingBody = z.object({
  enabled: z.boolean(),
  port: z.int().min(1024).max(65535).optional(),
});

// packages/contracts/src/devices.ts
export const DevicePlatform = { Android: 'android', Ios: 'ios', Macos: 'macos', Other: 'other' } as const;
export type DevicePlatform = (typeof DevicePlatform)[keyof typeof DevicePlatform];
export const DEVICE_LABEL_MAX = 60;
export const DeviceDto = z.object({
  id: DeviceId, label: z.string().min(1).max(DEVICE_LABEL_MAX), platform: z.enum(DevicePlatform),
  createdAt: z.iso.datetime(), lastUsedAt: z.iso.datetime().nullable(),
});
/** 8 Crockford base32 characters, shown as two groups of four. */
export const PAIRING_CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
export const PairingCodeDto = z.object({
  code: z.string().regex(PAIRING_CODE), expiresAt: z.iso.datetime(),
  url: z.string(), // https://<fqdn>:<port>/app/pair#code=<code>
});
export const PairRequest = z.object({
  code: z.string().max(16),        // normalised: upper-cased, '-' and spaces removed, I/L→1, O→0
  label: z.string().trim().min(1).max(DEVICE_LABEL_MAX), platform: z.enum(DevicePlatform),
});
export const PairResponse = z.object({
  deviceId: DeviceId, token: z.string(),
  host: z.object({ name: z.string(), fqdn: z.string(), port: z.int(), protocolVersion: z.int() }),
});
export const DeviceChange = { Paired: 'paired', Used: 'used', Revoked: 'revoked' } as const;
export const DeviceChangedData = z.object({ change: z.enum(DeviceChange) }); // entityId is the DeviceId

// packages/contracts/src/stream-ticket.ts
/** A render token never gets a ticket: it is refused on the stream, as today. */
export const TicketScope = { Full: 'full', DevUi: 'dev_ui' } as const;
export type TicketScope = (typeof TicketScope)[keyof typeof TicketScope];
export const EventTicketDto = z.object({ ticket: z.string(), expiresAt: z.iso.datetime() });

// packages/contracts/src/health.ts — HealthResponse is unchanged; added:
export const HealthPublicResponse = z.object({ status: z.literal('ok'), protocolVersion: z.int().positive() });

// packages/contracts/src/events.ts — EventType gains
DeviceChanged: 'device.changed',    // entityType 'device', data DeviceChangedData
SharingChanged: 'sharing.changed',  // entityType 'sharing', entityId 'this_mac', data { state: SharingState }

// packages/db/src/schema.ts
devices: id text pk, label text, platform text, token_hash text (hex sha256), created_at, updated_at,
         last_used_at text null, revoked_at text null
push_subscriptions: id text pk, device_id text → devices.id on delete cascade, endpoint text unique,
                    p256dh text, auth text, created_at, updated_at

// packages/db/src/store/devices.ts
export interface DeviceInput { readonly label: string; readonly platform: DevicePlatform; readonly tokenHash: string }
export interface DeviceRow extends DeviceDto { readonly tokenHash: string; readonly revokedAt: string | null }
/** Inserts the device and emits device.changed { change: 'paired' } in the same write. */
export function insertDevice(ctx: WriteContext, id: DeviceId, input: DeviceInput): DeviceDto;
export function getDevice(db: DbReader, id: DeviceId): DeviceRow | undefined;
/** Devices not revoked, oldest first. */
export function listDevices(db: DbReader): DeviceDto[];
/** Sets last_used_at and emits device.changed { change: 'used' }. */
export function touchDevice(ctx: WriteContext, id: DeviceId): void;
/** Sets revoked_at, deletes the device's push subscriptions, emits device.changed { change: 'revoked' }; false if already revoked or unknown. */
export function revokeDevice(ctx: WriteContext, id: DeviceId): boolean;

// apps/daemon/src/api/listener.ts
export const Listener = { Main: 'main', Share: 'share' } as const;
export type Listener = (typeof Listener)[keyof typeof Listener];
export interface ApiBindings { readonly listener?: Listener }
/** The env a listener's fetch wrapper passes; a missing binding is the main listener. */
export function listenerOf(env: ApiBindings | undefined): Listener;

// apps/daemon/src/api/principal.ts
export type Principal =
  | { readonly kind: 'this_mac' }
  | { readonly kind: 'dev_ui' }
  | { readonly kind: 'render' }
  | { readonly kind: 'device'; readonly deviceId: DeviceId }
  | { readonly kind: 'none' };
export function ticketScopeOf(p: Principal): TicketScope | null; // this_mac, device → full; dev_ui → dev_ui; render, none → null

// apps/daemon/src/api/auth-matrix.ts — pure
export const RouteClass = {
  Health: 'health', Mcp: 'mcp', BuilderMcp: 'builder_mcp', ScreensClaim: 'screens_claim',
  Stream: 'stream', Ticket: 'ticket', Pair: 'pair', AppStatic: 'app_static', Api: 'api',
} as const;
export type RouteClass = (typeof RouteClass)[keyof typeof RouteClass];
export const Credential = {
  None: 'none', Ui: 'ui', DevUi: 'dev_ui', Render: 'render', Device: 'device', Ticket: 'ticket',
  /** A bearer that is none of 10db's: an MCP session token, a stale or foreign token. */
  Unknown: 'unknown',
} as const;
export type Credential = (typeof Credential)[keyof typeof Credential];
export const AuthVerdict = { Pass: 'pass', Unauthorized: 'unauthorized', NotFound: 'not_found' } as const;
export type AuthVerdict = (typeof AuthVerdict)[keyof typeof AuthVerdict];
export function routeClassOf(method: string, path: string): RouteClass;
/** The spec §4.3 table. A pass here is followed by the dev-UI and render read limits, as today. */
export function authorize(listener: Listener, route: RouteClass, credential: Credential): AuthVerdict;

// apps/daemon/src/api/request-guards.ts
export interface ListenerAllowlists { readonly hosts: readonly string[]; readonly origins: readonly string[] }
export interface RequestGuardDeps {
  /** Read per request: the share listener's lists change when sharing turns on, off or the name changes. */
  readonly allowlists: (listener: Listener) => ListenerAllowlists | null; // null: the share listener has no lists yet → 503 but /health
  readonly hostLogin: () => string | null;
}
export function hostGuard(deps: RequestGuardDeps): MiddlewareHandler;   // 421 { error: 'misdirected' }
export function originGuard(deps: RequestGuardDeps): MiddlewareHandler; // 403 { error: 'forbidden origin' }
/** Sets c.var.remote; a remote request whose Tailscale-User-Login isn't hostLogin() gets 403. */
export function remoteMark(deps: RequestGuardDeps): MiddlewareHandler;

// apps/daemon/src/api/credential.ts
export interface CredentialDeps {
  readonly uiToken: string;
  readonly devUi?: { readonly token: string };
  readonly screens?: { tokenValid(token: string): boolean };
  readonly devices: { authenticate(token: string): DeviceId | null; isActive(id: DeviceId): boolean };
  readonly tickets: { spend(ticket: string, listener: Listener): TicketOwner | null };
}
/**
 * Reads the credential, runs authorize(), sets c.var.principal (and c.var.ticketOwner on the stream). The dev-UI
 * and render read limits (`mayRead`, `shapeOwnedOrNone`, `conversationHasPlan`) stay in `app.ts` as their own
 * middleware right after this one, unchanged.
 */
export function credentialMiddleware(deps: CredentialDeps): MiddlewareHandler;

// apps/daemon/src/devices/tokens.ts
export function mintDeviceToken(id: DeviceId): { readonly token: string; readonly tokenHash: string }; // tdb_<id>_<base64url 32 bytes>
export function parseDeviceToken(text: string): { readonly deviceId: DeviceId; readonly secret: string } | null;
export function secretMatches(secret: string, tokenHash: string): boolean;

// apps/daemon/src/devices/pairing-codes.ts
export const PairAttempt = { Ok: 'ok', Refused: 'refused', RateLimited: 'rate_limited' } as const;
export type PairAttempt = (typeof PairAttempt)[keyof typeof PairAttempt];
export interface PairingCodes {
  /** A new code; cancels the open one. 5 minutes, single use, 5 wrong tries. */
  open(): { readonly code: string; readonly expiresAt: Date };
  /** Counts the try against the listener-wide limit (10 a minute) before looking at the code. */
  attempt(code: string): PairAttempt;
}
export function createPairingCodes(deps: { readonly clock: Clock; readonly random?: (bytes: number) => Buffer }): PairingCodes;

// apps/daemon/src/devices/tickets.ts
export interface TicketOwner { readonly scope: TicketScope; readonly deviceId: DeviceId | null; readonly listener: Listener }
export interface Tickets {
  issue(owner: TicketOwner): EventTicketDto; // 24 random bytes base64url, 30 s
  /** Spends the ticket; null when unknown, spent, expired or issued on the other listener. */
  spend(ticket: string, listener: Listener): TicketOwner | null;
}
export function createTickets(deps: { readonly clock: Clock }): Tickets;

// apps/daemon/src/devices/sockets.ts
export interface SocketLike { close(code: number, reason: string): void }
export interface SocketRegistry {
  add(owner: TicketOwner, socket: SocketLike): () => void; // returns its removal
  closeDevice(deviceId: DeviceId): void;                   // 4401 'device revoked'
  closeListener(listener: Listener): void;                 // 4410 'sharing stopped'
}
export function createSocketRegistry(): SocketRegistry;

// apps/daemon/src/devices/device-service.ts
export class PairingRefusedError extends Error { override readonly name = 'PairingRefusedError'; readonly rateLimited: boolean; }
export class SharingNotReadyError extends Error { override readonly name = 'SharingNotReadyError'; }
export interface DeviceService {
  list(): DeviceDto[];
  pairingCode(): PairingCodeDto;                // throws SharingNotReadyError
  pair(body: PairRequest): PairResponse;        // throws PairingRefusedError
  revoke(id: DeviceId): boolean;                // closes its sockets after the write
  authenticate(token: string): DeviceId | null; // touches last_used_at at most once a minute per device
  isActive(id: DeviceId): boolean;              // known and not revoked
}
export function createDeviceService(deps: {
  readonly state: StateStore; readonly clock: Clock; readonly codes: PairingCodes;
  readonly sockets: SocketRegistry; readonly sharing: () => SharingStatusDto;
}): DeviceService;

// apps/daemon/src/sharing/tailscale-cli.ts
export interface CliResult { readonly code: number | null; readonly stdout: string; readonly stderr: string; readonly timedOut: boolean }
export type TailscaleRun = (args: readonly string[], timeoutMs: number) => Promise<CliResult>;
export const TAILSCALE_CLI_PATHS = ['/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'] as const;
/** The first path that exists, else null. */
export function findTailscaleCli(exists: (path: string) => boolean): string | null;
export function createTailscaleRun(cli: string): TailscaleRun; // execFile, no shell, 10 s default
export interface TailscaleSelf {
  readonly running: boolean; readonly fqdn: string | null; readonly login: string | null;
  readonly tags: readonly string[]; readonly certDomains: readonly string[]; readonly version: string;
}
export class TailscaleUnreadableError extends Error { override readonly name = 'TailscaleUnreadableError'; }
export function readTailscaleSelf(run: TailscaleRun): Promise<TailscaleSelf>; // throws TailscaleUnreadableError

// apps/daemon/src/sharing/serve-mapping.ts — pure
export const ServeStatus: z.ZodType<ServeStatus>; // the parts of `serve status --json` 10db reads
export type MappingProblem = { kind: 'funnel' } | { kind: 'tcp' } | { kind: 'elsewhere'; target: string };
export function isTendbMapping(serve: ServeStatus, fqdn: string, port: number): boolean;
export function mappingProblem(serve: ServeStatus, fqdn: string, port: number): MappingProblem | null;
export function shareRefusal(port: number): string | null; // FUNNEL_PORTS, the main listener's port, < 1024
export function serveArgs(port: number): readonly string[];   // ['serve', '--bg', `--https=${port}`, `http://127.0.0.1:${port}`]
export function unserveArgs(port: number): readonly string[]; // ['serve', `--https=${port}`, 'off']

// apps/daemon/src/sharing/certificate-probe.ts
export interface CertificateProbe {
  /** The last result, never running the CLI. */
  current(): { readonly issued: boolean; readonly error: string | null; readonly checkedAt: Date | null };
  /** Runs the probe if due: at most once a minute, every 10 minutes after a failure. */
  tick(fqdn: string): Promise<void>;
}
export function createCertificateProbe(deps: { readonly run: TailscaleRun; readonly clock: Clock }): CertificateProbe;

// apps/daemon/src/sharing/share-listener.ts
export interface ShareListener { readonly port: number; close(): Promise<void> }
export type ShareListenResult = { readonly ok: true; readonly listener: ShareListener } | { readonly ok: false; readonly holder: string | null };
export function startShareListener(input: {
  readonly fetch: (req: Request, env: ApiBindings) => Response | Promise<Response>;
  readonly port: number; readonly sockets: SocketRegistry; readonly holderOf: (port: number) => Promise<string | null>;
}): Promise<ShareListenResult>;

// apps/daemon/src/sharing/sharing-service.ts
export interface SharingService {
  /** The cache, at once; also starts a refresh (not awaited) when the last one is over 10 s old. */
  status(): SharingStatusDto;
  set(body: PutSharingBody): Promise<SharingStatusDto>;              // Share, Stop, change port
  /** The builder's Get Certificate: runs the first probe for a name with no certificate. */
  requestCertificate(): Promise<SharingStatusDto>;
  allowlists(): ListenerAllowlists | null;                           // for the share listener
  hostLogin(): string | null;
  start(): Promise<void>;                                            // at daemon start; never throws
  stop(): Promise<void>;                                             // at shutdown: unshare, then close
}
export function createSharingService(deps: {
  readonly state: StateStore; readonly clock: Clock; readonly log: Logger;
  readonly cli: () => string | null; readonly run: (cli: string) => TailscaleRun;
  readonly listen: (port: number) => Promise<ShareListenResult>;
  readonly sockets: SocketRegistry; readonly mainPort: () => number;
}): SharingService;

// HTTP routes (apps/daemon/src/api/app.ts; each one line calling a service)
GET    /sharing                 → SharingStatusDto
PUT    /sharing                 PutSharingBody → SharingStatusDto (409 { error, message } on a refusal)
POST   /sharing/certificate     → SharingStatusDto (the builder's Get Certificate)
GET    /devices                 → DeviceDto[]
POST   /devices/pairing-code    → PairingCodeDto (409 when sharing isn't Ready)
POST   /devices/pair            PairRequest → PairResponse (401, 429)
DELETE /devices/:deviceId       → 204 (404 unknown or already revoked)
POST   /events/ticket           → EventTicketDto
GET    /events/stream?after=&ticket=   (token= removed)
GET    /health                  → HealthResponse with a credential, HealthPublicResponse without
```

## State table (design, not a test list)

| # | Sharing | Listener | Request | Outcome |
| --- | --- | --- | --- | --- |
| 1 | any | main | UI token, loopback Host, webview Origin | as today |
| 2 | any | main | device token | 401 |
| 3 | any | main | `Host: evil.example:<port>` | 421 before auth |
| 4 | any | main | `Origin: https://evil.example` on a GET | 403 |
| 5 | any | main | `X-Forwarded-For` or `Tailscale-Headers-Info` with the UI token | 401 (remote) |
| 6 | Ready | share | device token, tailnet Host, phone Origin | pass |
| 7 | Ready | share | UI, dev-UI, render or MCP token | 401 |
| 8 | Ready | share | none, `/health` | public shape |
| 9 | Ready | share | none, `POST /devices/pair`, wrong code, 5th time | 401; the code is burned |
| 10 | Ready | share | none, 11th pair try in a minute | 429 before the code is read |
| 11 | Ready | share | device token, `/builder/mcp`, `/mcp` or `/screens/claim` | 404 |
| 12 | Ready | share | `Tailscale-User-Login` not the host's | 403 |
| 13 | Ready | share | `GET /app/anything`, no credential | 404 (slice 2 serves it) |
| 14 | Ready | share | ticket from the main listener | 401 |
| 15 | Ready | share | open socket, device revoked | closed 4401; next request 401 |
| 16 | Stopping | share | open socket | closed 4410; mapping removed before close |
| 17 | starting, port held | — | — | listener down, 10db's mapping removed, Paused with the holder named |
| 18 | Ready, Funnel found on the port | — | monitor tick | sharing stops, Paused names Funnel |
| 19 | share listener up, name unknown | share | anything but `/health` | 503 |
| 20 | any | main | stream with `?token=` | 401 (tickets only, once task 7 lands) |
| 21 | any | main | an MCP session token on `/mcp`; a stale bearer on `/health` | pass; `/health` short shape |
| 22 | any | main | `X-Forwarded-For` plus a device token, or `POST /devices/pair` | 401; 404 |
| 23 | Ready | share | a UI token on `/health` | short shape (never compared) |
| 24 | Ready | share | ticket issued, device revoked, ticket spent within 30 s | 401 |
| 25 | Ready | share | ticket spent, device revoked before the socket opens | socket closed 4401 on open |
| 26 | starting, enabled, Funnel, TCP or a foreign mapping on the port | — | — | listener stays down; Paused names it |
| 27 | starting, port held, Tailscale unreadable | — | — | listener down; the monitor keeps trying to remove a loopback-proxy mapping on `:<port>` |
| 28 | Off, HTTPS on, no certificate | — | page open | Certificate step waits on **Get Certificate**; no `tailscale cert` run |
| 29 | Ready, the tailnet name changes | share | open sockets | sockets closed 4410, lists rebuilt, Paused until the new name's certificate passes |
| 30 | Ready, Stop, unserve fails or times out | — | — | logged, listener closed anyway, removal retried at next start |
| 31 | Share in flight, Stop or a port change arrives | — | — | the second waits for the first (one queue) |
| 32 | Paused | share | `POST /devices/pairing-code` | 409 not ready |

## Tracks

- **A, contracts and data:** 1 → 2. Everything else needs 1.
- **B, devices:** 3, 4 (after 1 and 2).
- **C, the request path:** 5 → 6 → 7 (5 after 1; 6 after 2, 3, 4 and 5). Task 6 keeps reading `?token=` on the
  stream until task 7 removes it, so the desktop's stream stays green between them.
- **D, sharing:** 8 → 9 → 10 (after 1; 10 also after 4 and 6).
- **E, desktop and docs:** 11 (after 7 and 10), 12 (last).

**The coordinator's checks, before task 6** (by hand, on this Mac, in a throwaway port; a lane can't reach
Tailscale since #869): with `tailscale serve --bg --https=4399 http://127.0.0.1:4399` and a one-line listener on
4399, `curl` the tailnet URL and record the `Host`, `X-Forwarded-For` and `Tailscale-*` header names and which
host value arrives (no logins), and the shape of `tailscale serve status --json` with and without the mapping (no
values). Then `tailscale serve --https=4399 off`. Write both into this index under "Serve facts" before task 6
starts; tasks 6 and 9 build on them.

Two implementers at most at once (B with C, then D with C); the integration branch is
`feat/share-this-mac`. One code-reviewer round over the whole branch after task 11, focused on the auth matrix and
serve control.

## Serve facts

Recorded by the coordinator on 2026-11-25 against Tailscale 1.104.7 (standalone app) on this Mac, with a throwaway
mapping of 4399 to a header-recording listener, removed afterwards (`serve status` back to `{}`).

- **What the share listener receives** through `serve`: the peer is `127.0.0.1`. `Host` is `<fqdn>:<port>`
  (forwarded as the client sent it), and `Origin` passes through unchanged. Serve adds `X-Forwarded-For`,
  `X-Forwarded-Host`, `X-Forwarded-Proto`, `Tailscale-Headers-Info`, `Tailscale-User-Login`, `Tailscale-User-Name`
  and `Tailscale-User-Profile-Pic` to every request from an untagged peer.
- **Forged headers are replaced:** a request sent with its own `X-Forwarded-For` and `Tailscale-User-Login` arrived
  with serve's values only.
- **`serve status --json` with no mapping** is `{}`.
- **With 10db's mapping** (`serve --bg --https=4399 http://127.0.0.1:4399`):
  `{"TCP":{"4399":{"HTTPS":true}},"Web":{"<fqdn>:4399":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:4399"}}}}}`.
  **An HTTPS mapping has a `TCP` entry of its own**, `{ "HTTPS": true }`. A TCP forward is a `TCP[port]` entry
  with `TCPForward` (or `TerminateTLS`), which this check didn't create. So task 9's "no `TCP` entry" means: the
  port's `TCP` entry is exactly `{ "HTTPS": true }` (no `TCPForward`, no `TerminateTLS`, no other key), and
  `AllowFunnel` has no `<fqdn>:<port>` set to true.
- `tailscale serve` and `serve --https=<port> off` each exit 0 within a second here.

## Tasks

1. Contracts: IDs, sharing, devices, ticket, health, events, protocol 16 (`task-1.md`).
2. DB: `devices` and `push_subscriptions`, the store, the migration (`task-2.md`).
3. Devices: tokens and pairing codes (`task-3.md`).
4. Devices: tickets, the socket registry and the device service (`task-4.md`).
5. The auth matrix, pure (`task-5.md`).
6. The request guards and the credential middleware, wired in `createApp` (`task-6.md`).
7. The stream by ticket, `/health`'s two shapes, the desktop and the dev UI moved to tickets (`task-7.md`).
8. The Tailscale reader and the certificate probe (`task-8.md`).
9. Serve control: the mapping rules and the sharing service (`task-9.md`).
10. The share listener and the routes, wired in `startDaemon` (`task-10.md`).
11. Desktop: Remote Access and Devices, and the e2e (`task-11.md`).
12. Docs, the decision, and the final migration (`task-12.md`).
