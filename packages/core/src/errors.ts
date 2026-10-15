import { Schema } from 'effect';

export class JaegerUnreachable extends Schema.TaggedError<JaegerUnreachable>()(
  'JaegerUnreachable',
  {
    cause: Schema.Defect(),
  },
) {}

export class JaegerBadResponse extends Schema.TaggedError<JaegerBadResponse>()(
  'JaegerBadResponse',
  {
    cause: Schema.Defect(),
    status: Schema.optional(Schema.Number),
  },
) {}

export class TraceNotFound extends Schema.TaggedError<TraceNotFound>()(
  'TraceNotFound',
  {
    traceId: Schema.String,
  },
) {}

export class TraceBackendUnauthorized extends Schema.TaggedError<TraceBackendUnauthorized>()(
  'TraceBackendUnauthorized',
  {
    status: Schema.Number,
    url: Schema.String,
  },
) {}
