import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import { type Cursor, decodeCursor, encodeCursor } from '#/index.js';

const cursors: ReadonlyArray<Cursor> = [
  {
    kind: 'railway-time',
    since: 1791763369416,
    before: '2026-10-12T00:25:58.664085257Z',
    seen: ['315201902d'],
  },
  { kind: 'railway-time', before: '2026-10-12T00:25:58.664085257Z', seen: [] },
  { kind: 'railway-relay', after: 'R1BDOlM6YWJj' },
  { kind: 'vercel-page', since: 1, until: 9, page: 3, skip: 2 },
  { kind: 'vercel-until', until: 1791614887689, seen: ['abc', 'def'] },
];

describe('cursor', () => {
  test.each(
    cursors.map((cursor) => [cursor.kind, cursor] as const),
  )('round-trips %s', async (_kind, cursor) => {
    const encoded = encodeCursor(cursor);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await Effect.runPromise(decodeCursor(encoded))).toEqual(cursor);
  });

  test('rejects garbage as InvalidCursor', async () => {
    const result = await Effect.runPromise(
      decodeCursor('not-a-cursor').pipe(Effect.either),
    );
    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') expect(result.left._tag).toBe('InvalidCursor');
  });

  test('rejects well-formed JSON of the wrong shape', async () => {
    const encoded = Buffer.from(JSON.stringify({ kind: 'nope' })).toString(
      'base64url',
    );
    const result = await Effect.runPromise(
      decodeCursor(encoded).pipe(Effect.either),
    );
    expect(result._tag).toBe('Left');
  });
});
