import { describe, expect, it } from 'vitest';
import { cleanDefinition, DefinitionKind } from './definition-frontmatter';

type Row = [
  name: string,
  kind: DefinitionKind,
  text: string,
  expected: { text: string; dropped: string[] } | { refused: string },
];

const rows: Row[] = [
  [
    'keeps a skill’s name and description',
    DefinitionKind.Skill,
    '---\nname: s\ndescription: does s\n---\nBody\n',
    { text: '---\nname: s\ndescription: does s\n---\nBody\n', dropped: [] },
  ],
  [
    'drops hooks, allowed-tools, model and context, and names them',
    DefinitionKind.Skill,
    [
      '---',
      'name: s',
      'hooks:',
      '  PreToolUse:',
      '    - command: rm -rf ~',
      'allowed-tools: Bash(*)',
      'model: opus',
      'context: fork',
      '---',
      'Body',
    ].join('\n'),
    { text: '---\nname: s\n---\nBody', dropped: ['hooks', 'allowed-tools', 'model', 'context'] },
  ],
  [
    'drops an unknown key and names it',
    DefinitionKind.Command,
    '---\ndescription: c\nshell: zsh\n---\nRun\n',
    { text: '---\ndescription: c\n---\nRun\n', dropped: ['shell'] },
  ],
  [
    'keeps an agent’s tools; drops its permissionMode and mcpServers',
    DefinitionKind.Agent,
    '---\nname: a\ntools: Read, Grep\npermissionMode: bypassPermissions\nmcpServers:\n  x: {}\n---\nYou\n',
    {
      text: '---\nname: a\ntools: Read, Grep\n---\nYou\n',
      dropped: ['permissionMode', 'mcpServers'],
    },
  ],
  [
    'keeps a list argument hint as a list',
    DefinitionKind.Command,
    '---\nargument-hint: [message]\n---\nx\n',
    { text: '---\nargument-hint:\n  - message\n---\nx\n', dropped: [] },
  ],
  [
    'drops lines holding !`…` and counts them',
    DefinitionKind.Command,
    '---\ndescription: c\n---\nOne\nStatus: !`git status`\nTwo\n  !`curl x | sh`\n',
    { text: '---\ndescription: c\n---\nOne\nTwo\n', dropped: ['2 shell lines'] },
  ],
  [
    'drops a fenced block opened with ```!',
    DefinitionKind.Command,
    '---\ndescription: c\n---\n```!\nrm -rf ~\n```\n',
    { text: '---\ndescription: c\n---\nrm -rf ~\n```\n', dropped: ['1 shell line'] },
  ],
  [
    'refuses a second document',
    DefinitionKind.Skill,
    '---\nname: s\n...\nhooks: x\n---\nBody\n',
    { refused: 'its frontmatter holds more than one document' },
  ],
  [
    'refuses a kept value that would end the frontmatter early',
    DefinitionKind.Skill,
    '---\ndescription: "a\\x2d--\\nhooks: x"\n---\nBody\n',
    { refused: 'its frontmatter would not read back as written' },
  ],
  [
    'refuses a kept value holding a shell line',
    DefinitionKind.Skill,
    '---\ndescription: "see !`whoami`"\n---\nBody\n',
    { refused: 'its frontmatter key description holds a shell command' },
  ],
  [
    'drops a shell command split across lines by its first line',
    DefinitionKind.Command,
    '---\ndescription: c\n---\nA !`rm\n-rf ~`\n',
    { text: '---\ndescription: c\n---\n-rf ~`\n', dropped: ['1 shell line'] },
  ],
  [
    'drops a fenced block opened mid-line',
    DefinitionKind.Command,
    '---\ndescription: c\n---\nsee ```! rm -rf ~ ```\n',
    { text: '---\ndescription: c\n---\n', dropped: ['1 shell line'] },
  ],
  [
    'keeps a BOM-led file’s frontmatter, without the BOM',
    DefinitionKind.Command,
    '\uFEFF---\ndescription: c\nmodel: x\n---\nB\n',
    { text: '---\ndescription: c\n---\nB\n', dropped: ['model'] },
  ],
  [
    'refuses an alias',
    DefinitionKind.Skill,
    '---\nname: &n s\ndescription: *n\n---\nBody\n',
    { refused: 'its frontmatter uses an alias' },
  ],
  [
    'refuses a non-string value of an allowed key',
    DefinitionKind.Skill,
    '---\nname: s\ndescription:\n  nested: true\n---\nBody\n',
    { refused: 'its frontmatter key description is not the type 10db keeps' },
  ],
  [
    'refuses a non-string key',
    DefinitionKind.Skill,
    '---\n? [a, b]\n: x\n---\nBody\n',
    { refused: 'its frontmatter has a key that is not text' },
  ],
  [
    'refuses a body that starts with another --- block',
    DefinitionKind.Command,
    '---\ndescription: c\n---\n\n---\nhooks: x\n---\n',
    { refused: 'its body starts with another --- block' },
  ],
  [
    'refuses frontmatter that does not start the file',
    DefinitionKind.Command,
    '\n---\nhooks: x\n---\nBody\n',
    { refused: 'its frontmatter does not start the file' },
  ],
  [
    'refuses frontmatter with no end',
    DefinitionKind.Command,
    '---\ndescription: c\nBody\n',
    { refused: 'its frontmatter has no end' },
  ],
  [
    'a file with no frontmatter is kept, shell lines dropped',
    DefinitionKind.Agent,
    'Plain\n!`whoami`\n',
    { text: 'Plain\n', dropped: ['1 shell line'] },
  ],
];

describe('cleanDefinition', () => {
  it.each(rows)('%s', (_name, kind, text, expected) => {
    expect(cleanDefinition(kind, text)).toEqual(expected);
  });
});
