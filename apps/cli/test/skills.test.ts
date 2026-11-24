import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

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
  test('prints NDJSON name and description when piped', async () => {
    const result = await run();
    expect(result.code).toBe(0);
    const records = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(1);
    expect(records[0]?.name).toBe('core');
    expect(typeof records[0]?.description).toBe('string');
    expect(Object.keys(records[0] ?? {}).sort()).toEqual([
      'description',
      'name',
    ]);
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

  test('the skills are embedded, so the command works from any directory', async () => {
    const child = Bun.spawn(
      ['bun', join(cliDir, 'src/main.ts'), 'skills', 'get', 'core'],
      { cwd: '/', stdout: 'pipe', stderr: 'pipe' },
    );
    expect((await child.stdout.text()).startsWith('# traces\n')).toBe(true);
    expect(await child.exited).toBe(0);
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

  test('--file references/<name>.md prints just that reference', async () => {
    const result = await run('get', 'core', '--file', 'references/tracing.md');
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
  });

  test('the old --ref flag and `path` command are gone', async () => {
    expect((await run('get', 'core', '--ref', 'tracing')).code).toBe(2);
    expect((await run('path')).code).toBe(2);
  });
});

describe('traces skills stub', () => {
  test('prints a SKILL.md that points at `traces skills get core`', async () => {
    const result = await run('stub', 'core');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('name: traces-core');
    expect(result.stdout).toContain('`traces skills get core`');
  });
});

describe('skills errors exit 2 with the hint', () => {
  test('an unknown skill lists the valid ones', async () => {
    const result = await run('get', 'nope');
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('error: unknown skill "nope"');
    expect(result.stderr).toContain('hint: valid skills: core');
  });

  test('an unknown file lists the valid ones', async () => {
    const result = await run('get', 'core', '--file', 'references/nope.md');
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('has no file "references/nope.md"');
    expect(result.stderr).toContain('hint: valid files: SKILL.md');
  });

  test('a path outside the skill is rejected', async () => {
    const result = await run('get', 'core', '--file', '../core/SKILL.md');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('hint:');
  });

  test('--full with --file is rejected', async () => {
    const result = await run(
      'get',
      'core',
      '--full',
      '--file',
      'references/tracing.md',
    );
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('--full and --file cannot be combined');
  });

  test('stub of an unknown skill exits 2', async () => {
    expect((await run('stub', 'nope')).code).toBe(2);
  });
});

describe('command documentation', () => {
  const commands = [
    'init',
    'services',
    'logs',
    'deploys',
    'errors',
    'spans',
    'trace',
    'secret',
  ];

  const read = (path: string) => Bun.file(join(skillsRoot, path)).text();

  const help = async (...args: ReadonlyArray<string>) => {
    const child = Bun.spawn(['bun', 'src/main.ts', ...args, '--help'], {
      cwd: cliDir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout] = await Promise.all([child.stdout.text(), child.exited]);
    return stdout.replace(/\s+/g, ' ');
  };

  test('SKILL.md lists every command and commands.md has a section for each', async () => {
    const skill = await read('core/SKILL.md');
    const reference = await read('core/references/commands.md');
    for (const name of commands) {
      expect(skill).toContain(`| \`traces ${name}`);
      expect(reference).toContain(`## traces ${name}\n`);
    }
  });

  test('--since deploy is documented in flag help and in the references', async () => {
    for (const name of ['logs', 'errors']) {
      expect(await help(name)).toContain('deploy');
    }
    expect(await help('errors')).toContain('new, deploymentId and deployedAt');
    const reference = await read('core/references/commands.md');
    expect(reference).toContain('--since deploy');
    expect(reference).toContain('`new: true`');
    expect(reference).toContain('countedSince');
    expect(await read('core/SKILL.md')).toContain(
      'traces errors --since deploy',
    );
  });

  test('init and the repo traces.json are documented', async () => {
    const init = await help('init');
    expect(init).toContain('--railway-project');
    expect(init).toContain('--jaeger-header');
    expect(init).toContain('--dry-run');
    const config = await read('core/references/config.md');
    expect(config).toContain('traces.json');
    expect(config).toContain('configSource');
    expect(await help('logs')).toContain(
      "A name the config doesn't list is looked up by Railway service id or name",
    );
  });
});
