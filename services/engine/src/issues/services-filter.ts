export function servicesFilter(services: ReadonlyArray<string> | undefined): {
  readonly services: ReadonlyArray<string> | undefined;
} {
  return {
    services:
      services !== undefined && services.length > 0 ? services : undefined,
  };
}
