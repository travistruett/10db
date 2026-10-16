# Spike 05: Questions and permission prompts reach `canUseTool` with structured options

- **Status:** VERIFIED
- **Date:** 2026-10-15
- **Versions:** claude 2.1.300 (Claude Code) · Agent SDK 0.3.299 · Node v25.2.1
- **Command:** `pnpm --dir spikes/agent-sdk spike:05`

## Question

Claude's built-in question tool and permission prompts reach `canUseTool` with structured options.

## Result

`AskUserQuestion`, `Write` and `Bash` all reached `canUseTool` in `permissionMode: 'default'`, in that order. The
question arrived as `input.questions[]`, shaped `{ question, header, options: [{ label, description }],
multiSelect }`. The probe picked `alpha` at random, answered with `updatedInput: { ...input, answers: {
[question]: 'alpha.txt' } }`, and the agent created `alpha.txt` (content `chosen`) and not `beta.txt`. The denied
`touch gamma.txt` left no file, and the agent finished with a `success` result. `Write` was not auto-approved
inside the repo: it asked.

`suggestions`:

- Write: `[{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]`.
- Bash: `[{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch gamma.txt' }], behavior: 'allow',
destination: 'localSettings' }, { type: 'addDirectories', directories: [<repo>], destination: 'session' },
{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]`.
- Bash also carried `blockedPath` (the file it would create).

Answer formats: a multi-select answer of `"Apple, Banana"` (labels joined with `, `), a free-text answer
(`TEAL-FREETEXT`) not among the labels, and `annotations[question].notes` all reached the model, which echoed
each one.

## Evidence

```
INFO answer chosen by the probe: alpha
INFO canUseTool calls: [{"tool":"AskUserQuestion","keys":["questions"]},{"tool":"Write","keys":["file_path","content"]},{"tool":"Bash","keys":["command","description"],"blockedPath":"/private/var/folders/…/tendb-spike-OmRInq/gamma.txt"}]
INFO Write suggestions: [{"type":"setMode","mode":"acceptEdits","destination":"session"}]
INFO Bash suggestions: [{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"touch gamma.txt"}],"behavior":"allow","destination":"localSettings"},{"type":"addDirectories","directories":["/private/var/folders/…/tendb-spike-OmRInq"],"destination":"session"},{"type":"setMode","mode":"acceptEdits","destination":"session"}]
INFO question as received: {"question":"Which file should I create?","header":"File name","options":[{"label":"alpha.txt","description":"Create alpha.txt containing the word chosen"},{"label":"beta.txt","description":"Create beta.txt containing the word chosen"}],"multiSelect":false}
PASS AskUserQuestion reached canUseTool: AskUserQuestion,Write,Bash
PASS question is structured with ≥2 options: ["alpha.txt","beta.txt"]
PASS answer delivered: alpha.txt created, beta.txt absent: alpha.txt exists
PASS Write permission reached canUseTool: Write seen
PASS Bash permission reached canUseTool: Bash seen
PASS deny honored: gamma.txt absent: the denied command left no file
PASS agent continued after the deny: success: Step 3 was denied, so I did not retry it
INFO answer formats: {"formats":[{"received":[{"question":"Which fruits?","multiSelect":true,"labels":["Apple","Banana","Cherry"]},{"question":"Which color?","multiSelect":false,"labels":["Red","Blue"]}]}],"reply":"Apple, Banana\nTEAL-FREETEXT\nNOTE-CANARY-OCELOT"}
PASS multi-select: ", "-joined labels reach the model: Apple, Banana
PASS free-text "Other" answer reaches the model: TEAL-FREETEXT echoed
PASS annotations.notes reach the model: note echoed
RESULT 05-questions: no failures
```

## Consequence for M1

- M1a inbox `question` card maps 1:1 from `AskUserQuestionInput.questions[]`. The answer is
  `updatedInput.answers[question] = label`, with multi-select labels joined by `, ` (confirmed). A free-text
  answer is passed as the string itself.
- A note travels as `annotations[question].notes` (confirmed to reach the model). Appending it to the answer
  string, as M1a does today, also works and needs no change.
- M1a `permission` cards carry `suggestions`, and "always for this project" persists them as an allow rule plus a
  decision. The SDK's own `addRules` suggestion targets `destination: 'localSettings'`, which 10db never loads
  (`settingSources: ['project']`), so 10db stores the rule itself and never passes that suggestion back as
  `updatedPermissions` unchanged. `blockedPath` is worth showing on the card.
