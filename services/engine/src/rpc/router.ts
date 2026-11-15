import { homeRouter } from '#/home/home.router';
import { issuesRouter } from '#/issues/issues.router';
import { os } from '#/rpc/implementer';
import { tracesRouter } from '#/traces/traces.router';

export const router = os.router({
  traces: tracesRouter,
  issues: issuesRouter,
  home: homeRouter,
});
