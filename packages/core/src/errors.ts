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
  },
) {}

export class TraceNotFound extends Schema.TaggedError<TraceNotFound>()(
  'TraceNotFound',
  {
    traceId: Schema.String,
  },
) {}
