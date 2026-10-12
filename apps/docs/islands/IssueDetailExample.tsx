import { IssueDetail } from '@traces/react';
import { useState } from 'react';
import { sampleIssueDetail } from '../fixtures/issues';

const sampleOccurrences = [
  {
    id: 101,
    timestamp: Date.now() - 1000 * 60 * 5,
    exceptionMessage: 'connection refused to postgres:5432',
    traceId: 'abc123def45678901234567890abcdef',
    spanId: 'span002',
    serviceName: 'web',
  },
  {
    id: 100,
    timestamp: Date.now() - 1000 * 60 * 15,
    exceptionMessage: 'connection refused to postgres:5432',
    traceId: 'def456abc78901234567890abcdef123',
    spanId: 'span005',
    serviceName: 'web',
  },
];

export default function IssueDetailExample() {
  const [issue, setIssue] = useState(sampleIssueDetail);
  const [isResolving, setIsResolving] = useState(false);

  function handleResolve() {
    setIsResolving(true);
    setTimeout(() => {
      setIssue((prev) => ({
        ...prev,
        status: 'resolved',
        resolvedAt: Date.now(),
      }));
      setIsResolving(false);
    }, 800);
  }

  function handleUnresolve() {
    setIsResolving(true);
    setTimeout(() => {
      setIssue((prev) => ({ ...prev, status: 'unresolved', resolvedAt: null }));
      setIsResolving(false);
    }, 800);
  }

  return (
    <div className="rounded border border-border-default bg-bg-subtle p-4 overflow-hidden">
      <IssueDetail
        issue={issue}
        occurrences={sampleOccurrences}
        page={1}
        totalPages={1}
        isLoadingOccurrences={false}
        onPageChange={() => undefined}
        onResolve={handleResolve}
        onUnresolve={handleUnresolve}
        isResolving={isResolving}
        getTraceHref={(traceId, spanId) =>
          `/docs/sdk/component-reference/trace-detail-view#${traceId}?span=${spanId}`
        }
      />
    </div>
  );
}
