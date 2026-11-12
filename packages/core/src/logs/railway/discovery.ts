import { Effect } from 'effect';
import { makeRailwayClient } from './client.js';

export const railwayLinkedProject = (cwd: string) =>
  Effect.gen(function* () {
    const client = yield* makeRailwayClient;
    return yield* client.linkedProject(cwd);
  });

export const railwayProjectLayout = (projectId: string) =>
  Effect.gen(function* () {
    const client = yield* makeRailwayClient;
    return yield* client.projectLayout(projectId);
  });
