import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Layer, Redacted, Stream } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import {
  type ChildProcess,
  ChildProcessSpawner,
  type CommandLine,
} from 'effect/process';

const unwrap = (word: CommandLine.Word): string =>
  typeof word === 'string' ? word : Redacted.value(word);

export const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', name), 'utf8'));

export interface RailwayCall {
  readonly document: string;
  readonly variables: Readonly<Record<string, string>>;
}

/** Fakes the `railway` binary: `respond` maps a GraphQL call to its `data`. */
export const fakeRailway = (
  respond: (call: RailwayCall) => unknown,
  calls: Array<RailwayCall> = [],
  options: { readonly exitCode?: number; readonly stdout?: string } = {},
) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const args = (
        command as unknown as ChildProcess.StandardCommand
      ).args.map(unwrap);
      const variables: Record<string, string> = {};
      for (let index = 0; index < args.length; index++) {
        const flag = args[index];
        const assignment = args[index + 1];
        if ((flag === '--raw-var' || flag === '--var') && assignment) {
          const separator = assignment.indexOf('=');
          variables[assignment.slice(0, separator)] = assignment.slice(
            separator + 1,
          );
        }
      }
      const call = { document: args[1] ?? '', variables };
      calls.push(call);
      const stdout = options.stdout ?? JSON.stringify({ data: respond(call) });
      const handle = {
        pid: 1,
        exitCode: Effect.succeed(options.exitCode ?? 0),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: { write: () => Effect.void },
        stdout: Stream.make(new TextEncoder().encode(stdout)),
        stderr: Stream.empty,
      };
      return Effect.succeed(
        handle as unknown as ChildProcessSpawner.ChildProcessHandle,
      );
    }),
  );

export interface HttpCall {
  readonly url: string;
}

export const fakeHttp = (
  respond: (url: URL) => { readonly status?: number; readonly body: unknown },
  calls: Array<HttpCall> = [],
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const url = new URL(request.url);
      for (const entry of request.urlParams) {
        url.searchParams.set(
          entry[0],
          typeof entry[1] === 'string' ? entry[1] : Redacted.value(entry[1]),
        );
      }
      calls.push({ url: url.toString() });
      const reply = respond(url);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(reply.body), {
            status: reply.status ?? 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      );
    }),
  );
