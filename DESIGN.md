# Design

The visual system for awesomeprojects.tech: the website (brand), My domains and the admin dashboard (product). Strategy lives in [PRODUCT.md](PRODUCT.md).

## Overview

**Scene:** a developer at a dark desk in the evening, editor open, claiming a name for the thing they just shipped, quick and sure. So the site is **near-black, pure neutral** (no tint), set in precise type, with **one hot signal color** that only appears where something is live, yours, or wants a click.

**The idea: the dot.** Every name on the internet ends in a dot (the root). Ours is orange. The dot is the mark, the cursor, the "live" light and the accent, all at once.

Reference lane: Vercel's pure-black monochrome and Linear's control of type, with a playful hacker underneath: real DNS records, `whois` that answers, keyboard shortcuts everywhere. **Not** a terminal costume (no green-on-black, no fake glitching).

## Color

Restrained strategy: pure neutrals plus one signal color at ≤10% of any surface, except deliberate moments (the dot, a primary button, a live indicator). OKLCH throughout. Dark only, on purpose (see the scene).

| Token | Value | Use |
|---|---|---|
| `--bg` | `oklch(0.115 0 0)` | page |
| `--bg-raise` | `oklch(0.155 0 0)` | panels, inputs, rows on hover |
| `--bg-high` | `oklch(0.195 0 0)` | popovers, the command palette |
| `--line` | `oklch(0.27 0 0)` | hairlines, table rules |
| `--line-strong` | `oklch(0.37 0 0)` | input borders, focus-adjacent |
| `--ink` | `oklch(0.965 0 0)` | text, headings |
| `--ink-2` | `oklch(0.78 0 0)` | secondary text (≈11:1 on bg) |
| `--ink-3` | `oklch(0.64 0 0)` | labels, metadata (≈6.5:1 on bg) |
| `--signal` | `oklch(0.72 0.19 41)` | the dot, primary actions, live, focus ring |
| `--signal-ink` | `oklch(0.17 0.05 41)` | text on signal |
| `--signal-wash` | `oklch(0.72 0.19 41 / 0.13)` | selected rows, highlighted record |
| `--ok` | `oklch(0.80 0.15 155)` | available, deployed, success |
| `--warn` | `oklch(0.84 0.14 85)` | held, pending, overdue soon |
| `--bad` | `oklch(0.70 0.19 355)` | taken, failed, refused (a magenta-red, distinct from the orange) |
| `--info` | `oklch(0.79 0.10 240)` | links in data, neutral notices |

Status never relies on color alone: it always has a word or a glyph (✓ ● ▲ ✕).

## Typography

Three families, each with one job:

- **Funnel Display** (600–800): headings and the big name in the hero. Tracking −0.02em at display sizes, never tighter than −0.035em.
- **Funnel Sans** (400–600): everything you read and click.
- **Martian Mono** (400–500): only literal DNS data: names, records, commands, ids. It's honest here, because these really are machine strings. Never for prose or labels.

Scale (≈1.28 steps, rem): 0.75 · 0.8125 · 0.9375 (body small) · 1.0625 (body) · 1.3125 · 1.6875 · 2.125 · 2.75 · 3.5 · clamp(2.75rem, 7vw, 5.25rem) (hero). Body line-height 1.6 (on dark), headings 1.05–1.15. Measure ≤ 68ch. `text-wrap: balance` on h1–h3, `pretty` on prose.

## Space, shape, depth

- Spacing scale (px): 4 · 8 · 12 · 16 · 24 · 32 · 48 · 72 · 112. Sections breathe (72–112), groups stay tight (8–16).
- Radius: 6px (controls), 10px (panels), 999px (pills, the dot). Never mixed on one element.
- Depth is mostly lines, not shadows. One shadow for floating layers: `0 12px 40px oklch(0 0 0 / 0.55), 0 0 0 1px var(--line)`.
- z-index scale: `--z-sticky 10` · `--z-dropdown 20` · `--z-overlay 30` · `--z-modal 40` · `--z-toast 50` · `--z-tooltip 60`.

## The mark

- **Mark:** a signal-orange disc (the dot) with a caret notch, like the cursor at the end of a name you're typing. It's `brand/mark.svg`.
- **Wordmark:** `awesomeprojects` in Funnel Display 700 in ink, then the orange dot, then `tech` in `--ink-3`. On small screens the mark stands alone.
- **Favicon:** the mark on transparent.

## Motion

Quiet and exact, with ease-out-quint (`cubic-bezier(0.22, 1, 0.36, 1)`), 160–320ms.

- **Signature:** the caret in the hero name field blinks in signal orange, and the answer line under it resolves character by character (a ~240ms "lookup" shimmer) when the verdict changes.
- **Live indicators:** a slow 2.4s pulse on the dot.
- Everything else is hover/focus feedback.
- `prefers-reduced-motion`: no blink, no shimmer, no pulse. Instant state changes.

## Components

- **Address field:** one big line, `[name] .awesomeprojects.tech`. The name is editable in Martian Mono at display size, and the suffix sits in `--ink-3`.
- **Answer line:** a verdict with a glyph and plain words, e.g. `✓ free — claim it`, `✕ taken by @alice → alice.github.io`. Literals are in mono, words in Funnel Sans.
- **Record table:** columns name / type / value / note. Mono for the first three, sans for the note, and hairline rules with no zebra striping.
- **Buttons:** primary is signal fill with signal-ink text. Secondary is a line border with ink text. Quiet is text only. Height is 36px (product) or 44px (brand CTAs).
- **Inputs:** `--bg-raise`, a 1px `--line-strong` border, and a 2px signal outline + 2px offset on focus.
- **Pills:** status with a glyph, tinted 12% of the status color with the full-strength color as text.
- **Command palette (⌘K):** a centered `--bg-high` panel with a fuzzy list, each item showing its shortcut, and capability-gated actions marked as "needs a cosign" or hidden.

## Voice

Short, plain, second person. One wink per screen at most. "Free names for the things you build." "Taken by @alice." "Nobody's on duty. Elevations need a lead." No exclamation marks in UI chrome, no "Oops!", no hype words (seamless, powerful, unleash).
