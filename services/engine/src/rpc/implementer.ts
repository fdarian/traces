import '@orpc/effect/extensions/effect';
import type { WithEffectContext } from '@orpc/effect';
import { implement } from '@orpc/server';
import { contract } from '@traces/contract';
import type { TraceBackendInterface } from '@traces/core';
import type { IssueStore as IssueStoreInterface } from '#/issues/store';
import type { ServiceStatsStore as ServiceStatsStoreInterface } from '#/service-stats/store';

export type EngineServices =
  | TraceBackendInterface
  | IssueStoreInterface
  | ServiceStatsStoreInterface;

export interface EngineContext extends WithEffectContext<EngineServices> {}

export const os = implement(contract).$context<EngineContext>();
