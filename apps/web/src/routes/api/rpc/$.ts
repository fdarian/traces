import { createFileRoute } from '@tanstack/react-router';
import { getEngineUrl } from '#/lib/engine-url';

const PROXY_PREFIX = '/api/rpc';

// fetch() already decoded the body, so these would be wrong on the way back.
const STRIPPED_RESPONSE_HEADERS = ['content-encoding', 'content-length'];
const STRIPPED_REQUEST_HEADERS = ['host', 'connection', 'content-length'];

async function forwardToEngine(request: Request): Promise<Response> {
  const incoming = new URL(request.url);
  const target = `${getEngineUrl()}/rpc${incoming.pathname.slice(PROXY_PREFIX.length)}${incoming.search}`;

  const headers = new Headers(request.headers);
  for (const name of STRIPPED_REQUEST_HEADERS) {
    headers.delete(name);
  }

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    duplex: hasBody ? 'half' : undefined,
    redirect: 'manual',
    signal: request.signal,
  };

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch (err) {
    console.error(`engine unreachable at ${target}`, err);
    return new Response('Engine unreachable', { status: 502 });
  }

  const responseHeaders = new Headers(upstream.headers);
  for (const name of STRIPPED_RESPONSE_HEADERS) {
    responseHeaders.delete(name);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export const Route = createFileRoute('/api/rpc/$')({
  server: {
    handlers: {
      ANY: ({ request }) => forwardToEngine(request),
    },
  },
});
