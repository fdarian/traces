import { TraceDetailView } from '@traces/react';
import { useState } from 'react';
import { sampleTrace } from '../fixtures/trace';

export default function TraceDetailExample() {
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);

  return (
    <div className="rounded border border-border-default bg-bg-subtle overflow-hidden">
      <TraceDetailView
        trace={sampleTrace}
        selectedSpanId={selectedSpanId}
        onSelectSpan={setSelectedSpanId}
      />
    </div>
  );
}
