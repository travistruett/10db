import { DecisionNumberSource, ModelSource } from '@10db/contracts';

type ModelField = 'intelligence' | 'coding' | 'agentic' | 'costPerTask' | 'speed';

/** The words a model row's figure shows as its source; a speed from OpenRouter also says what it was measured on. */
export function modelSourceText(
  source: ModelSource,
  field: ModelField,
  speedProvider: string | null,
): string {
  switch (source) {
    case ModelSource.Aa:
      return 'Artificial Analysis';
    case ModelSource.AaViaOpenRouter:
      return 'Artificial Analysis, via OpenRouter';
    case ModelSource.OpenRouter:
      if (field !== 'speed') return 'OpenRouter';
      return speedProvider === null
        ? 'OpenRouter, median across providers'
        : `OpenRouter, measured on ${speedProvider}`;
  }
}

/** The words a decision model's cost or time shows as its source. */
export function decisionSourceText(source: DecisionNumberSource): string {
  switch (source) {
    case DecisionNumberSource.YourCalls:
      return 'Your calls, last 30 days';
    case DecisionNumberSource.OpenRouterPrice:
      return "OpenRouter's price for your typical decision";
    case DecisionNumberSource.OpenRouter:
      return 'OpenRouter, measured';
    case DecisionNumberSource.Assumed:
      return "OpenRouter's price for a 300-token decision";
  }
}
