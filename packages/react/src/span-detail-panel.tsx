import { useEffect, useMemo, useState } from 'react';
import { CopyText } from './copy-text.js';
import { Duration } from './duration.js';
import { StacktraceBlock } from './stacktrace-block.js';
import { StatusBadge } from './status-badge.js';
import type { AttributeValue, Span, SpanEvent } from './types.js';
import { eventOffsetMs } from './utils/span-events.js';

type PanelTab = 'attributes' | 'events' | 'resource';

function formatAttributeValue(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

function getExceptionFields(event: SpanEvent): {
  readonly type: string;
  readonly message: string;
  readonly stacktrace: string;
} {
  let type = '';
  let message = '';
  let stacktrace = '';
  for (const attr of event.attributes) {
    if (attr.key === 'exception.type') {
      type = String(attr.value);
    }
    if (attr.key === 'exception.message') {
      message = String(attr.value);
    }
    if (attr.key === 'exception.stacktrace') {
      stacktrace = String(attr.value);
    }
  }
  return { type, message, stacktrace };
}

function KindBadge(props: { readonly kind: string }) {
  return (
    <span className="inline-flex items-center rounded bg-bg-raised px-1.5 py-0.5 text-label font-medium uppercase tracking-wide text-text-tertiary">
      {props.kind}
    </span>
  );
}

function AttributeRow(props: { readonly attribute: AttributeValue }) {
  const value = formatAttributeValue(props.attribute.value);
  return (
    <div className="flex gap-3 border-b border-border-subtle px-3 py-1.5">
      <CopyText
        value={props.attribute.key}
        className="w-2/5 shrink-0 truncate text-left font-data text-data text-text-tertiary"
      />
      <CopyText
        value={value}
        className="min-w-0 flex-1 truncate text-left font-data text-data text-text-primary"
      />
    </div>
  );
}

export function SpanDetailPanel(props: {
  readonly span: Span | null;
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const [tab, setTab] = useState<PanelTab>('attributes');
  const [attributeFilter, setAttributeFilter] = useState('');
  const [renderedSpan, setRenderedSpan] = useState<Span | null>(null);

  useEffect(() => {
    if (props.span !== null) {
      setRenderedSpan(props.span);
    }
  }, [props.span]);

  const filteredAttributes = useMemo(() => {
    if (renderedSpan === null) {
      return [];
    }
    const query = attributeFilter.trim().toLowerCase();
    if (query.length === 0) {
      return renderedSpan.attributes;
    }
    return renderedSpan.attributes.filter((attr) => {
      const key = attr.key.toLowerCase();
      const value = formatAttributeValue(attr.value).toLowerCase();
      return key.includes(query) || value.includes(query);
    });
  }, [renderedSpan, attributeFilter]);

  const sortedEvents = useMemo(() => {
    if (renderedSpan === null) {
      return [];
    }
    const events = [...renderedSpan.events];
    events.sort((a, b) => a.timestamp - b.timestamp);
    return events;
  }, [renderedSpan]);

  const span = renderedSpan;
  const status =
    span !== null && span.status.code === 'error'
      ? 'error'
      : span !== null && span.status.code === 'ok'
        ? 'ok'
        : 'neutral';

  return (
    <aside
      className="span-detail-panel flex w-96 shrink-0 flex-col border-l border-border-default bg-bg-subtle transition-transform duration-160 ease-out"
      style={{
        transform: props.open ? 'translateX(0)' : 'translateX(100%)',
      }}
      aria-hidden={!props.open}
    >
      {span !== null && (
        <>
          <div className="flex items-start justify-between gap-3 border-b border-border-default px-4 py-3">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-heading font-medium text-text-primary">
                {span.name}
              </h2>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <KindBadge kind={span.kind} />
                <StatusBadge status={status} />
                <Duration ms={span.durationMs} />
              </div>
              <div className="mt-2 font-data text-data text-text-tertiary">
                <CopyText
                  value={span.spanId}
                  className="text-text-secondary hover:text-accent"
                />
              </div>
            </div>
            <button
              type="button"
              onClick={props.onClose}
              className="shrink-0 text-body text-text-tertiary transition-colors duration-120 hover:text-text-primary"
            >
              esc
            </button>
          </div>

          <div className="flex border-b border-border-default">
            {(['attributes', 'events', 'resource'] as const).map((panelTab) => (
              <button
                key={panelTab}
                type="button"
                onClick={() => setTab(panelTab)}
                className={`flex-1 px-3 py-2 text-label uppercase tracking-wide transition-colors duration-120 ${
                  tab === panelTab
                    ? 'border-b border-accent text-accent'
                    : 'text-text-tertiary hover:text-text-secondary'
                }`}
              >
                {panelTab}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {tab === 'attributes' && (
              <div>
                <div className="border-b border-border-subtle px-3 py-2">
                  <input
                    type="text"
                    value={attributeFilter}
                    onChange={(event) => setAttributeFilter(event.target.value)}
                    placeholder="filter attributes"
                    className="w-full rounded border border-border-default bg-bg-inset px-2 py-1 font-data text-data text-text-primary placeholder:text-text-tertiary"
                  />
                </div>
                {filteredAttributes.length === 0 ? (
                  <p className="px-4 py-6 text-body text-text-secondary">
                    no attributes
                  </p>
                ) : (
                  filteredAttributes.map((attr) => (
                    <AttributeRow key={attr.key} attribute={attr} />
                  ))
                )}
              </div>
            )}

            {tab === 'events' && (
              <div className="flex flex-col gap-3 p-3">
                {sortedEvents.length === 0 ? (
                  <p className="text-body text-text-secondary">no events</p>
                ) : (
                  sortedEvents.map((event, index) => {
                    const offsetMs = eventOffsetMs(event, span);
                    if (event.name === 'exception') {
                      const fields = getExceptionFields(event);
                      return (
                        <div key={`${event.name}-${event.timestamp}-${index}`}>
                          <div className="mb-1 font-data text-data text-text-tertiary">
                            <Duration ms={offsetMs} />
                          </div>
                          <StacktraceBlock
                            type={fields.type}
                            message={fields.message}
                            stacktrace={fields.stacktrace}
                          />
                        </div>
                      );
                    }

                    return (
                      <div
                        key={`${event.name}-${event.timestamp}-${index}`}
                        className="rounded border border-border-subtle bg-bg-inset p-3"
                      >
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <span className="text-body text-text-primary">
                            {event.name}
                          </span>
                          <span className="font-data text-data text-text-tertiary">
                            <Duration ms={offsetMs} />
                          </span>
                        </div>
                        {event.attributes.map((attr) => (
                          <AttributeRow key={attr.key} attribute={attr} />
                        ))}
                      </div>
                    );
                  })
                )}
              </div>
            )}

            {tab === 'resource' && (
              <div>
                <div className="border-b border-border-subtle px-3 py-2 text-body text-text-primary">
                  service: {span.resource.serviceName}
                </div>
                {span.resource.attributes.length === 0 ? (
                  <p className="px-4 py-6 text-body text-text-secondary">
                    no resource attributes
                  </p>
                ) : (
                  span.resource.attributes.map((attr) => (
                    <AttributeRow key={attr.key} attribute={attr} />
                  ))
                )}
              </div>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
