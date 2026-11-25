import { AccountKind } from '@10db/contracts';
import { askAnthropic, askAnthropicNouls } from './anthropic';
import { askBedrock, askBedrockNouls, type BedrockClientFactory } from './bedrock';
import type { JudgeCredential } from './credential';
import type { NoulAnswers, NoulsAsked } from './noul-questions';
import {
  askOpenRouter,
  askOpenRouterNouls,
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
  /** Builds Bedrock's runtime client; the SDK's own when absent. */
  readonly bedrockClient?: BedrockClientFactory;
}

/** One call on the API the credential's account speaks. Throws a typed JudgeCallError or OpenRouterError, or what the transport throws. */
export function askModel(q: ModelQuestion): Promise<ModelAnswer> {
  const { credential, api, price, bedrockClient, ...rest } = q;
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
        ...(bedrockClient === undefined ? {} : { client: bedrockClient }),
        region: credential.region,
        awsProfile: credential.awsProfile,
        bearerToken: credential.bearerToken,
      });
  }
}

/** Yes/no questions on the API the credential's account speaks, with the transport fields `askModel` takes. */
export interface ModelNouls
  extends
    NoulsAsked,
    Pick<ModelQuestion, 'credential' | 'api' | 'price' | 'bedrockClient' | 'fetch' | 'signal'> {}

/** One call asking yes/no questions. Throws a typed JudgeCallError or OpenRouterError, or what the transport throws. */
export function askModelNouls(q: ModelNouls): Promise<NoulAnswers> {
  const { credential, api, price, bedrockClient, ...rest } = q;
  switch (credential.kind) {
    case AccountKind.OpenRouter:
      return askOpenRouterNouls({ ...rest, api, key: credential.key });
    case AccountKind.AnthropicApiKey:
      return askAnthropicNouls({
        ...rest,
        ...(price === undefined ? {} : { price }),
        key: credential.key,
      });
    case AccountKind.Bedrock:
      return askBedrockNouls({
        ...rest,
        ...(price === undefined ? {} : { price }),
        ...(bedrockClient === undefined ? {} : { client: bedrockClient }),
        region: credential.region,
        awsProfile: credential.awsProfile,
        bearerToken: credential.bearerToken,
      });
  }
}
