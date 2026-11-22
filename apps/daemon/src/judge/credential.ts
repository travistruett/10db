import { AccountKind } from '@10db/contracts';

/** What a decision call is signed with, by the kind of account decisions run on. */
export type JudgeCredential =
  | { readonly kind: typeof AccountKind.OpenRouter; readonly key: string }
  | { readonly kind: typeof AccountKind.AnthropicApiKey; readonly key: string }
  | {
      readonly kind: typeof AccountKind.Bedrock;
      readonly region: string;
      /** Null: sign with `bearerToken`. */
      readonly awsProfile: string | null;
      readonly bearerToken: string | null;
    };

/** Every secret the credential holds, for scrubbing from text that might echo one. */
export function secretsOf(credential: JudgeCredential | null): readonly string[] {
  if (credential === null) return [];
  if (credential.kind === AccountKind.Bedrock)
    return credential.bearerToken === null ? [] : [credential.bearerToken];
  return [credential.key];
}

/** A call that reached a provider and did not yield an answer 10db can use. The message names no secret. */
export class JudgeCallError extends Error {
  override readonly name = 'JudgeCallError';
}
