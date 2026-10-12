import { type LogLevel, normalizeLevel } from '@traces/core';
import { Effect } from 'effect';
import { UsageError } from '#/errors.ts';

export const parseLevels = (text: string) =>
  Effect.gen(function* () {
    const levels: Array<LogLevel> = [];
    for (const part of text.split(',')) {
      const level = normalizeLevel(part.trim());
      if (level === 'unknown') {
        return yield* new UsageError({
          message: `unknown level "${part.trim()}"`,
          hint: 'use any of: debug, info, warn, error, fatal (comma-separated)',
        });
      }
      if (!levels.includes(level)) levels.push(level);
    }
    return levels;
  });
