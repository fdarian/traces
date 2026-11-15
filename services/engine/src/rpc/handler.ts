import { COMMON_ERROR_STATUS_MAP } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import {
  issueNotFoundErrors,
  jaegerErrors,
  traceNotFoundErrors,
} from '@traces/contract';
import { Effect } from 'effect';
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http';
import type { EngineServices } from '#/rpc/implementer';
import { logUnexpectedCauses } from '#/rpc/logging';
import { router } from '#/rpc/router';

const definedErrors = {
  ...jaegerErrors,
  ...traceNotFoundErrors,
  ...issueNotFoundErrors,
};

// The RPC protocol ignores `status` on contract errors and answers 400 for any
// code missing from this map, so the contract's statuses are applied here.
const errorStatusMap: Record<string, number> = {
  ...COMMON_ERROR_STATUS_MAP,
  ...Object.fromEntries(
    Object.entries(definedErrors).map(([code, definition]) => [
      code,
      definition.status,
    ]),
  ),
};

export const handler = new RPCHandler(router, { errorStatusMap });

export const RpcRoute = HttpRouter.add(
  '*',
  '/rpc/*',
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const webRequest = yield* HttpServerRequest.toWeb(request);
    const context = yield* Effect.context<EngineServices>();
    const result = yield* Effect.promise(() =>
      handler.handle(webRequest, {
        prefix: '/rpc',
        context: {
          'effect/context': context,
          'effect/wrap': logUnexpectedCauses,
        },
      }),
    );
    if (!result.matched) {
      return HttpServerResponse.text('Not Found', { status: 404 });
    }
    return HttpServerResponse.fromWeb(result.response);
  }),
);
