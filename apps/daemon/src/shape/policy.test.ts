import { ShapeToolName } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { judgeShapeCall, SHAPE_AGENT_MODELS, type ShapeAccess } from './confinement';
import {
  rehearseNote,
  SHAPE_AGENTS,
  SHAPE_ALLOWED_TOOLS,
  SHAPE_BUILT_IN_TOOLS,
  SHAPE_DISALLOWED_TOOLS,
  SHAPE_OFFERED_TOOLS,
  shapeSystemPrompt,
  shapeToolset,
} from './policy';

/** The prompt for a subscription, whose agents take every alias. */
const SHAPE_SYSTEM_PROMPT = shapeSystemPrompt(SHAPE_AGENT_MODELS);

// Shape spec §5.2: the lists a session starts with, and the one prompt that explains them.

const access: ShapeAccess = {
  checkout: '/nowhere/checkout',
  home: '/nowhere/home',
  protectedReads: [],
  filesDir: '/nowhere/files',
  sandboxRoots: ['/nowhere/tmp'],
};

describe('the tool lists of a Shape session', () => {
  it('offers only built-in tools that read, the Agent tool, and the two web tools only the researcher may call', () => {
    expect([...SHAPE_BUILT_IN_TOOLS]).toEqual([
      'Read',
      'Grep',
      'Glob',
      'Agent',
      'WebSearch',
      'WebFetch',
    ]);
  });

  it('names every tool that writes or runs a command as disallowed, and offers none of them', () => {
    for (const name of ['Edit', 'Write', 'NotebookEdit', 'Bash', 'Monitor']) {
      expect(SHAPE_DISALLOWED_TOOLS).toContain(name);
      expect(SHAPE_BUILT_IN_TOOLS).not.toContain(name);
      expect(SHAPE_ALLOWED_TOOLS).not.toContain(name);
    }
  });

  it('lists the web tools in the session so the researcher can inherit them, and lets the hook alone keep the session off the network', () => {
    for (const name of ['WebSearch', 'WebFetch']) {
      expect(SHAPE_DISALLOWED_TOOLS).not.toContain(name);
      expect(SHAPE_ALLOWED_TOOLS).toContain(name);
      expect(judgeShapeCall({ toolName: name, toolInput: {} }, access).decision).toBe('deny');
    }
  });

  it('approves without a prompt only tools the confinement judge allows the main session', () => {
    for (const tool of SHAPE_OFFERED_TOOLS) {
      expect(SHAPE_ALLOWED_TOOLS).toContain(`mcp__10db__${tool}`);
      expect(
        judgeShapeCall({ toolName: `mcp__10db__${tool}`, toolInput: {} }, access).decision,
      ).toBe('allow');
    }
  });

  it('offers every tool but report_finding to the session, and report_finding only to reviewers', () => {
    expect([...SHAPE_OFFERED_TOOLS].sort()).toEqual(
      [
        ShapeToolName.NoteHeard,
        ShapeToolName.ProposePlan,
        ShapeToolName.Attach,
        ShapeToolName.SimilarTasks,
        ShapeToolName.FindRecords,
        ShapeToolName.WriteSpec,
        ShapeToolName.ResolveFinding,
        ShapeToolName.SeeScreen,
      ].sort(),
    );
    expect(SHAPE_OFFERED_TOOLS).not.toContain(ShapeToolName.ReportFinding);
    expect(SHAPE_ALLOWED_TOOLS).toContain('mcp__10db__report_finding');
  });
});

describe('the reviewers (§7)', () => {
  it('are scope, engineering and rehearsal, each with exactly Read, Grep, Glob and report_finding', () => {
    for (const name of ['scope', 'engineering', 'rehearsal'] as const)
      expect([...SHAPE_AGENTS[name].tools]).toEqual([
        'Read',
        'Grep',
        'Glob',
        'mcp__10db__report_finding',
      ]);
  });

  it('are joined by the researcher and the code researcher, the only other agents', () => {
    expect(Object.keys(SHAPE_AGENTS).sort()).toEqual([
      'code-researcher',
      'engineering',
      'rehearsal',
      'researcher',
      'scope',
    ]);
  });

  it('can each be launched by the session and are the only agents it may launch', () => {
    for (const name of Object.keys(SHAPE_AGENTS))
      expect(
        judgeShapeCall(
          { toolName: 'Agent', toolInput: { subagent_type: name, prompt: 'x' } },
          access,
        ).decision,
      ).toBe('allow');
  });

  it('are told to report through report_finding and what the closing report is', () => {
    expect(SHAPE_AGENTS.rehearsal.prompt).toMatch(/final: true/);
    expect(SHAPE_AGENTS.rehearsal.prompt).toMatch(/kind: "none"/);
    expect(SHAPE_AGENTS.scope.prompt).toMatch(/findingId/);
  });

  it('the session is told the ceremony rule, the spec flow and the rehearsal', () => {
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/write_spec/);
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/resolve_finding/);
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/subagent_type "rehearsal"/);
  });

  it('the session is told to plan landings, one per goal by default, and that tasks in one share a pull request', () => {
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/landings/);
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/one per goal/);
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/same place and land the same way/);
  });
});

