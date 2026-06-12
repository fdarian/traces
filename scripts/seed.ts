import {
  BatchSpanProcessor,
  NodeTracerProvider,
} from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { trace, Span, TraceFlags } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const SERVICE_NAMES = ['web', 'api', 'payments', 'db'];

const EXCEPTION_TYPES = [
  { type: 'DatabaseConnectionError', message: 'connection refused to postgres:5432' },
  { type: 'PaymentGatewayError', message: 'stripe returned 402 card declined' },
  { type: 'NullPointerException', message: 'cannot read property of undefined at line 42' },
  { type: 'ValidationError', message: 'field email is required' },
  { type: 'TimeoutError', message: 'request timed out after 30000ms' },
];

const OPERATIONS: Record<string, string[]> = {
  web: ['GET /', 'GET /dashboard', 'POST /api/checkout', 'GET /api/health'],
  api: ['processCheckout', 'getUser', 'listOrders', 'createInvoice'],
  payments: ['chargeCard', 'refund', 'createCustomer', 'verify3DS'],
  db: ['select', 'insert', 'update', 'delete'],
};

function getConfig() {
  const traceCount = Number.parseInt(process.env.TRACE_COUNT ?? '50', 10);
  const errorRate = Number.parseFloat(process.env.ERROR_RATE ?? '0.15');
  const endpoint = process.env.OTLP_ENDPOINT ?? 'http://localhost:4318/v1/traces';
  return { traceCount, errorRate, endpoint };
}

function randomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomDuration() {
  return randomInt(10, 800);
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shouldError(errorRate: number) {
  return Math.random() < errorRate;
}

function createProviders(endpoint: string) {
  const exporter = new OTLPTraceExporter({ url: endpoint });
  const providers: Record<string, NodeTracerProvider> = {};

  for (const service of SERVICE_NAMES) {
    const provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: service,
      }),
      spanProcessors: [new BatchSpanProcessor(exporter)],
    });
    provider.register();
    providers[service] = provider;
  }

  return providers;
}

function emitTrace(
  providers: Record<string, NodeTracerProvider>,
  errorRate: number,
  depth: number,
  parentService: string,
  parentSpan?: Span,
) {
  if (depth > 3) return;

  const service = depth === 0 ? 'web' : pick(SERVICE_NAMES.filter((s) => s !== parentService));
  const operation = pick(OPERATIONS[service]);
  const provider = providers[service];
  const tracer = provider.getTracer('seed-script');

  const span = tracer.startSpan(
    operation,
    {
      startTime: Date.now(),
      ...(parentSpan && { parent: parentSpan.spanContext() }),
    },
  );

  span.setAttribute('operation', operation);
  span.setAttribute('span.kind', depth === 0 ? 'server' : 'internal');

  const duration = randomDuration();
  const isError = shouldError(errorRate);

  if (isError) {
    const exception = pick(EXCEPTION_TYPES);
    span.recordException({
      name: exception.type,
      message: exception.message,
      stack: `${exception.type}: ${exception.message}\n    at ${operation} (/app/${service}/src/index.ts:${randomInt(1, 200)}:${randomInt(1, 80)})`,
    });
    span.setStatus({ code: 2, message: exception.message });
  }

  const childCount = depth === 0 ? randomInt(1, 3) : randomInt(0, 2);
  for (let i = 0; i < childCount; i++) {
    emitTrace(providers, errorRate, depth + 1, service, span);
  }

  span.end(Date.now() + duration);
}

async function main() {
  const { traceCount, errorRate, endpoint } = getConfig();

  console.log(`Seeding ${traceCount} traces to ${endpoint} (errorRate=${errorRate})`);

  const providers = createProviders(endpoint);

  for (let i = 0; i < traceCount; i++) {
    emitTrace(providers, errorRate, 0, 'web');
  }

  await new Promise((resolve) => setTimeout(resolve, 3000));

  for (const provider of Object.values(providers)) {
    await provider.shutdown();
  }

  console.log('Seed complete.');
}

main();
