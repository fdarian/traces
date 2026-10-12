import { Schema } from 'effect';

export const Provider = Schema.Literal('vercel', 'railway');
export type Provider = typeof Provider.Type;
