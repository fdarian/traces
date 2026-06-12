import type { Span } from '@traces/core';
import { normalizeTimestampToMs } from '@traces/core';

export const ORPHAN_ROOT_ID = '__orphaned__';

export interface SpanTreeNode {
  readonly spanId: string;
  readonly span: Span | null;
  readonly children: ReadonlyArray<SpanTreeNode>;
  readonly depth: number;
  readonly descendantCount: number;
  readonly isOrphanRoot: boolean;
}

export interface FlatSpanRow {
  readonly spanId: string;
  readonly span: Span | null;
  readonly depth: number;
  readonly hasChildren: boolean;
  readonly descendantCount: number;
  readonly isOrphanRoot: boolean;
  readonly node: SpanTreeNode;
}

export function spanStartMs(span: Span): number {
  return normalizeTimestampToMs(span.startTimeUnixNano);
}

function sortSpansByStart(spans: Array<Span>): void {
  spans.sort((a, b) => spanStartMs(a) - spanStartMs(b));
}

export function buildSpanTree(
  spans: ReadonlyArray<Span>,
): ReadonlyArray<SpanTreeNode> {
  const spanMap = new Map<string, Span>();
  for (const span of spans) {
    spanMap.set(span.spanId, span);
  }

  const childrenMap = new Map<string, Array<Span>>();
  const roots: Array<Span> = [];
  const orphans: Array<Span> = [];

  for (const span of spans) {
    const parentId = span.parentSpanId;
    if (parentId === undefined) {
      roots.push(span);
    } else if (!spanMap.has(parentId)) {
      orphans.push(span);
    } else {
      const existing = childrenMap.get(parentId);
      if (existing === undefined) {
        childrenMap.set(parentId, [span]);
      } else {
        existing.push(span);
      }
    }
  }

  sortSpansByStart(roots);
  sortSpansByStart(orphans);
  for (const children of childrenMap.values()) {
    sortSpansByStart(children);
  }

  const buildNode = (span: Span, depth: number): SpanTreeNode => {
    const children = childrenMap.get(span.spanId) ?? [];
    const childNodes = children.map((child) => buildNode(child, depth + 1));
    let descendantCount = 0;
    for (const child of childNodes) {
      descendantCount += 1 + child.descendantCount;
    }
    return {
      spanId: span.spanId,
      span,
      children: childNodes,
      depth,
      descendantCount,
      isOrphanRoot: false,
    };
  };

  const result: Array<SpanTreeNode> = [];
  for (const root of roots) {
    result.push(buildNode(root, 0));
  }

  if (orphans.length > 0) {
    const orphanChildren = orphans.map((orphan) => buildNode(orphan, 1));
    let descendantCount = 0;
    for (const child of orphanChildren) {
      descendantCount += 1 + child.descendantCount;
    }
    result.push({
      spanId: ORPHAN_ROOT_ID,
      span: null,
      children: orphanChildren,
      depth: 0,
      descendantCount,
      isOrphanRoot: true,
    });
  }

  result.sort((a, b) => {
    if (a.isOrphanRoot) return 1;
    if (b.isOrphanRoot) return -1;
    const aSpan = a.span;
    const bSpan = b.span;
    const aStart = aSpan !== null ? spanStartMs(aSpan) : 0;
    const bStart = bSpan !== null ? spanStartMs(bSpan) : 0;
    return aStart - bStart;
  });

  return result;
}

export function flattenSpanTree(
  roots: ReadonlyArray<SpanTreeNode>,
  collapsed: ReadonlySet<string>,
): ReadonlyArray<FlatSpanRow> {
  const result: Array<FlatSpanRow> = [];

  const visit = (node: SpanTreeNode) => {
    const hasChildren = node.children.length > 0;
    result.push({
      spanId: node.spanId,
      span: node.span,
      depth: node.depth,
      hasChildren,
      descendantCount: node.descendantCount,
      isOrphanRoot: node.isOrphanRoot,
      node,
    });
    if (hasChildren && !collapsed.has(node.spanId)) {
      for (const child of node.children) {
        visit(child);
      }
    }
  };

  for (const root of roots) {
    visit(root);
  }

  return result;
}

export function collectDefaultCollapsed(
  roots: ReadonlyArray<SpanTreeNode>,
  spanCount: number,
  threshold: number,
): ReadonlySet<string> {
  const collapsed = new Set<string>();
  if (spanCount <= threshold) {
    return collapsed;
  }

  const visit = (node: SpanTreeNode) => {
    if (node.children.length > 0) {
      collapsed.add(node.spanId);
      for (const child of node.children) {
        visit(child);
      }
    }
  };

  for (const root of roots) {
    visit(root);
  }

  return collapsed;
}