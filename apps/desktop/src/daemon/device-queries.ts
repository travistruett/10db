import { DeviceDto, type DeviceId } from '@10db/contracts';
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
