import { Schema } from 'effect';

/** Bad flags, unknown service, unmatched project — anything the caller can fix by changing the invocation. */
export class UsageError extends Schema.TaggedError<UsageError>()('UsageError', {
  message: Schema.String,
  hint: Schema.String,
}) {}

export class ConfigError extends Schema.TaggedError<ConfigError>()(
  'ConfigError',
  {
    path: Schema.String,
    message: Schema.String,
    hint: Schema.String,
  },
) {}
