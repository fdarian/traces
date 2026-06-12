import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import {
  CopyText,
  Duration,
  EmptyState,
  IssueDetailExample,
  IssueListExample,
  ServiceBadge,
  SkeletonRow,
  SpanDetailExample,
  Sparkline,
  StacktraceBlock,
  StatusBadge,
  TraceDetailExample,
  TraceListExample,
  WaterfallExample,
} from './examples/sdk-client';

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    // SDK primitive components
    CopyText,
    Duration,
    EmptyState,
    ServiceBadge,
    SkeletonRow,
    Sparkline,
    StacktraceBlock,
    StatusBadge,
    // live example wrappers
    WaterfallExample,
    TraceDetailExample,
    TraceListExample,
    SpanDetailExample,
    IssueListExample,
    IssueDetailExample,
    ...components,
  };
}

export function useMDXComponents(components?: MDXComponents): MDXComponents {
  return getMDXComponents(components);
}
