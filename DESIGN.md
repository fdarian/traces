# DESIGN.md — `traces`

> This file is committed to the repo root at bootstrap. Every UI change must follow it.
> Inspiration: axiom.co. Identity: **a dark instrument panel, not a website.**

## 1. Principles

1. **Density is the feature.** An engineer debugging an incident wants maximum signal per
   screen. Compact rows, hairline separation, no decorative whitespace. Empty space is
   allowed only in empty states.
2. **Color is information.** The chrome is near-monochrome. Saturated color appears only
   where it encodes meaning: status (error/warn/ok), service identity (waterfall bars),
   and the active accent. If a color doesn't mean something, it doesn't exist.
3. **Mono for data, sans for labels.** Anything machine-generated — durations, counts,
   trace/span IDs, timestamps, attribute keys/values, stacktraces — renders in Geist Mono
   with `tabular-nums`. Anything human-written (nav, headings, descriptions) is Geist Sans.
   This split is the strongest visual signature of the product; never blur it.
4. **Flat depth.** Elevation comes from background lightness steps and 1px borders,
   never drop shadows. The UI reads as one continuous machined surface with etched panels.
5. **Fast, not flashy.** Motion exists to confirm causality (this click opened that panel),
   never to entertain. 120–160ms, ease-out, no springs, no bounces.

## 2. Color tokens (dark only for MVP)

Define as CSS variables on `:root`; Tailwind v4 `@theme` maps them. Base is a cold,
slightly blue near-black — graphite, not pure black.

```css
/* surfaces — lightness steps ARE the elevation system */
--bg-base:    #0B0D10;  /* app background */
--bg-subtle:  #11141A;  /* panels, table headers, side panels */
--bg-raised:  #171B22;  /* popovers, dropdowns, hover rows */
--bg-inset:   #07080A;  /* code blocks, stacktraces, waterfall track */

/* borders — hairlines, never heavier than 1px */
--border-subtle:  rgba(255,255,255,0.06);
--border-default: rgba(255,255,255,0.10);
--border-strong:  rgba(255,255,255,0.16);  /* focused/active panel edges */

/* text */
--text-primary:   #E6E9EF;
--text-secondary: #9BA3B0;
--text-tertiary:  #5C6470;  /* timestamps, hints, placeholder */

/* accent — one interactive hue, used sparingly (links, active nav, focus rings, primary buttons) */
--accent:        #4D9FFF;
--accent-subtle: rgba(77,159,255,0.12);

/* status — the semantic triad + neutral */
--status-error:  #FF5C5C;  --status-error-bg:  rgba(255,92,92,0.10);
--status-warn:   #FFB224;  --status-warn-bg:   rgba(255,178,36,0.10);
--status-ok:     #3DD68C;  --status-ok-bg:     rgba(61,214,140,0.10);
--status-neutral:#5C6470;
```

**Service colors** (waterfall bars, service badges): deterministic hash of service name →
one of 12 pre-picked hues at fixed S/L (`oklch(0.72 0.12 <hue>)` family) so the same
service is always the same color across every view and session. Never random per render.

## 3. Typography

- **Geist Sans** — UI labels, nav, headings, body. Weights 400/500/600 only.
- **Geist Mono** — all data values (see principle 3). Always `font-feature-settings: "tnum"`,
  via a `.font-data` utility.
- Scale (compact): 11px meta/labels-uppercase, 12px table cells (data), 13px body default,
  14px section headings, 18px page titles. Page titles are the *largest text in the app*.
  Uppercase 11px labels get `letter-spacing: 0.05em` and `--text-tertiary`.
- Durations get unit styling: number in `--text-primary`, unit (`ms`, `s`) in
  `--text-tertiary` — e.g. **142**ms. Build one `<Duration>` component, use it everywhere.

## 4. Spacing & density

- Base grid 4px. Table rows **32px** tall, cells `px-3`. Filter bars and toolbars 40px.
- Panels: `--bg-subtle` + `--border-subtle`, radius **6px** (cards/panels) / **4px**
  (inputs, badges). Nothing rounder — no pills except status dots.
- Page layout: fixed left nav (208px, `--bg-base`, hairline right border), sticky top bar
  (filters live here), content edge-to-edge with max-width *none* — instruments fill the
  bench.
- Tables are the dominant component: hairline row separators (`--border-subtle`), header
  row 11px uppercase tertiary, hover row `--bg-raised`, no zebra striping.

## 5. Component idioms

- **Status badge**: 4px dot + 11px uppercase label, e.g. `● ERROR` in `--status-error` on
  `--status-error-bg`. Same anatomy for ok/warn/resolved.
- **Trace waterfall** (the one loud place): time-aligned bars on `--bg-inset` track with
  faint vertical gridlines at tick intervals. Bar = service color; error span = bar
  outlined + tinted `--status-error`. Depth shown by indented name column (tree), bar
  column stays purely temporal. Selected span: `--accent` 1px outline. Minimap strip
  (~40px) on top, brush to zoom.
- **Sparklines** (issue rows, home cards): 1.5px polyline, no axes, no dots, status or
  accent color at 70% opacity, last point full opacity.
- **Stacktrace block**: `--bg-inset`, Geist Mono 12px; frame paths `--text-tertiary`,
  function names `--text-primary`, line numbers right-aligned mono; in-app frames
  full-opacity, library frames 60%.
- **Empty states**: faint 16px dot-grid background (`radial-gradient` dots at
  `--border-subtle`), one sentence in `--text-secondary`, optional accent action. No
  illustrations, no emoji.
- **Charts** (home): lines/areas only, 1.5px strokes, gradient fill to transparent at 8%
  opacity, hairline gridlines, mono axis labels at 11px.

## 6. Motion

- Durations: 120ms (hover/fade), 160ms (panel slide, popover), ease-out.
- Signature moment: waterfall bars animate `scaleX` 0→1 on trace load, 8ms stagger per
  row, transform-origin left. This is the *only* choreographed animation in the app.
- Loading: shimmer skeleton rows (gradient sweep on `--bg-subtle`), matching final row
  geometry exactly — no spinners in content areas.
- `prefers-reduced-motion`: all of the above off.

## 7. Voice

Microcopy is terse and lowercase-technical: "no traces in this range", "resolved 2h ago",
"12 occurrences · 3 services". No exclamation marks, no "Oops", no apologies.

## 8. Don'ts

- No drop shadows, no glassmorphism, no purple gradients, no pure black (#000) surfaces.
- No Inter/Roboto/system-ui — Geist only.
- No color without meaning; no per-render random colors.
- No row heights above 36px in data tables; no card grids where a table fits.
- No `'use client'` (not a thing in TanStack Start), no inline styles for themable values —
  tokens only.
