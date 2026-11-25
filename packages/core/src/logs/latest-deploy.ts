import { Effect, Schema } from 'effect';
import type { ProviderError } from './errors.js';
import type { Deployment } from './model.js';
import type { LogSource } from './source.js';

export class NoReadyDeployment extends Schema.TaggedError<NoReadyDeployment>()(
  'NoReadyDeployment',
  {
    service: Schema.String,
    scanned: Schema.Number,
  },
) {}

const PAGE_MAX = 100;

/**
 * Newest `ready` deployment among the first `scan` records of `source.deployments`.
 * Sorts by `createdAt` rather than trusting the provider's order, and skips every other
 * status (a `removed` deployment is a replaced one, not the live one). Not `--deploy latest`:
 * that resolves inside each source and does not filter on ready.
 */
export const latestReadyDeployment = (
  source: LogSource,
  options: { readonly service: string; readonly scan: number },
): Effect.Effect<Deployment, ProviderError | NoReadyDeployment> =>
  Effect.gen(function* () {
    const seen: Array<Deployment> = [];
    let cursor: Parameters<LogSource['deployments']>[0]['cursor'];
    while (seen.length < options.scan) {
      const page = yield* source.deployments({
        limit: Math.min(options.scan - seen.length, PAGE_MAX),
        cursor,
      });
      seen.push(...page.deployments);
      if (page.next === undefined || page.deployments.length === 0) break;
      cursor = page.next;
    }
    const ready = seen
      .filter((deployment) => deployment.status === 'ready')
      .sort(
        (left, right) =>
          Date.parse(right.createdAt) - Date.parse(left.createdAt),
      );
    const latest = ready[0];
    if (latest === undefined) {
      return yield* new NoReadyDeployment({
        service: options.service,
        scanned: seen.length,
      });
    }
    return latest;
  });
