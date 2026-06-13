import fs from 'node:fs';
import path from 'node:path';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { Config, Effect } from 'effect';
import { nitro } from 'nitro/vite';
import tsConfigPaths from 'vite-tsconfig-paths';

/** Recursively copies src directory into dest, creating dest if absent. */
function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

const coreRoot = path.resolve(import.meta.dirname, '../../packages/core');

const config = Effect.gen(function* () {
  const port = yield* Config.number('PORT').pipe(Config.withDefault(3000));
  return {
    server: { port },
    plugins: [
      tsConfigPaths(),
      tanstackStart(),
      nitro({
        preset: 'bun',
        serverDir: 'server',
        hooks: {
          compiled(nitro) {
            const outputDir = nitro.options.output.dir;
            for (const dialect of ['sqlite', 'pg'] as const) {
              const src = path.join(coreRoot, 'drizzle', dialect);
              const dest = path.join(outputDir, 'drizzle', dialect);
              copyDir(src, dest);
            }
          },
        },
      }),
      viteReact(),
    ],
  };
});

export default Effect.runSync(config);
