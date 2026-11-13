import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { Effect } from 'effect';
import { InvalidSkill, parseFrontmatter } from '#/commands/skills.ts';

const cliDir = join(import.meta.dir, '..');
const skillsRoot = join(cliDir, 'skills');

const run = async (...args: ReadonlyArray<string>) => {
  const child = Bun.spawn(['bun', 'src/main.ts', 'skills', ...args], {
    cwd: cliDir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    child.stdout.text(),
    child.stderr.text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
};

const REFERENCES = ['commands', 'config', 'output', 'tracing'];

describe('traces skills list', () => {
  test('prints NDJSON name, description and path when piped', async () => {
    const result = await run();
    expect(result.code).toBe(0);
    const records = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(1);
    expect(records[0]?.name).toBe('core');
    expect(typeof records[0]?.description).toBe('string');
    expect(records[0]?.path).toBe(join(skillsRoot, 'core'));
  });

  test('`list` and --json in either position match the bare command', async () => {
    const bare = await run();
    for (const args of [
      ['list'],
      ['list', '--json'],
      ['--json', 'list'],
      ['--json'],
    ]) {
      expect((await run(...args)).stdout).toBe(bare.stdout);
    }
  });
});

describe('traces skills get', () => {
  test('prints SKILL.md without its frontmatter', async () => {
    const result = await run('get', 'core');
    expect(result.code).toBe(0);
    expect(result.stdout.startsWith('# traces\n')).toBe(true);
    expect(result.stdout).not.toContain('description: ');
    expect(result.stdout).toContain('## References');
    expect(result.stdout).not.toContain('# reference: ');
  });

  test('--ref prints just that reference', async () => {
    const result = await run('get', 'core', '--ref', 'tracing');
    expect(result.code).toBe(0);
    expect(result.stdout.startsWith('# Tracing\n')).toBe(true);
    expect(result.stdout).not.toContain('## References');
  });

  test('--full appends every reference behind a header line', async () => {
    const result = await run('get', 'core', '--full');
    expect(result.code).toBe(0);
    const headers = result.stdout
      .split('\n')
      .filter((line) => line.startsWith('# reference: '));
    expect(headers).toEqual(REFERENCES.map((name) => `# reference: ${name}`));
    const single = await run('get', 'core');
    expect(result.stdout.startsWith(single.stdout)).toBe(true);
    expect(result.stdout).toContain('# Tracing\n');
  });

  test('--full with --ref is a usage error', async () => {
    const result = await run('get', 'core', '--full', '--ref', 'tracing');
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('--full and --ref cannot be combined');
  });

  test('an unknown skill lists the valid ones', async () => {
    const result = await run('get', 'nope');
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('unknown skill "nope"');
    expect(result.stderr).toContain('hint: valid skills: core');
  });

  test('an unknown reference lists the valid ones', async () => {
    const result = await run('get', 'core', '--ref', 'nope');
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('has no reference "nope"');
    expect(result.stderr).toContain(
      `hint: valid references: ${REFERENCES.join(', ')}`,
    );
  });
});

describe('traces skills path', () => {
  test('prints the skills root, whatever the cwd', async () => {
    const child = Bun.spawn(
      ['bun', join(cliDir, 'src/main.ts'), 'skills', 'path'],
      { cwd: '/', stdout: 'pipe', stderr: 'pipe' },
    );
    expect((await child.stdout.text()).trim()).toBe(skillsRoot);
  });

  test('prints a skill directory', async () => {
    const result = await run('path', 'core');
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(join(skillsRoot, 'core'));
  });

  test('an unknown skill is a usage error', async () => {
    const result = await run('path', 'nope');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('valid skills: core');
  });
});

describe('parseFrontmatter', () => {
  const parse = (text: string) =>
    Effect.runPromise(parseFrontmatter('SKILL.md', text));

  test('reads key: value lines and returns the body after the block', async () => {
    const parsed = await parse(
      '---\nname: core\ndescription: "Use: when it helps"\n---\n\n# Body\n',
    );
    expect(parsed.fields).toEqual({
      name: 'core',
      description: 'Use: when it helps',
    });
    expect(parsed.body).toBe('# Body\n');
  });

  test('rejects a missing block and a line that is not key: value', async () => {
    await expect(parse('# Body\n')).rejects.toBeInstanceOf(InvalidSkill);
    await expect(parse('---\nnot a pair\n---\nbody')).rejects.toBeInstanceOf(
      InvalidSkill,
    );
  });
});
