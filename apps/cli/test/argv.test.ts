import { describe, expect, test } from 'bun:test';
import { hoistGlobalFlags } from '#/argv.ts';

const hoist = (...args: Array<string>) => [...hoistGlobalFlags(args)];

describe('hoistGlobalFlags', () => {
  test('moves leading global flags behind the command', () => {
    expect(hoist('--config', 'x', 'services')).toEqual([
      'services',
      '--config',
      'x',
    ]);
    expect(
      hoist('--json', '--project', 'p', 'logs', 'api', '--since', '1h'),
    ).toEqual(['logs', '--json', '--project', 'p', 'api', '--since', '1h']);
  });

  test('handles the = forms', () => {
    expect(hoist('--env=staging', '--config=/c.json', 'logs', 'api')).toEqual([
      'logs',
      '--env=staging',
      '--config=/c.json',
      'api',
    ]);
  });

  test('leaves arguments without leading global flags untouched', () => {
    expect(hoist('logs', 'api', '--json')).toEqual(['logs', 'api', '--json']);
    expect(hoist()).toEqual([]);
  });

  test('stops at unknown flags', () => {
    expect(hoist('--json', '--help')).toEqual(['--json', '--help']);
    expect(hoist('--json', '--bogus', 'logs')).toEqual([
      '--json',
      '--bogus',
      'logs',
    ]);
  });

  test('leaves a dangling value flag or a missing command alone', () => {
    expect(hoist('--project')).toEqual(['--project']);
    expect(hoist('--json')).toEqual(['--json']);
    expect(hoist('logs', '--project')).toEqual(['logs', '--project']);
  });

  test('does not touch flags after the command', () => {
    expect(hoist('--json', 'logs', '--config', 'x')).toEqual([
      'logs',
      '--json',
      '--config',
      'x',
    ]);
  });
});
