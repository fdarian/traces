import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Layer, Redacted, Stream } from 'effect';
import {
  HttpClient,
  type HttpClientRequest,
  HttpClientResponse,
} from 'effect/http';
import { PlatformError, SystemError } from 'effect/PlatformError';
import {
  type ChildProcess,
  ChildProcessSpawner,
  type CommandLine,
} from 'effect/process';

const unwrap = (word: CommandLine.Word): string =>
  typeof word === 'string' ? word : Redacted.value(word);

export const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', name), 'utf8'));

export interface HttpCall {
  readonly url: string;
  /** Parsed JSON request body; undefined when the request had none. */
  readonly body: unknown;
  readonly authorization: string | undefined;
}

const requestBody = (request: HttpClientRequest.HttpClientRequest): unknown => {
  if (request.body._tag !== 'Uint8Array') return undefined;
  return JSON.parse(new TextDecoder().decode(request.body.body));
};

interface HttpReply {
  readonly status?: number;
  readonly body: unknown;
}

const fakeHttpCalls = (
  respond: (url: URL, call: HttpCall) => HttpReply,
  calls: Array<HttpCall>,
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
      const call = {
        url: url.toString(),
        body: requestBody(request),
        authorization: request.headers.authorization,
      };
      calls.push(call);
      const reply = respond(url, call);
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

export const fakeHttp = (
  respond: (url: URL) => HttpReply,
  calls: Array<HttpCall> = [],
) => fakeHttpCalls((url) => respond(url), calls);

export interface RailwayCall {
  readonly document: string;
  readonly variables: Readonly<Record<string, string | number>>;
}

export interface RailwayHttpCall extends RailwayCall {
  readonly authorization: string | undefined;
}

/** Fakes Railway's GraphQL endpoint: `respond` maps a call to its `data`, unless `override` replaces the whole HTTP reply. */
export const fakeRailwayHttp = (
  respond: (call: RailwayHttpCall) => unknown,
  calls: Array<RailwayHttpCall> = [],
  override?: HttpReply,
) =>
  fakeHttpCalls((_url, http) => {
    const body = http.body as {
      query: string;
      variables: Record<string, string | number>;
    };
    const call = {
      document: body.query,
      variables: body.variables,
      authorization: http.authorization,
    };
    calls.push(call);
    return override ?? { body: { data: respond(call) } };
  }, []);

export interface RailwayCliCall extends RailwayCall {
  /** The full argv after `railway`, to assert which flag carried each variable. */
  readonly args: ReadonlyArray<string>;
}

export interface FakeRailwayCliOptions {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  /** Makes spawning fail as if the binary were not on PATH. */
  readonly missingBinary?: boolean;
}

const encode = (text: string) => Stream.make(new TextEncoder().encode(text));

/** Fakes the `railway` binary: `respond` maps a GraphQL call to its `data`; `--var` values come back as numbers, `--raw-var` as strings. */
export const fakeRailwayCli = (
  respond: (call: RailwayCliCall) => unknown,
  calls: Array<RailwayCliCall> = [],
  options: FakeRailwayCliOptions = {},
) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      if (options.missingBinary) {
        return Effect.fail(
          new PlatformError(
            new SystemError({
              _tag: 'NotFound',
              module: 'ChildProcess',
              method: 'spawn',
            }),
          ),
        );
      }
      const args = (
        command as unknown as ChildProcess.StandardCommand
      ).args.map(unwrap);
      const variables: Record<string, string | number> = {};
      for (let index = 0; index < args.length; index++) {
        const flag = args[index];
        const assignment = args[index + 1];
        if ((flag === '--raw-var' || flag === '--var') && assignment) {
          const separator = assignment.indexOf('=');
          const value = assignment.slice(separator + 1);
          variables[assignment.slice(0, separator)] =
            flag === '--var' ? Number(value) : value;
        }
      }
      const call = { document: args[1] ?? '', variables, args };
      calls.push(call);
      const handle = {
        pid: 1,
        exitCode: Effect.succeed(options.exitCode ?? 0),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: { write: () => Effect.void },
        stdout: encode(
          options.stdout ?? JSON.stringify({ data: respond(call) }),
        ),
        stderr: encode(options.stderr ?? ''),
      };
      return Effect.succeed(
        handle as unknown as ChildProcessSpawner.ChildProcessHandle,
      );
    }),
  );
