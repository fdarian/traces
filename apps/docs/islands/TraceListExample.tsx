import { TraceListTable } from '@traces/react';
import { useState } from 'react';
import { sampleTraceSummaries } from '../fixtures/trace-summaries';

export default function TraceListExample() {
  const [sort, setSort] = useState<'start' | 'duration'>('start');

  return (
    <div className="rounded border border-border-default bg-bg-subtle overflow-hidden">
      <TraceListTable
        traces={sampleTraceSummaries}
        sort={sort}
        onSortChange={setSort}
        isLoading={false}
        hasMore={false}
        onLoadMore={() => undefined}
        error={null}
        getTraceHref={(traceId) =>
          `/docs/sdk/component-reference/trace-detail-view#${traceId}`
        }
      />
    </div>
  );
}
