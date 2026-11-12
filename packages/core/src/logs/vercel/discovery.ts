import { Effect, type Redacted } from 'effect';
import { makeVercelClient } from './client.js';
import { ProjectResponse } from './schema.js';

const API = 'https://api.vercel.com';

/** The project's name, for naming a service in a generated config. `team` is the `orgId` of a `.vercel/project.json`. */
export const fetchVercelProjectName = (
  project: { readonly id: string; readonly team?: string },
  token: Redacted.Redacted<string>,
) =>
  Effect.gen(function* () {
    const client = yield* makeVercelClient(
      project.team === undefined ? {} : { team: project.team },
      token,
    );
    const found = yield* client.get(
      'project',
      `${API}/v9/projects/${encodeURIComponent(project.id)}`,
      client.teamParams,
      ProjectResponse,
    );
    return found.name;
  });
