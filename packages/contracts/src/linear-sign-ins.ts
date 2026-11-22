import { z } from 'zod';
import { AccountId } from './ids';

/** How an account reaches Linear: a claude.ai connector, a server of the builder's, or not at all. */
export const LinearVia = { Connector: 'connector', Server: 'server', None: 'none' } as const;
export type LinearVia = (typeof LinearVia)[keyof typeof LinearVia];

/** One agent account's way to Linear; `note` is the line to show (how to set it up, or why it isn't known). */
export const LinearSignInRowDto = z.strictObject({
  accountId: AccountId,
  accountLabel: z.string(),
  via: z.enum(LinearVia),
  /** The server's sign-in state when `via` is `server`; null when it is not read. */
  signedIn: z.boolean().nullable(),
  note: z.string().nullable(),
  /** True when the account's connectors were not read (or the read failed): `none` is then a maybe, not a no. */
  unchecked: z.boolean(),
});
export type LinearSignInRowDto = z.infer<typeof LinearSignInRowDto>;

/** `GET /settings/sign-ins/linear`: one row per agent account, from cached reads only. */
export const LinearSignInsDto = z.strictObject({ rows: z.array(LinearSignInRowDto) });
export type LinearSignInsDto = z.infer<typeof LinearSignInsDto>;
