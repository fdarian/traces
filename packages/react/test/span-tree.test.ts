import { describe, expect, test } from 'bun:test';
import type { Span } from '@traces/core';
import {
  buildSpanTree,
  collectAncestorSpanIds,
  collectDefaultCollapsed,
  expandCollapsedAncestors,
  flattenSpanTree,
  ORPHAN_ROOT_ID,
  spanStartMs,
} from '../src/utils/span-tree.js';

function makeSpan(overrides: {
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly startNano: string;
  readonly endNano: string;
  readonly serviceName?: string;
}): Span {
  return {
    traceId: 'trace-1',
    spanId: overrides.spanId,
    parentSpanId: overrides.parentSpanId,
    name: overrides.name,
    kind: 'internal',
    startTimeUnixNano: overrides.startNano,
    endTimeUnixNano: overrides.endNano,
    durationMs: 100,
    status: { code: 'ok' },
    attributes: [],
    events: [],
    resource: {
      serviceName: overrides.serviceName ?? 'api',
      attributes: [],
    },
  };
}

describe('spanStartMs', () => {
  test('converts nanoseconds to milliseconds', () => {
    const span = makeSpan({
      spanId: 'a',
      name: 'a',
      startNano: '1700000000000000000',
      endNano: '1700000000100000000',
    });
    expect(spanStartMs(span)).toBe(1700000000000);
  });
});

describe('buildSpanTree', () => {
  test('builds parent-child hierarchy sorted by start time', () => {
    const spans = [
      makeSpan({
        spanId: 'root',
        name: 'root',
        startNano: '1000000000',
        endNano: '5000000000',
      }),
      makeSpan({
        spanId: 'child-b',
        parentSpanId: 'root',
        name: 'child-b',
        startNano: '3000000000',
        endNano: '4000000000',
      }),
      makeSpan({
        spanId: 'child-a',
        parentSpanId: 'root',
        name: 'child-a',
        startNano: '2000000000',
        endNano: '3500000000',
      }),
    ];

    const tree = buildSpanTree(spans);
    expect(tree.length).toBe(1);
    expect(tree[0].spanId).toBe('root');
    expect(tree[0].children.length).toBe(2);
    expect(tree[0].children[0].spanId).toBe('child-a');
    expect(tree[0].children[1].spanId).toBe('child-b');
    expect(tree[0].descendantCount).toBe(2);
  });

  test('groups orphan spans under synthetic root', () => {
    const spans = [
      makeSpan({
        spanId: 'root',
        name: 'root',
        startNano: '1000000000',
        endNano: '5000000000',
      }),
      makeSpan({
        spanId: 'orphan',
        parentSpanId: 'missing-parent',
        name: 'orphan',
        startNano: '2000000000',
        endNano: '3000000000',
      }),
    ];

    const tree = buildSpanTree(spans);
    expect(tree.length).toBe(2);
    expect(tree[0].spanId).toBe('root');
    expect(tree[1].spanId).toBe(ORPHAN_ROOT_ID);
    expect(tree[1].isOrphanRoot).toBe(true);
    expect(tree[1].children.length).toBe(1);
    expect(tree[1].children[0].spanId).toBe('orphan');
    expect(tree[1].children[0].depth).toBe(1);
  });

  test('groups self-parent spans under synthetic orphan root', () => {
    const spans = [
      makeSpan({
        spanId: 'self',
        parentSpanId: 'self',
        name: 'self-parent',
        startNano: '1000000000',
        endNano: '2000000000',
      }),
    ];

    const tree = buildSpanTree(spans);
    expect(tree.length).toBe(1);
    expect(tree[0].spanId).toBe(ORPHAN_ROOT_ID);
    expect(tree[0].children.length).toBe(1);
    expect(tree[0].children[0].spanId).toBe('self');
  });

  test('groups cyclic traces under synthetic orphan root without recursing infinitely', () => {
    const spans = [
      makeSpan({
        spanId: 'a',
        parentSpanId: 'b',
        name: 'a',
        startNano: '1000000000',
        endNano: '2000000000',
      }),
      makeSpan({
        spanId: 'b',
        parentSpanId: 'a',
        name: 'b',
        startNano: '1500000000',
        endNano: '2500000000',
      }),
    ];

    const tree = buildSpanTree(spans);
    expect(tree.length).toBe(1);
    expect(tree[0].spanId).toBe(ORPHAN_ROOT_ID);
    expect(tree[0].children.length).toBe(2);
    expect(tree[0].children.map((child) => child.spanId).sort()).toEqual([
      'a',
      'b',
    ]);
  });

  test('computes depth for nested spans', () => {
    const spans = [
      makeSpan({
        spanId: 'root',
        name: 'root',
        startNano: '1000000000',
        endNano: '9000000000',
      }),
      makeSpan({
        spanId: 'mid',
        parentSpanId: 'root',
        name: 'mid',
        startNano: '2000000000',
        endNano: '8000000000',
      }),
      makeSpan({
        spanId: 'leaf',
        parentSpanId: 'mid',
        name: 'leaf',
        startNano: '3000000000',
        endNano: '4000000000',
      }),
    ];

    const tree = buildSpanTree(spans);
    expect(tree[0].depth).toBe(0);
    expect(tree[0].children[0].depth).toBe(1);
    expect(tree[0].children[0].children[0].depth).toBe(2);
  });
});

