import { BunHttpServer } from '@effect/platform-bun';
import { JaegerBackendLayer } from '@traces/core';
import { Config, Effect, Layer } from 'effect';
import { FetchHttpClient, HttpRouter, HttpServerResponse } from 'effect/http';
import { IngesterLayer } from '#/issues/ingester';
import { IssueStoreLayer } from '#/issues/issue-store-layer';
import { RpcRoute } from '#/rpc/handler';
import { ServiceStatsStoreLayer } from '#/service-stats/service-stats-store-layer';

const Health = HttpRouter.add(
  'GET',
  '/health',
  Effect.succeed(HttpServerResponse.jsonUnsafe({ status: 'ok' })),
);

const JaegerLive = Layer.provide(JaegerBackendLayer, FetchHttpClient.layer);

export const Services = Layer.mergeAll(
  JaegerLive,
  IssueStoreLayer,
  ServiceStatsStoreLayer,
);

// Ingester is built on top of the same store/backend instances as the RPC services.
const IngesterLive = Layer.provide(IngesterLayer, Services);

const ServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const port = yield* Config.Port('PORT').pipe(Config.withDefault(4000));
    const hostname = yield* Config.String('HOST').pipe(
      Config.withDefault('0.0.0.0'),
    );
    return BunHttpServer.layer({ port, hostname });
  }),
);

export const Routes = Layer.mergeAll(Health, RpcRoute);

export const Server = HttpRouter.serve(Routes).pipe(
  Layer.provide(Layer.mergeAll(Services, IngesterLive)),
  Layer.provide(ServerLive),
);
