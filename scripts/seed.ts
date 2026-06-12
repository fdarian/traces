import {
  BatchSpanProcessor,
  NodeTracerProvider,
} from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { trace } from '@opentelemetry/api';

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

function createProvider(endpoint: string) {
  const exporter = new OTLPTraceExporter({ url: endpoint });
  const provider = new NodeTracerProvider();
  provider.addSpanProcessor(new BatchSpanProcessor(exporter));
  provider.register();
  return provider;
}

function emitTrace(
  tracer: trace.Tracer,
  errorRate: number,
  depth: number,
  parentService: string,
  parentSpan?: ReturnType<typeof tracer.startSpan>,
) {
  if (depth > 3) return;

  const service = depth === 0 ? 'web' : pick(SERVICE_NAMES.filter((s) => s !== parentService));
  const operation = pick(OPERATIONS[service]);
  const span = tracer.startSpan(operation, {
    startTime: Date.now(),
  });

  if (parentSpan) {
    span.setParent(parentSpan.spanContext());
  }

  span.setAttribute('service.name', service);
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
    emitTrace(tracer, errorRate, depth + 1, service, span);
  }

  span.end(Date.now() + duration);
}

async function main() {
  const { traceCount, errorRate, endpoint } = getConfig();

  console.log(`Seeding ${traceCount} traces to ${endpoint} (errorRate=${errorRate})`);

  const provider = createProvider(endpoint);
  const tracer = trace.getTracer('seed-script');

  for (let i = 0; i < traceCount; i++) {
    emitTrace(tracer, errorRate, 0, 'web');
  }

  await new Promise((resolve) => setTimeout(resolve, 3000));
  await provider.shutdown();

  console.log('Seed complete.');
}

main();
