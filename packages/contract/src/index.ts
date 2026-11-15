import '@orpc/effect/extensions/schema';
import { oc } from '@orpc/contract';
import { home } from './home.js';
import { issues } from './issues.js';
import { traces } from './traces.js';

export const contract = oc.router({ traces, issues, home });

export * from './errors.js';
export * from './home.js';
export * from './issues.js';
export * from './traces.js';
