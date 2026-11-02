import { describe, expect, it } from 'vitest';
import { bashWrites } from './bash-writes';

describe('bashWrites', () => {
  it.each([
    'python3 -c \'open("greeting.ts", "w")\'',
    "python -c 'print(1)'",
    "node -e 'fs.writeFileSync(1)'",
    "perl -pi -e 's/a/b/' greeting.ts",
    "sed -i '' 's/a/b/' greeting.ts",
    'sed -i.bak s/a/b/ greeting.ts',
    'echo x > greeting.ts',
    'echo x >> greeting.ts',
    'echo x>greeting.ts',
    'echo x 2> greeting.ts',
    'echo x &> greeting.ts',
    'echo x > greeting.ts 2>&1',
    'cat <<EOF',
    'echo x | tee greeting.ts',
    'echo "a" > greeting.ts',
    "echo '>' > greeting.ts",
  ])('flags a write: %s', (command) => {
    expect(bashWrites(command)).toBe(true);
  });

  it.each([
    'git diff greeting.ts 2>&1',
    'git diff greeting.ts >/dev/null',
    'git diff greeting.ts > /dev/null',
    'git diff greeting.ts 2>/dev/null',
    'git diff greeting.ts 2> /dev/null',
    'git diff greeting.ts &>/dev/null',
    'git diff greeting.ts >/dev/null 2>&1',
    'git diff greeting.ts >&2',
    "grep -n '=>' greeting.ts",
    'grep -n "=>" greeting.ts',
    "grep -n 'a <<' greeting.ts",
    'grep -n "it\'s => x" greeting.ts',
    "grep -n '=>' greeting.ts 2>&1",
    'cat greeting.ts',
    "git diff greeting.ts | grep -c 'tee'",
  ])('ignores a read: %s', (command) => {
    expect(bashWrites(command)).toBe(false);
  });
});
