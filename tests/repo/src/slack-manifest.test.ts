import { describe, expect, it } from 'vitest';
import { readRepoFile } from './workspace';

describe('the Slack app manifest', () => {
  it('Settings › Integrations copies the manifest docs/slack-app.md gives, to the character', () => {
    const doc = /```yaml\n(_metadata:[\s\S]*?)```/.exec(readRepoFile('docs/slack-app.md'))?.[1];
    const source = readRepoFile('apps/desktop/src/views/settings/integrations/slack-manifest.ts');
    const manifest = /SLACK_MANIFEST = `([\s\S]*?)`;/.exec(source)?.[1];
    expect(doc).toBeDefined();
    expect(manifest).toBe(doc);
  });
});
