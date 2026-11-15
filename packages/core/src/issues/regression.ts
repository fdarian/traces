export function isRegressedIssue(issue: {
  readonly status: 'unresolved' | 'resolved';
  readonly resolvedAt: Date | null;
  readonly lastSeen: Date;
}): boolean {
  if (issue.status !== 'unresolved') {
    return false;
  }
  if (issue.resolvedAt === null) {
    return false;
  }
  return issue.lastSeen.getTime() > issue.resolvedAt.getTime();
}
