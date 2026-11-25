import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

describe('traces CLI usage errors that used to be defects', () => {
  test('--since past the Date range exits 2 and names the value on stderr', async () => {
    const child = Bun.spawn(
      ['bun', 'src/main.ts', 'logs', 'web', '--since', '99999999999d'],
      { cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' },
    );
    const [stdout, stderr, code] = await Promise.all([
      child.stdout.text(),
      child.stderr.text(),
      child.exited,
    ]);
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('--since "99999999999d" is out of range');
  });
});
