---
"@traces/core": patch
---

Accept Jaeger v3 trace summaries that omit proto3 default fields, such as traces without a root span, instead of failing the whole page.
