import { Schema } from 'effect';
import { Provider } from './provider.js';

export class ProviderAuthError extends Schema.TaggedError<ProviderAuthError>()(
  'ProviderAuthError',
  {
    provider: Provider,
    hint: Schema.String,
  },
) {}

export class ProviderRequestError extends Schema.TaggedError<ProviderRequestError>()(
  'ProviderRequestError',
  {
    provider: Provider,
    cause: Schema.Defect(),
  },
) {}

export class ProviderResponseInvalid extends Schema.TaggedError<ProviderResponseInvalid>()(
  'ProviderResponseInvalid',
  {
    provider: Provider,
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class ProviderNotFound extends Schema.TaggedError<ProviderNotFound>()(
  'ProviderNotFound',
  {
    provider: Provider,
    what: Schema.String,
    hint: Schema.String,
  },
) {}

export class InvalidCursor extends Schema.TaggedError<InvalidCursor>()(
  'InvalidCursor',
  {
    cause: Schema.Defect(),
  },
) {}

export type ProviderError =
  | ProviderAuthError
  | ProviderRequestError
  | ProviderResponseInvalid
  | ProviderNotFound;
