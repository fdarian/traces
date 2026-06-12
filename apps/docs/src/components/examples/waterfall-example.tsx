'use client';

import { TraceWaterfall } from '@traces/react';
import { useState } from 'react';
import { sampleTrace } from '#/fixtures/trace';

export function WaterfallExample() {
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);

  return (
    <div className="rounded border border-border-default bg-bg-subtle overflow-hidden">
      <TraceWaterfall
        trace={sampleTrace}
        selectedSpanId={selectedSpanId}
        onSelectSpan={setSelectedSpanId}
        animateBars
      />
    </div>
  );
}
