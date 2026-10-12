import { Command } from '@effect/cli';
import { Console, Effect } from 'effect';
import {
  type AuthStatus,
  railwayAuthStatus,
  vercelAuthStatus,
} from '#/auth-status.ts';
import type { ServiceConfig } from '#/config.ts';
import { emitRecord, outputMode } from '#/output.ts';
import { globalOptions, resolveProject } from '#/resolve.ts';

interface ServiceRecord {
  readonly configPath: string;
  readonly project: string;
  readonly matchedBy: 'flag' | 'path' | 'git';
  readonly service: string;
  readonly provider: 'vercel' | 'railway';
  readonly ref: ServiceConfig;
  readonly auth: AuthStatus;
}

const formatService = (record: ServiceRecord): string => {
  const ref =
    record.ref.provider === 'railway'
      ? `project ${record.ref.project} service ${record.ref.service} env ${record.ref.environment ?? 'production'}`
      : `project ${record.ref.project}${record.ref.team === undefined ? '' : ` team ${record.ref.team}`}`;
  return `${record.service.padEnd(16)} ${record.provider.padEnd(8)} ${ref}  auth: ${record.auth.status} (${record.auth.detail})`;
};

export const servicesOptions = { ...globalOptions };

export const servicesCommand = Command.make(
  'services',
  servicesOptions,
  (args) =>
    Effect.gen(function* () {
      const resolved = yield* resolveProject(args);
      const mode = outputMode(args.json);
      if (mode === 'human') {
        yield* Console.log(
          `config ${resolved.configPath}\nproject ${resolved.projectName} (matched by ${resolved.matchedBy})`,
        );
      }
      const authCache = new Map<'vercel' | 'railway', AuthStatus>();
      for (const [service, ref] of Object.entries(resolved.project.services)) {
        let auth = authCache.get(ref.provider);
        if (auth === undefined) {
          auth = yield* ref.provider === 'railway'
            ? railwayAuthStatus
            : vercelAuthStatus;
          authCache.set(ref.provider, auth);
        }
        yield* emitRecord(
          mode,
          {
            configPath: resolved.configPath,
            project: resolved.projectName,
            matchedBy: resolved.matchedBy,
            service,
            provider: ref.provider,
            ref,
            auth,
          } satisfies ServiceRecord,
          formatService,
        );
      }
    }),
);