describe('flattenSpanTree', () => {
  test('flattens visible rows respecting collapse state', () => {
    const spans = [
      makeSpan({
        spanId: 'root',
        name: 'root',
        startNano: '1000000000',
        endNano: '5000000000',
      }),
      makeSpan({
        spanId: 'child',
        parentSpanId: 'root',
        name: 'child',
        startNano: '2000000000',
        endNano: '3000000000',
      }),
    ];
    const tree = buildSpanTree(spans);
    const collapsed = new Set<string>(['root']);
    const rows = flattenSpanTree(tree, collapsed);

    expect(rows.length).toBe(1);
    expect(rows[0].spanId).toBe('root');
    expect(rows[0].hasChildren).toBe(true);
  });

  test('includes all descendants when expanded', () => {
    const spans = [
      makeSpan({
        spanId: 'root',
        name: 'root',
        startNano: '1000000000',
        endNano: '5000000000',
      }),
      makeSpan({
        spanId: 'child',
        parentSpanId: 'root',
        name: 'child',
        startNano: '2000000000',
        endNano: '3000000000',
      }),
    ];
    const tree = buildSpanTree(spans);
    const rows = flattenSpanTree(tree, new Set());

    expect(rows.length).toBe(2);
    expect(rows[1].spanId).toBe('child');
    expect(rows[1].depth).toBe(1);
  });
});

describe('deep-link ancestor expansion', () => {
  test('reveals target span hidden under collapsed ancestors', () => {
    const spans = [
      makeSpan({
        spanId: 'root',
        name: 'root',
        startNano: '1000000000',
        endNano: '9000000000',
      }),
      makeSpan({
        spanId: 'child',
        parentSpanId: 'root',
        name: 'child',
        startNano: '2000000000',
        endNano: '8000000000',
      }),
      makeSpan({
        spanId: 'target',
        parentSpanId: 'child',
        name: 'target',
        startNano: '3000000000',
        endNano: '4000000000',
      }),
    ];
    const tree = buildSpanTree(spans);
    const collapsed = new Set(['root', 'child']);
    const ancestors = collectAncestorSpanIds('target', spans);
    const expanded = expandCollapsedAncestors(collapsed, ancestors);
    const rows = flattenSpanTree(tree, expanded);

    expect(ancestors).toEqual(['child', 'root']);
    expect(rows.some((row) => row.spanId === 'target')).toBe(true);
  });
});

describe('collectDefaultCollapsed', () => {
  test('returns empty set when below threshold', () => {
    const spans = [
      makeSpan({
        spanId: 'root',
        name: 'root',
        startNano: '1000000000',
        endNano: '5000000000',
      }),
    ];
    const tree = buildSpanTree(spans);
    const collapsed = collectDefaultCollapsed(tree, spans.length, 500);
    expect(collapsed.size).toBe(0);
  });

  test('collapses all branches when above threshold', () => {
    const spans = [
      makeSpan({
        spanId: 'root',
        name: 'root',
        startNano: '1000000000',
        endNano: '5000000000',
      }),
      makeSpan({
        spanId: 'child',
        parentSpanId: 'root',
        name: 'child',
        startNano: '2000000000',
        endNano: '3000000000',
      }),
    ];
    const tree = buildSpanTree(spans);
    const collapsed = collectDefaultCollapsed(tree, 501, 500);
    expect(collapsed.has('root')).toBe(true);
  });
});
