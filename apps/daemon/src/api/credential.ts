import { TicketScope, type DeviceId } from '@10db/contracts';
import type { Context, MiddlewareHandler } from 'hono';
import type { TicketOwner } from '../devices';
import { AuthVerdict, Credential, RouteClass, authorize, routeClassOf } from './auth-matrix';
import { Listener, listenerOf } from './listener';
import type { Principal } from './principal';
import type { ApiEnv } from './request-context';

export interface CredentialDeps {
  readonly uiToken: string;
  readonly devUi?: { readonly token: string };
  readonly screens?: { tokenValid(token: string): boolean };
  readonly devices: {
    authenticate(token: string): DeviceId | null;
    isActive(id: DeviceId): boolean;
  };
  readonly tickets: { spend(ticket: string, listener: Listener): TicketOwner | null };
}

const DEVICE_PREFIX = 'tdb_';

/** Equal-length byte comparison that doesn't stop at the first difference. */
function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface Presented {
  readonly credential: Credential;
  readonly principal: Principal;
  readonly ticketOwner: TicketOwner | null;
}

const NONE: Presented = {
  credential: Credential.None,
  principal: { kind: 'none' },
  ticketOwner: null,
};
const UNKNOWN: Presented = {
  credential: Credential.Unknown,
  principal: { kind: 'none' },
  ticketOwner: null,
};

function ofTicket(owner: TicketOwner): Presented {
  const principal: Principal =
    owner.deviceId !== null
      ? { kind: 'device', deviceId: owner.deviceId }
      : owner.scope === TicketScope.Full
        ? { kind: 'this_mac' }
        : { kind: 'dev_ui' };
  return { credential: Credential.Ticket, principal, ticketOwner: owner };
}

/**
 * Reads the credential, runs authorize(), sets c.var.principal (and c.var.ticketOwner on the stream). The dev-UI
 * and render read limits (`mayRead`, `shapeOwnedOrNone`, `conversationHasPlan`) stay in `app.ts` as their own
 * middleware right after this one, unchanged.
 */
export function credentialMiddleware(deps: CredentialDeps): MiddlewareHandler<ApiEnv> {
  const spendTicket = (ticket: string, listener: Listener): Presented => {
    const owner = deps.tickets.spend(ticket, listener);
    if (owner === null) return UNKNOWN;
    // A device ticket is good only while its device is; the share listener has no ticket without one.
    if (
      owner.deviceId === null ? listener === Listener.Share : !deps.devices.isActive(owner.deviceId)
    )
      return UNKNOWN;
    return ofTicket(owner);
  };

  const present = (c: Context<ApiEnv>, listener: Listener, route: RouteClass): Presented => {
    if (route === RouteClass.Stream) {
      const ticket = c.req.query('ticket');
      if (ticket !== undefined && ticket !== '') return spendTicket(ticket, listener);
      // The main listener's stream still takes the UI's or the dev UI's token in the query.
      const token = c.req.query('token');
      if (listener === Listener.Main && token !== undefined && token !== '') {
        if (sameToken(token, deps.uiToken))
          return ofTicket({ scope: TicketScope.Full, deviceId: null, listener });
        if (deps.devUi !== undefined && sameToken(token, deps.devUi.token))
          return ofTicket({ scope: TicketScope.DevUi, deviceId: null, listener });
        return UNKNOWN;
      }
    }
    const bearer = /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '')?.[1];
    if (bearer === undefined) return NONE;
    if (listener === Listener.Share) {
      // Only a device token is looked at here; a UI, dev-UI, render or MCP token is never compared.
      const id = bearer.startsWith(DEVICE_PREFIX) ? deps.devices.authenticate(bearer) : null;
      return id === null
        ? UNKNOWN
        : {
            credential: Credential.Device,
            principal: { kind: 'device', deviceId: id },
            ticketOwner: null,
          };
    }
    if (sameToken(bearer, deps.uiToken))
      return { credential: Credential.Ui, principal: { kind: 'this_mac' }, ticketOwner: null };
    if (deps.devUi !== undefined && sameToken(bearer, deps.devUi.token))
      return { credential: Credential.DevUi, principal: { kind: 'dev_ui' }, ticketOwner: null };
    if (deps.screens?.tokenValid(bearer) === true)
      return { credential: Credential.Render, principal: { kind: 'render' }, ticketOwner: null };
    // A device token is no credential here; the matrix refuses it.
    if (bearer.startsWith(DEVICE_PREFIX))
      return { credential: Credential.Device, principal: { kind: 'none' }, ticketOwner: null };
    return UNKNOWN;
  };

  return async (c, next) => {
    const listener = listenerOf(c.env);
    const route = routeClassOf(c.req.method, c.req.path);
    const presented = present(c, listener, route);
    let verdict = authorize(listener, route, presented.credential);
    // A header sign never swaps the listener: the request is authorised as Main, then refused but for /health.
    const marked = listener === Listener.Main && c.get('remote');
    if (verdict === AuthVerdict.Pass && marked && route !== RouteClass.Health)
      verdict = AuthVerdict.Unauthorized;
    if (verdict === AuthVerdict.NotFound) return c.json({ error: 'not_found' }, 404);
    if (verdict === AuthVerdict.Unauthorized) return c.json({ error: 'unauthorized' }, 401);
    c.set('principal', marked ? NONE.principal : presented.principal);
    c.set('ticketOwner', presented.ticketOwner);
    return next();
  };
}
