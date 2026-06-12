import { createStart } from '@tanstack/react-start';
import { wrapErrorsMiddleware } from '#/server/errors/server-fn-middleware';

export const startInstance = createStart(() => {
  return {
    functionMiddleware: [wrapErrorsMiddleware],
  };
});
