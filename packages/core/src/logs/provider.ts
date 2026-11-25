import { Schema } from 'effect';

export const Provider = Schema.Literals(['vercel', 'railway']);
export type Provider = typeof Provider.Type;
