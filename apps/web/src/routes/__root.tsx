import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from '@tanstack/react-router';
import * as S from 'effect/Schema';
import type { ReactNode } from 'react';
import { GlobalFilterSchema } from '#/lib/filters';
import globalsCss from '../globals.css?url';

export const Route = createRootRoute({
  validateSearch: S.toStandardSchemaV1(GlobalFilterSchema),
  shellComponent: RootDocument,
  component: RootComponent,
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'traces' },
    ],
    links: [
      { rel: 'stylesheet', href: globalsCss },
      { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
      { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: '' },
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Geist:wght@100..900&family=Geist+Mono:wght@100..900&display=swap',
      },
    ],
  }),
});

function RootDocument(props: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body>
        {props.children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  return <Outlet />;
}
