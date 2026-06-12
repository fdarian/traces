import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { Config, Effect } from 'effect';
import { nitro } from 'nitro/vite';
import tsConfigPaths from 'vite-tsconfig-paths';

const config = Effect.gen(function* () {
  const port = yield* Config.number('PORT').pipe(Config.withDefault(3000));
  return {
    server: { port },
    plugins: [
      tsConfigPaths(),
      tanstackStart(),
      nitro({ preset: 'bun', serverDir: 'server' }),
      viteReact(),
    ],
  };
});

export default Effect.runSync(config);
