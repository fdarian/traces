import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterContractClient } from '@orpc/contract';
import { createIsomorphicFn } from '@tanstack/react-start';
import type { contract } from '@traces/contract';
import { getEngineUrl } from '#/lib/engine-url';

// SSR talks to the engine directly; the browser goes through the same-origin
// proxy at /api/rpc so the engine stays private.
const createLink = createIsomorphicFn()
  .server(() => new RPCLink({ origin: getEngineUrl(), url: '/rpc' }))
  .client(() => new RPCLink({ url: '/api/rpc' }));

export const engine: RouterContractClient<typeof contract> = createORPCClient(
  createLink(),
);
