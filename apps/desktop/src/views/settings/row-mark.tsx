import type { AccountDto } from '@10db/contracts';
import {
  IconBrandAws,
  IconBrandGithub,
  IconBrandOpenai,
  IconBrandSlack,
  IconDatabase,
  IconGauge,
  IconKey,
  IconRefresh,
  IconTerminal2,
  IconUserCircle,
  type Icon,
} from '@tabler/icons-react';
import type { RowMark } from './overview-rows';

const MARK_ICON: Readonly<Record<RowMark, Icon>> = {
  key: IconKey,
  claude: IconUserCircle,
  openai: IconBrandOpenai,
  aws: IconBrandAws,
  github: IconBrandGithub,
  slack: IconBrandSlack,
  gauge: IconGauge,
  database: IconDatabase,
  terminal: IconTerminal2,
  refresh: IconRefresh,
};

/** The provider mark of each account kind: a Claude plan, a ChatGPT plan, Bedrock, or a key. */
export const MARK_OF_KIND: Readonly<Record<AccountDto['kind'], RowMark>> = {
  claude_subscription: 'claude',
  anthropic_api_key: 'key',
  gateway: 'key',
  bedrock: 'aws',
  codex_signin: 'openai',
  openrouter: 'key',
};

const MARK_SIZE = 16;

/** The glyph of a service or provider mark; decorative, the name beside it says what it is. */
export function RowMarkIcon({ mark }: { readonly mark: RowMark }) {
  const Glyph = MARK_ICON[mark];
  return <Glyph size={MARK_SIZE} stroke={1.5} aria-hidden style={{ flex: 'none' }} />;
}
