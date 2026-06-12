'use client';

import { SpanDetailPanel } from '@traces/react';
import { useState } from 'react';
import { sampleTrace } from '#/fixtures/trace';

export function SpanDetailExample() {
  const [open, setOpen] = useState(true);
  const span = sampleTrace.spans[1] ?? null;

  return (
    <div className="rounded border border-border-default bg-bg-subtle overflow-hidden min-h-64">
      <SpanDetailPanel span={span} open={open} onClose={() => setOpen(false)} />
      {!open && (
        <div className="p-4">
          <button
            type="button"
            className="text-accent text-sm"
            onClick={() => setOpen(true)}
          >
            open panel
          </button>
        </div>
      )}
    </div>
  );
}
