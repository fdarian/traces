import { createRootRoute, Outlet } from '@tanstack/react-router';
import * as S from 'effect/Schema';
import { GlobalFilterSchema } from '#/lib/filters';

export const Route = createRootRoute({
  validateSearch: S.standardSchemaV1(GlobalFilterSchema),
  component: RootComponent,
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'traces' },
    ],
    links: [
      { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
      { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: '' },
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Geist:wght@100..900&family=Geist+Mono:wght@100..900&display=swap',
      },
    ],
  }),
});

function RootComponent() {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="stylesheet" href="/src/globals.css" />
      </head>
      <body>
        <Outlet />
      </body>
    </html>
  );
}
