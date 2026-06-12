import type { Span } from '@traces/core';
import { normalizeTimestampToMs } from './time.js';

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

function removeFromChildrenMap(
  childrenMap: Map<string, Array<Span>>,
  spanId: string,
): void {
  for (const [parentId, children] of childrenMap.entries()) {
    const filtered = children.filter((child) => child.spanId !== spanId);
    if (filtered.length !== children.length) {
      if (filtered.length === 0) {
        childrenMap.delete(parentId);
      } else {
        childrenMap.set(parentId, filtered);
      }
    }
  }
}

export function collectAncestorSpanIds(
  spanId: string,
  spans: ReadonlyArray<Span>,
): ReadonlyArray<string> {
  const parentByChild = new Map<string, string>();
  for (const span of spans) {
    if (span.parentSpanId !== undefined && span.parentSpanId !== span.spanId) {
      parentByChild.set(span.spanId, span.parentSpanId);
    }
  }

  const ancestors: Array<string> = [];
  const visited = new Set<string>();
  let parentId = parentByChild.get(spanId);
  while (parentId !== undefined) {
    if (visited.has(parentId)) {
      break;
    }
    visited.add(parentId);
    ancestors.push(parentId);
    parentId = parentByChild.get(parentId);
  }

  return ancestors;
}

export function expandCollapsedAncestors(
  collapsed: ReadonlySet<string>,
  ancestorIds: ReadonlyArray<string>,
): ReadonlySet<string> {
  if (ancestorIds.length === 0) {
    return collapsed;
  }

  const next = new Set(collapsed);
  for (const ancestorId of ancestorIds) {
    next.delete(ancestorId);
  }
  return next;
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
  const orphanIds = new Set<string>();

  const addOrphan = (span: Span) => {
    if (!orphanIds.has(span.spanId)) {
      orphanIds.add(span.spanId);
      orphans.push(span);
    }
  };

  for (const span of spans) {
    const parentId = span.parentSpanId;
    if (parentId === span.spanId) {
      addOrphan(span);
      continue;
    }
    if (parentId === undefined) {
      roots.push(span);
    } else if (!spanMap.has(parentId)) {
      addOrphan(span);
    } else {
      const existing = childrenMap.get(parentId);
      if (existing === undefined) {
        childrenMap.set(parentId, [span]);
      } else {
        existing.push(span);
      }
    }
  }

  const reachable = new Set<string>();
  const visitReachable = (currentSpanId: string, visiting: Set<string>) => {
    if (visiting.has(currentSpanId)) {
      return;
    }
    if (reachable.has(currentSpanId)) {
      return;
    }
    visiting.add(currentSpanId);
    reachable.add(currentSpanId);
    const children = childrenMap.get(currentSpanId) ?? [];
    for (const child of children) {
      visitReachable(child.spanId, visiting);
    }
    visiting.delete(currentSpanId);
  };

  for (const root of roots) {
    visitReachable(root.spanId, new Set());
  }

  for (const span of spans) {
    if (!reachable.has(span.spanId) && !orphanIds.has(span.spanId)) {
      addOrphan(span);
      removeFromChildrenMap(childrenMap, span.spanId);
    }
  }

  sortSpansByStart(roots);
  sortSpansByStart(orphans);
  for (const children of childrenMap.values()) {
    sortSpansByStart(children);
  }

  const buildNode = (
    span: Span,
    depth: number,
    visiting: Set<string>,
  ): SpanTreeNode => {
    if (visiting.has(span.spanId)) {
      return {
        spanId: span.spanId,
        span,
        children: [],
        depth,
        descendantCount: 0,
        isOrphanRoot: false,
      };
    }

    visiting.add(span.spanId);
    const children = childrenMap.get(span.spanId) ?? [];
    const childNodes = children.map((child) =>
      buildNode(child, depth + 1, visiting),
    );
    visiting.delete(span.spanId);

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
    result.push(buildNode(root, 0, new Set()));
  }

  if (orphans.length > 0) {
    const orphanChildren = orphans.map((orphan) =>
      buildNode(orphan, 1, new Set()),
    );
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
