import { Effect } from 'effect';
import { ProviderNotFound } from '../errors.js';
import type { RailwayClient } from './client.js';
import { PROVIDER } from './normalize.js';
import { PROJECT_QUERY } from './queries.js';
import { ProjectData } from './schema.js';

/** Every service and environment of a Railway project. */
export const railwayProjectLayout = (
  client: RailwayClient,
  projectId: string,
) =>
  Effect.gen(function* () {
    const data = yield* client.query(
      'project',
      PROJECT_QUERY,
      { id: projectId },
      ProjectData,
    );
    if (data.project === null) {
      return yield* new ProviderNotFound({
        provider: PROVIDER,
        what: `project ${projectId}`,
        hint: 'check the project id and that the token or `railway` login can see it',
      });
    }
    return {
      services: data.project.services.edges.map((edge) => edge.node),
      environments: data.project.environments.edges.map((edge) => edge.node),
    };
  });
