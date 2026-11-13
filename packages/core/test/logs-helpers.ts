import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import {
  HttpClient,
  type HttpClientRequest,
  HttpClientResponse,
} from 'effect/http';

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
        url.searchParams.set(entry[0], entry[1]);
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
  readonly authorization: string | undefined;
}

/** Fakes Railway's GraphQL endpoint: `respond` maps a call to its `data`, unless `override` replaces the whole HTTP reply. */
export const fakeRailway = (
  respond: (call: RailwayCall) => unknown,
  calls: Array<RailwayCall> = [],
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
