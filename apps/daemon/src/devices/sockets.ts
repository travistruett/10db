import type { DeviceId } from '@10db/contracts';
import type { Listener } from '../listeners';
import type { TicketOwner } from './tickets';

export interface SocketLike {
  close(code: number, reason: string): void;
}

export interface SocketRegistry {
  /** Returns the socket's removal. */
  add(owner: TicketOwner, socket: SocketLike): () => void;
  /** Closes every socket the device holds: 4401 'device revoked'. */
  closeDevice(deviceId: DeviceId): void;
  /** Closes every socket issued on the listener: 4410 'sharing stopped'. */
  closeListener(listener: Listener): void;
}

export function createSocketRegistry(): SocketRegistry {
  const sockets = new Map<SocketLike, TicketOwner>();

  function closeWhere(match: (owner: TicketOwner) => boolean, code: number, reason: string): void {
    for (const [socket, owner] of [...sockets]) {
      if (!match(owner)) continue;
      sockets.delete(socket);
      socket.close(code, reason);
    }
  }

  return {
    add(owner, socket) {
      sockets.set(socket, owner);
      return () => {
        sockets.delete(socket);
      };
    },
    closeDevice(deviceId) {
      closeWhere((owner) => owner.deviceId === deviceId, 4401, 'device revoked');
    },
    closeListener(listener) {
      closeWhere((owner) => owner.listener === listener, 4410, 'sharing stopped');
    },
  };
}
