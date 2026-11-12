import {
  coalesceMultiline,
  type Deployment,
  type ErrorGroup,
  groupErrors,
  type LogSource,
  latestReadyDeployment,
  ProviderResponseInvalid,
} from '@traces/core';
import { Effect } from 'effect';
import { UsageError } from '#/errors.ts';
import { DEPLOY_SCAN, ERROR_CAP } from '#/limits.ts';
import { shortId } from '#/output.ts';

const HOUR_MS = 60 * 60 * 1000;
const BASELINE_MAX_MS = 24 * HOUR_MS;

/** A deploy-anchored `errors` window: the deploy onward, plus the stretch before it that says what was already failing. */
export interface DeployWindow {
  readonly deployment: Deployment;
  readonly since: Date;
  readonly baselineSince: Date;
}

/** `2026-10-15T15:16:57Z`: whole seconds read better in a stderr line than `.000Z`. */
export const isoSeconds = (date: Date): string =>
  date.toISOString().replace(/\.000Z$/, 'Z');

export const deploySinceText = (deployment: Deployment, since: Date): string =>
  `since deploy ${shortId(deployment.id)} at ${isoSeconds(since)}`;

const formatSpan = (ms: number): string => {
  const hours = Math.floor(ms / HOUR_MS);
  const minutes = Math.round((ms % HOUR_MS) / 60_000);
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h${minutes}m`;
};

export const baselineText = (window: DeployWindow): string =>
  `baseline ${formatSpan(window.since.getTime() - window.baselineSince.getTime())} before`;

export const deployInstant = (
  deployment: Deployment,
): Effect.Effect<Date, ProviderResponseInvalid> => {
  const at = new Date(deployment.createdAt);
  return Number.isNaN(at.getTime())
    ? new ProviderResponseInvalid({
        provider: deployment.provider,
        operation: 'deployments',
        cause: new Error(
          `deployment ${deployment.id} has createdAt "${deployment.createdAt}"`,
        ),
      })
    : Effect.succeed(at);
};

/** The baseline is as long as the post-deploy window, capped at 24h, so a short window is compared against a like-sized one. */
export const deployWindow = (
  deployment: Deployment,
  until: Date | undefined,
  now: Date,
) =>
  Effect.gen(function* () {
    const at = yield* deployInstant(deployment);
    const postLength = (until ?? now).getTime() - at.getTime();
    if (postLength <= 0) {
      return yield* new UsageError({
        message: `--until is not after the latest ready deploy (${deploySinceText(deployment, at)})`,
        hint: 'move --until later, or drop it',
      });
    }
    return {
      deployment,
      since: at,
      baselineSince: new Date(
        at.getTime() - Math.min(postLength, BASELINE_MAX_MS),
      ),
    } satisfies DeployWindow;
  });

export const resolveDeployWindow = (
  source: LogSource,
  service: string,
  until: Date | undefined,
  now: Date,
) =>
  latestReadyDeployment(source, { service, scan: DEPLOY_SCAN }).pipe(
    Effect.flatMap((deployment) => deployWindow(deployment, until, now)),
  );

/** Fingerprints of the error logs in the baseline window, grouped the way the window's own logs are. Only fingerprints, never counts. */
export const logBaseline = (source: LogSource, window: DeployWindow) =>
  Effect.gen(function* () {
    const page = yield* source.logs({
      since: window.baselineSince,
      until: window.since,
      levels: ['error', 'fatal'],
      limit: ERROR_CAP,
    });
    return {
      fingerprints: new Set(
        groupErrors(coalesceMultiline(page.records)).map(
          (group) => group.fingerprint,
        ),
      ),
      capped: page.next !== undefined,
    };
  });

/** Log and trace fingerprints never mix, and each service has its own baseline. */
export const baselineKey = (group: {
  readonly source: ErrorGroup['source'];
  readonly service: string;
}): string => `${group.source}\0${group.service}`;

export const isNewGroup = (
  group: ErrorGroup,
  baselines: ReadonlyMap<string, ReadonlySet<string>>,
): boolean => {
  const baseline = baselines.get(baselineKey(group));
  if (baseline === undefined) {
    throw new Error(
      `no baseline for ${group.source} service "${group.service}"`,
    );
  }
  return !baseline.has(group.fingerprint);
};
