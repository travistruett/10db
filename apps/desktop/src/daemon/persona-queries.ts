import { PersonaDto } from '@10db/contracts';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { readJson } from './client';
import { useDaemon } from './provider';

/** Every persona query; a `persona` event refetches them. */
export const PERSONAS_KEY = ['personas'] as const;

const PersonaList = z.array(PersonaDto);

/** The personas a playbook cell or a kind's override can name. */
export function usePersonas() {
  const { client } = useDaemon();
  return useQuery({
    queryKey: PERSONAS_KEY,
    queryFn: async () => readJson(await client.personas.$get(), PersonaList),
  });
}
