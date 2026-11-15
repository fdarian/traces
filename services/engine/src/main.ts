import { BunRuntime } from '@effect/platform-bun';
import { Layer } from 'effect';
import { Server } from '#/server';

BunRuntime.runMain(Layer.launch(Server));
