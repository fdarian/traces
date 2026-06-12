import { useSearch } from '@tanstack/react-router';
import { normalizeGlobalFilters } from '#/lib/filters';
import { Route as rootRoute } from '#/routes/__root';

export function useGlobalFilters() {
  const search = useSearch({ from: rootRoute.id });
  return normalizeGlobalFilters(search);
}
