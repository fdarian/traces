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

/** A header value that names an environment variable which is unset or empty. */
export class EnvVarMissing extends Schema.TaggedError<EnvVarMissing>()(
  'EnvVarMissing',
  { name: Schema.String },
) {}

/** `traces init` found no Railway or Vercel project to put in the config. */
export class NothingDiscovered extends Schema.TaggedError<NothingDiscovered>()(
  'NothingDiscovered',
  {},
) {}

/** A Railway project's service listing failed while resolving a name; `cause` keeps the typed error so its exit code survives. */
export class RailwayProjectLookupFailed extends Schema.TaggedError<RailwayProjectLookupFailed>()(
  'RailwayProjectLookupFailed',
  {
    project: Schema.String,
    cause: Schema.Defect(),
  },
) {}
