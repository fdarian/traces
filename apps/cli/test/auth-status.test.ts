import { describe, expect, test } from 'bun:test';
import { BunServices } from '@effect/platform-bun';
import { ConfigProvider, Effect, Layer } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import { vercelAuthStatus } from '#/auth-status.ts';

const statusOf = (status: number) =>
  Effect.runPromise(
    vercelAuthStatus.pipe(
      Effect.provide(
        Layer.mergeAll(
          BunServices.layer,
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ VERCEL_TOKEN: 'tok' }),
          ),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response('{}', { status }),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );

describe('vercelAuthStatus', () => {
  test('200 is ok', async () => {
    expect(await statusOf(200)).toEqual({
      status: 'ok',
      detail: 'token from VERCEL_TOKEN',
    });
  });

  test('only 401 and 403 reject the token', async () => {
    for (const code of [401, 403]) {
      const result = await statusOf(code);
      expect(result.status).toBe('invalid');
      expect(result.detail).toContain(`HTTP ${code}`);
    }
  });

  test('a rate limit or server error is an error with the status code, not a rejected token', async () => {
    for (const code of [429, 500, 503]) {
      const result = await statusOf(code);
      expect(result.status).toBe('error');
      expect(result.detail).toContain(`HTTP ${code}`);
      expect(result.detail).not.toContain('rejected');
    }
  });
});