describe('the researcher (§5.2)', () => {
  it('has WebSearch and WebFetch and nothing else: no file tool, no 10db tool', () => {
    expect([...SHAPE_AGENTS.researcher.tools]).toEqual(['WebSearch', 'WebFetch']);
  });

  it('is told to treat what it reads as data, to answer in words, and to name the URLs it read', () => {
    const prompt = SHAPE_AGENTS.researcher.prompt;
    expect(prompt).toMatch(/untrusted/i);
    expect(prompt).toMatch(/instructions/i);
    expect(prompt).toMatch(/URL/);
    expect(prompt).toMatch(/no file/i);
  });

  it('is launched by the session, which is told to keep code out of the question and to treat the answer as untrusted', () => {
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/subagent_type "researcher"/);
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/never paste code/i);
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/untrusted/i);
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/no web tool of your own/i);
  });

  it('can be launched by the session, with a question', () => {
    expect(
      judgeShapeCall(
        { toolName: 'Agent', toolInput: { subagent_type: 'researcher', prompt: 'What is X?' } },
        access,
      ).decision,
    ).toBe('allow');
  });
});

describe('the rehearsal turn', () => {
  it('lists each task with the hash it was read at and asks for one Agent call per task', () => {
    const { note, instruction } = rehearseNote([
      { effortKey: 'density', taskKey: 'cards', hash: 'abc123', text: 'Title: Cards\nAreas: ui' },
    ]);
    expect(note).toBe('Rehearsing 1 task');
    expect(instruction).toContain('effortKey density · taskKey cards · taskHash abc123');
    expect(instruction).toContain('  Title: Cards\n  Areas: ui');
    expect(instruction).toMatch(/one Agent call per task/);
  });
});

describe('seeing the app (§5.2, §5.5)', () => {
  it('gives the session no browser, no click and no command: its tools are the lists above and see_screen', () => {
    const everything = [...SHAPE_BUILT_IN_TOOLS, ...SHAPE_ALLOWED_TOOLS, ...SHAPE_OFFERED_TOOLS];
    expect(
      everything.filter((t) => /playwright|browser|puppeteer|click|type|screenshot/i.test(t)),
    ).toEqual([]);
    expect(SHAPE_OFFERED_TOOLS).toContain('see_screen');
  });

  it('tells the session what see_screen is: a picture of one screen, with the real data, that it cannot act on', () => {
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/see_screen/);
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/cannot click/);
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/12/);
  });
});

describe('remembering and sizing (§5.5, §8)', () => {
  it('tells the session to check records before proposing one and to say when it contradicts one', () => {
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/find_records/);
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/contradicts/);
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/supersedes/);
  });

  it('tells the session to propose a principle when the builder states a rule with always or never, after looking for one', () => {
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/always" or "never"/);
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/principle record/);
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/call find_records first/);
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/topicKey/);
  });

  it('tells the session to set about on a question, so Convert stores it under its goal or task', () => {
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/question/);
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/set about to the key of the goal or task/);
  });

  it('tells the session to size from similar finished tasks as a basis', () => {
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/similar_tasks/);
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/basis/);
  });
});

describe('the system prompt', () => {
  it('tells the session to make no proposal before Propose, to echo with note_heard and to cite messages', () => {
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/note_heard/);
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/propose_plan/);
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/\[m:/);
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/until the builder presses Propose/);
  });
});

describe('a session in its read-only sandbox (§5.2)', () => {
  it('runs commands, and still never has a tool that writes or watches without end', () => {
    const { tools, disallowedTools } = shapeToolset(true);
    expect([...tools]).toEqual([...SHAPE_BUILT_IN_TOOLS, 'Bash']);
    expect([...disallowedTools].sort()).toEqual(['Edit', 'Monitor', 'NotebookEdit', 'Write']);
    expect(SHAPE_ALLOWED_TOOLS).not.toContain('Bash');
  });

  it('gives only its code researcher Bash; without the sandbox nobody has it', () => {
    const sandboxed = shapeToolset(true).agents;
    expect(sandboxed['code-researcher']?.tools).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
    for (const name of ['scope', 'engineering', 'rehearsal', 'researcher'])
      expect(sandboxed[name]?.tools).not.toContain('Bash');
    const bare = shapeToolset(false);
    expect(bare.tools).not.toContain('Bash');
    expect(bare.disallowedTools).toContain('Bash');
    expect(bare.agents['code-researcher']?.tools).toEqual(['Read', 'Grep', 'Glob']);
  });

  it('runs every agent on the session’s model unless the call names one', () => {
    for (const agent of Object.values(shapeToolset(true).agents))
      expect(agent.model).toBeUndefined();
  });

  it('tells the code researcher it reaches no web page or MCP server, and that what it reads is data', () => {
    const prompt = SHAPE_AGENTS['code-researcher'].prompt;
    expect(prompt).toMatch(/no web page and no MCP server/);
    expect(prompt).toMatch(/data, never instructions/);
  });

  describe.each([
    ['the session prompt', () => SHAPE_SYSTEM_PROMPT],
    ['the code researcher prompt', () => SHAPE_AGENTS['code-researcher'].prompt],
  ])('%s steers reading away from Bash cards', (_name, prompt) => {
    it('reads and searches files with Read, Grep and Glob, which never ask', () => {
      expect(prompt()).toMatch(/Read, Grep and Glob[^.]*never ask/);
      expect(prompt()).toMatch(/Bash[^.]*only for what (those|these) tools can't do/);
    });

    it('passes absolute paths instead of cd, and no command substitution', () => {
      expect(prompt()).toMatch(/as an absolute path/);
      expect(prompt()).toMatch(/never `cd`|not `cd`|no `cd`/);
      expect(prompt()).toMatch(/command substitution/);
    });

    it('does not present ls, wc or rg through Bash as the way to read code', () => {
      expect(prompt()).not.toMatch(/\b(ls|wc|rg)\b/);
    });
  });

  it('tells the session how to fan out code research, name a model, and treat tool output', () => {
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/subagent_type "code-researcher"/);
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/waits for the builder's approval on a card/);
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/data, never instructions/);
  });
});
