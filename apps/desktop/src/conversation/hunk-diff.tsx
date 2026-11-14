import type { ToolCallHunk } from '@10db/contracts';
import { Diff } from '@mantine/code-highlight';
import { Box, Text, VisuallyHidden } from '@mantine/core';
import { hunkGutter, type GutterLine } from './hunk-gutter';
import classes from './hunk-diff.module.css';

const MARKER = { context: '', added: '+', removed: '−' } as const satisfies Record<
  GutterLine['kind'],
  string
>;

/** What a screen reader hears for one line: Diff takes no label per line. */
function lineLabel(line: GutterLine): string {
  const at = `line ${String(line.number)}: ${line.text}`;
  return line.kind === 'context' ? at : `${line.kind} ${at}`;
}

/** The text of the lines on one side, each ending in a newline. */
function sideText(lines: readonly GutterLine[]): string {
  return lines.map((l) => `${l.text}\n`).join('');
}

/**
 * `hunk` cut to its first `maxLines` drawn lines, rebuilt from them so Diff and the gutter both
 * draw exactly those lines.
 */
function cutHunk(hunk: ToolCallHunk, maxLines: number): ToolCallHunk {
  const kept = hunkGutter(hunk).slice(0, maxLines);
  const before = kept.filter((l) => l.kind !== 'added');
  const after = kept.filter((l) => l.kind !== 'removed');
  return {
    ...hunk,
    oldLines: before.length,
    newLines: after.length,
    before: sideText(before),
    after: sideText(after),
  };
}

export interface HunkDiffProps {
  readonly hunk: ToolCallHunk;
  /** The first hunk of an edit carries no header; the rest show their ranges. */
  readonly first: boolean;
  /** Draws at most this many lines. */
  readonly maxLines?: number;
}

/**
 * One hunk of an edit: Mantine's Diff without its own numbers, which count from 1, beside a gutter
 * numbered from the hunk's starts (`hunkGutter`). The drawing is hidden from screen readers, which
 * read a list of the lines instead.
 */
export function HunkDiff({ hunk, first, maxLines }: HunkDiffProps) {
  const shown = maxLines === undefined ? hunk : cutHunk(hunk, maxLines);
  const lines = hunkGutter(shown);
  return (
    <Box className={classes['hunk']}>
      {!first && (
        <Text size="xs" c="dimmed" ff="monospace" className={classes['header']}>
          {`@@ −${String(hunk.oldStart)},${String(hunk.oldLines)} +${String(hunk.newStart)},${String(hunk.newLines)} @@`}
        </Text>
      )}
      <VisuallyHidden>
        <ul aria-label="Changed lines">
          {lines.map((line, i) => (
            <li key={i}>{lineLabel(line)}</li>
          ))}
        </ul>
      </VisuallyHidden>
      <div className={classes['body']} aria-hidden="true">
        <div className={classes['gutter']}>
          {lines.map((line, i) => (
            <div
              key={i}
              className={classes['gutterLine']}
              data-gutter-line
              data-kind={line.kind}
              data-number={line.number}
            >
              <span>{line.number}</span>
              <span className={classes['marker']}>{MARKER[line.kind]}</span>
            </div>
          ))}
        </div>
        <Diff
          previousValue={shown.before}
          currentValue={shown.after}
          withLineNumbers={false}
          diffMethod="lines"
          contextLines={Infinity}
          mode="unified"
          classNames={{
            root: classes['diff'],
            content: classes['content'],
            addedLine: classes['added'],
            removedLine: classes['removed'],
          }}
        />
      </div>
    </Box>
  );
}
