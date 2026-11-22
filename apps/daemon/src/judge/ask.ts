import { AccountKind } from '@10db/contracts';
import { askAnthropic } from './anthropic';
import { askBedrock } from './bedrock';
import type { JudgeCredential } from './credential';
import {
  askOpenRouter,
  type ModelAnswer,
  type ModelApi,
  type OpenRouterQuestion,
} from './openrouter';

export type { ModelAnswer } from './openrouter';

export interface ModelQuestion extends Omit<OpenRouterQuestion, 'key' | 'api'> {
  readonly credential: JudgeCredential;
  /** The endpoint an OpenRouter model answers on; read only for an OpenRouter credential. */
  readonly api: ModelApi;
  /** The listed price of the model, when known, for the cost of an Anthropic or Bedrock call. */
  readonly price?: {
    readonly inputUsdPerMillion: number;
    readonly outputUsdPerMillion: number;
  };
  /** Replaces Bedrock's regional endpoint. */
  readonly bedrockEndpoint?: string;
}

/** One call on the API the credential's account speaks. Throws a typed JudgeCallError or OpenRouterError, or what the transport throws. */
export function askModel(q: ModelQuestion): Promise<ModelAnswer> {
  const { credential, api, price, bedrockEndpoint, ...rest } = q;
  switch (credential.kind) {
    case AccountKind.OpenRouter:
      return askOpenRouter({ ...rest, api, key: credential.key });
    case AccountKind.AnthropicApiKey:
      return askAnthropic({
        ...rest,
        ...(price === undefined ? {} : { price }),
        key: credential.key,
      });
    case AccountKind.Bedrock:
      return askBedrock({
        ...rest,
        ...(price === undefined ? {} : { price }),
        ...(bedrockEndpoint === undefined ? {} : { endpoint: bedrockEndpoint }),
        region: credential.region,
        awsProfile: credential.awsProfile,
        bearerToken: credential.bearerToken,
      });
  }
}
