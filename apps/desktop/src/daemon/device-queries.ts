import { DeviceDto, PairingCodeDto, type DeviceId } from '@10db/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { readJson } from './client';
import { useDaemon } from './provider';

export const deviceKeys = { all: ['devices'] as const };

const DeviceList = z.array(DeviceDto);

/** The phones and Macs paired to this Mac; `device.changed` refetches it. */
export function useDevices() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: deviceKeys.all,
    queryFn: async () => readJson(await client.devices.$get(), DeviceList),
  });
}

/** Revoke cuts the device off at once and drops it from the list. */
export function useRevokeDevice() {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    meta: { quiet: true },
    mutationFn: async (deviceId: DeviceId) => {
      const res = await client.devices[':deviceId'].$delete({ param: { deviceId } });
      if (!res.ok) await readJson(res, z.never());
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: deviceKeys.all }),
  });
}

/** Forget This Device: the calling device revokes itself; the phone then drops its token. */
export function useForgetThisDevice() {
  const { client } = useDaemon();
  return useMutation({
    meta: { quiet: true },
    mutationFn: async () => {
      const res = await client.devices.me.$delete();
      if (!res.ok) await readJson(res, z.never());
    },
  });
}

/** A new pairing code (it replaces any open one); a 409 means sharing isn't Ready. */
export function usePairingCode() {
  const { client } = useDaemon();
  return useMutation({
    meta: { quiet: true },
    mutationFn: async () => readJson(await client.devices['pairing-code'].$post(), PairingCodeDto),
  });
}
