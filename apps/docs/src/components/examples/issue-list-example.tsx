'use client';

import { IssueListTable } from '@traces/react';
import { useState } from 'react';
import { sampleIssueRows } from '#/fixtures/issues';

export function IssueListExample() {
  const [resolvingId, setResolvingId] = useState<number | null>(null);

  function handleResolve(id: number) {
    setResolvingId(id);
    setTimeout(() => setResolvingId(null), 1000);
  }

  return (
    <div className="rounded border border-border-default bg-bg-subtle overflow-hidden">
      <IssueListTable
        issues={sampleIssueRows}
        isLoading={false}
        error={null}
        getIssueHref={(id) =>
          `/docs/sdk/component-reference/issue-detail#${id}`
        }
        onResolve={handleResolve}
        resolvingIssueId={resolvingId}
      />
    </div>
  );
}
