import type { Effect } from 'effect';
import type { ProviderError } from './errors.js';
import type {
  DeploymentPage,
  DeploymentQuery,
  LogPage,
  LogQuery,
} from './model.js';
import type { Provider } from './provider.js';

/** Per-service view of a provider; built by `makeRailwaySource` / `makeVercelSource`. */
export interface LogSource {
  readonly provider: Provider;
  /** Included in empty-result messages so "no logs" isn't mistaken for "no errors". */
  readonly retentionNote: string;
  readonly logs: (query: LogQuery) => Effect.Effect<LogPage, ProviderError>;
  readonly httpLogs: (query: LogQuery) => Effect.Effect<LogPage, ProviderError>;
  readonly buildLogs: (
    query: LogQuery,
  ) => Effect.Effect<LogPage, ProviderError>;
  readonly deployments: (
    query: DeploymentQuery,
  ) => Effect.Effect<DeploymentPage, ProviderError>;
}
