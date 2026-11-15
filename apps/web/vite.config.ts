import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { Config, Effect } from 'effect';
import { nitro } from 'nitro/vite';
import { searchForWorkspaceRoot } from 'vite';
import tsConfigPaths from 'vite-tsconfig-paths';

// pnpm's global virtual store puts dependencies outside the workspace, where
// Vite's default fs.allow rejects them and reports "Failed to load url".
const pnpmVirtualStoreDir = () => {
  const vitePackage = realpathSync(
    createRequire(import.meta.url).resolve('vite/package.json'),
  );
  const marker = '/links/';
  const markerIndex = vitePackage.indexOf(marker);
  if (markerIndex === -1) return [];
  return [vitePackage.slice(0, markerIndex + marker.length)];
};

const config = Effect.gen(function* () {
  const port = yield* Config.Number('PORT').pipe(Config.withDefault(3000));
  return {
    server: {
      port,
      fs: {
        allow: [
          searchForWorkspaceRoot(process.cwd()),
          ...pnpmVirtualStoreDir(),
        ],
      },
    },
    plugins: [
      tsConfigPaths(),
      tailwindcss(),
      tanstackStart(),
      nitro({ preset: 'bun' }),
      viteReact(),
    ],
  };
});

export default Effect.runSync(config);
