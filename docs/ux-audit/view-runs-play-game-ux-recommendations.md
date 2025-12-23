# WikiRacing Arena UX + Visual Design Recommendations

Date: **2025-12-21**

Scope: **"View Runs"** + **"Play Game"** pages (including race setup + arena).

This document is based on the Playwright screenshots under `docs/ux-audit/screenshots/` and `ui-review/screens/`, plus a quick read of the React components that render these pages (notably `src/components/viewer-tab.tsx`, `src/components/play-tab.tsx`, `src/components/race/race-setup.tsx`, `src/components/matchup-arena.tsx`, `src/components/force-directed-graph.tsx`).

---

## Executive Summary (High Impact)

If you only do 8 things:

1. **Adopt a real brand accent color** (current `--primary` is basically black) and define a **semantic status palette** (running/waiting/win/fail/near-miss).
2. Add **motion & feedback**: subtle transitions for tab changes, selection, list updates, step completion, and win moments (with a global “Reduce motion” escape hatch).
3. Make the **Viewer graph readable** by default: “overview first” + strong focus mode + legend + on-hover details; reduce the “hairball” effect.
4. Upgrade **information hierarchy** on View Runs: compress the header controls, add quick filters/sorts, and provide a clear “selected run details” panel.
5. Improve the Play Game **arena command center** feel: clearer “what do I do now?” guidance, better highlighting of active run/player, and more intentional spacing.
6. Make **setup → arena** feel like a cohesive flow: stepper completion states, smooth scroll + anchor highlights, and “setup collapses to a summary” after start.
7. Strengthen **empty / error / no-data** states (no server, no runs, no wins) with friendly guidance and next actions.
8. Add **progress & replay affordances** across the app (especially for human turns and LLM step playback).

### Success criteria (what “better” looks like)

- A first-time user can start a race in **< 30 seconds** without reading the About page.
- During a race, it’s always obvious:
  - who is currently active (human hotseat)
  - what the next action is (“Start turn”, “Pick a link”, “Waiting for model”)
- On View Runs, a user can answer these questions quickly:
  - “How good is this model?”
  - “What’s a representative run?”
  - “What did it do, step-by-step?”
- The UI feels more “arena/game” than “internal tool” while staying clean.

---

## Guiding Principles (Best-Practice Anchors)

These principles are repeatedly useful for this UI because it mixes **gameplay**, **leaderboards**, and **visual analytics**.

- **Overview first, zoom and filter, then details-on-demand** (classic information visualization mantra).
- **Clear primary action** per screen (setup: start race; arena: take turn / view results; viewer: explore/select runs).
- **Use color for meaning, not decoration**: reserve saturated color for “state” and “focus”.
- **Reduce cognitive load** with progressive disclosure (keep advanced controls discoverable but not dominant).
- **Motion is for continuity** (helping users understand what changed), not for novelty.

References/inspiration reading:

- Shneiderman’s mantra (info vis): https://www.cs.umd.edu/~ben/shneiderman/
- UW info-vis design patterns: https://courses.cs.washington.edu/courses/cse512/14wi/
- Material Design – motion (use with restraint): https://m1.material.io/motion/
- Apple HIG – reduce motion (accessibility): https://developer.apple.com/design/human-interface-guidelines/

Leaderboards + gamification references:

- Interaction Design Foundation (leaderboard UX patterns): https://www.interaction-design.org/literature/article/boost-user-engagement-with-leaderboards-a-ux-design-guide

Comparable product patterns worth borrowing from:

- **Chess analysis UIs** (Lichess / Chess.com): move list + analysis + replay scrubbing
- **Competition leaderboards** (Kaggle): filter/sort + at-a-glance performance + drill-down
- **AI arena comparisons** (Chatbot Arena): simple controls, strong focus on “who won / why”
- **Network exploration tools** (Observable / Gephi-like affordances): hover details, legends, filtering, focus mode

Direct “same genre” inspiration:

- The Wiki Game (classic): https://www.thewikigame.com/
- The Wiki Game Daily (daily challenge framing): https://www.thewikigamedaily.com/
- Chatbot Arena / LLM Arena (simple, comparison-first): https://lmarena.ai/

Pattern borrowing (what to steal, specifically):

- Chess analysis tools:
  - **Move list as a timeline** (your run steps)
  - **Scrubbable replay** that updates both board + notation (your wiki preview + map)
  - **Color and glyphs for evaluation** (your win/near-miss/fail + hop efficiency)
- Kaggle-style leaderboards:
  - **Sticky filters + sorting**
  - **Highlight “your entry”**
  - **At-a-glance metrics** with drill-down details
- “Arena” comparison UIs:
  - Keep the top-level decision simple (“who won?”, “why?”)
  - Make comparison a first-class mode (multi-select, compare overlays)

---

## What’s Working Well Already

### View Runs

- Strong foundation: dataset selection, computed stats, run list + visualization split.
- Helpful “Wins only” toggle and “Best run / Longest run” quick jump.
- Autoplay is a nice touch for passive exploration.

### Play Game

- Race setup has good structure: stepper, pages + participants, “Advanced” is behind a dialog.
- Arena layout is functional and information-dense (leaderboard, wiki view, links pane, run details, map).
- “Activity” feed is a great idea: it makes multi-run races feel alive.

---

## Key UX Issues Observed

### 1) Visual “flatness” and weak hierarchy

Most of the UI is grayscale with low contrast between surfaces. This makes:

- Primary actions less obvious (many controls look equal)
- Status signals easy to miss (running vs waiting vs win)
- Dense areas (arena + graph) feel more overwhelming than necessary

### 2) “Viewer hairball” problem

The force graph is impressive but often too dense. Without strong focus and legend, it reads as “cool but unclear.”

### 3) High cognitive load in Arena

The arena is a “control room.” That’s fine, but it needs stronger “what do I do now” guidance and clearer active context:

- Which run is active? which player is active? what action should I take?
- When AI runs update, what changed?

### 4) Interactions don’t always communicate state changes

There are some pulses (e.g. recently changed runs), but selection and transitions could do more to help users keep context.

---

## Recommendations: Global (Applies to Both Pages)

### A) Introduce a brand + semantic color system (High impact, low/med effort)

**Goal:** make the app feel modern and “game-like” while keeping it clean.

1) Pick a brand accent (example directions):

- **Electric blue** (fast, techy)
- **Violet** (playful, “arena” vibe)
- **Teal** (calm, analytical)

2) Define semantic tokens used everywhere:

- `status.running` → blue
- `status.waiting` → slate
- `status.win` → green
- `status.fail/abandoned` → red/neutral
- `status.nearMiss` → amber
- `focus.selected` → brand accent

Implementation notes (how it maps to this repo):

- You’re using shadcn + Tailwind CSS variables; updating `--primary` and adding a few CSS variables (or Tailwind theme extensions) will “unlock” color across buttons, selections, badges.
- Ensure contrast meets WCAG AA on light backgrounds.

Extra polish:

- Use a **consistent “run color identity”** across the whole app (map line color, leaderboard stripe, path chips). This is especially valuable when there are many simultaneous runs.
- Make sure the palette is **color-blind safe** (don’t rely on red/green alone; combine color + icon + label).

### B) Use motion for continuity (High impact, low effort)

Add small transitions that reinforce mental models:

- Tab transitions: fade/slide content in (100–180ms)
- Selection: run cards + leaderboard rows “lift” with shadow and a short scale
- Stepper: checkmark + “completed” fill
- Graph focus: animate opacity shift when selecting a run
- Arena: animate layout collapses/expands + pane toggles

Guardrails:

- Respect `prefers-reduced-motion` (disable non-essential motion)
- Avoid long easing; keep it snappy and consistent

Recommended approach in this repo:

- Prefer Tailwind transitions + `tw-animate-css` utilities that are already present.
- Introduce a small set of reusable motion classes (e.g. `transition-base`, `transition-emphasis`).

### C) Typography + spacing tuning (Med impact, low effort)

- Slightly increase heading weight/contrast for section titles (“Runs”, “Visualization”, “Leaderboard”).
- Tighten repeated control rows (chips/badges) to reduce vertical bloat.
- Ensure consistent 8px/12px rhythm for gaps and padding.

### D) Add lightweight “onboarding scaffolding” (Med impact, low effort)

- Add one-line tips where users get stuck:
  - Viewer: “Select a run to highlight; use filter + autoplay”
  - Arena: “Human: click links or use Links pane; AI runs update automatically”
- Convert tips to dismissible callouts so the UI stays clean over time.

---

## Navigation & layout (Global)

### 1) Make the top navigation feel like a “product” header (Med/high impact, low effort)

The current title + tabs are clear, but you can increase perceived quality with small changes:

- Add a tiny brand mark/icon next to “WikiRacing Arena” (even a simple link-node glyph).
- Convert the tab bar to a more modern segmented control style with a clear active indicator.
- Add a theme toggle (light/dark) and keep it near GitHub.
- Consider making the header sticky once users scroll into the arena.

### 2) Establish a consistent “primary CTA” style (Med impact, low effort)

Right now the primary button reads as “black = primary.” Once you introduce a brand accent, ensure:

- Only one primary button per region (setup vs arena vs viewer)
- Destructive actions (“Delete”, “Give up”) never compete visually with primary actions

---

## Recommendations: View Runs Page

Primary user goals:

1) Pick a dataset/model
2) Understand how well it performs
3) Explore/compare specific runs
4) Learn patterns (“why does this model succeed/fail?”)

### 1) Make the header “scan-first” (High impact, low/med effort)

Current header is functional but visually busy. Consider restructuring into two rows:

**Row 1 (controls):**

- Dataset/model dropdown
- Single “Import” dropdown button (Upload JSON / Paste JSON / Manage)
- Result filter (All / Wins / Near misses / Losses)
- Sort (Best hops / Worst hops / Most recent / A→Z)

**Row 2 (insights):**

- Compact stats cards: Success rate, Median hops, Mean ± std, Min/Max
- 1–2 “spotlight” cards: Best run, Most surprising near miss

Why:

- Reduces control sprawl and helps users quickly see what matters
- Makes the page feel more like a “results dashboard”

Proposed layout sketch:

```text
[ Dataset ▼ ] [ Import ▼ ] [ Result: Wins ▼ ] [ Sort: Best hops ▼ ] [ Autoplay ⏵ ]

[ Success ] [ Median hops ] [ Mean ± sd ] [ Min/Max ]   [ tiny hops histogram ▄▆▃▂▇ ]

---------------------------------------------------------------
| Runs list (filter + multi-select) | Graph (focus + legend)   |
|                                  | Selected run details      |
---------------------------------------------------------------
```

### 2) Add a “Selected run details” panel (High impact, med effort)

When a run is selected, show a right-side (or bottom) panel with:

- Start → Target
- Result badge (win/fail/near miss)
- Hops count
- The path as chips (clickable to open an article preview)
- CTA: “Play this matchup”
- CTA: “Copy/share path” (copy as text)

Why:

- The graph is an overview tool; users still need a “details-on-demand” view.
- Gives users a concrete artifact to understand and share.

### 3) Improve run list scannability (Med/high impact, low effort)

Enhancements:

- Add “result” glyph/stripe on the left edge of each run card (green win / amber near miss / red fail).
- Show hops as a prominent pill with color (lower hops → greener, higher → neutral).
- Add a small “difficulty hint” (e.g. based on hop count quantiles).

### 4) Make autoplay more discoverable + controllable (Med impact, low effort)

- Rename the control to “Autoplay” with Play/Pause.
- Add speed options: 1× / 2× / 4× (or “Slow/Normal/Fast”).
- When autoplay is on, show a subtle progress indicator (e.g., “12 / 232”).

### 5) Make the graph legible by default (High impact, med/high effort)

Borrow “overview first, zoom/filter, details on demand.”

Suggested controls:

- **Focus mode toggle**: “All runs” vs “Selected run only”
- **Legend**: start/target nodes, run path edges, wiki-link edges (if shown)
- **Hover tooltip**: node title + how many runs include it
- **Search within graph**: find a node and zoom to it

Visual changes:

- De-emphasize unselected content aggressively (opacity, thinner links)
- Use brand accent for the selected run; use neutral for background runs
- Consider turning off node labels by default; show labels on hover/selected only

Why:

- Dense network graphs quickly become “hairballs”; the UI must help users focus.

### 6) Add a small distribution chart (Med impact, med effort)

Add a tiny histogram/sparkline of hops for wins (and maybe failures) in the header.

Why:

- It tells a richer story than min/max.
- It immediately communicates consistency vs variance.

### 7) Strengthen empty / no-data states (Med impact, low effort)

Cases to handle explicitly:

- Filter returns 0 results
- Dataset import fails / invalid format
- Wins-only enabled but there are no wins

Better empty states should include:

- A short explanation (“No wins for this dataset yet.”)
- A clear next action (“Turn off Wins only”, “Clear filter”, “Try a different dataset”)

### 8) Add “Compare runs” as a first-class mode (High impact, med effort)

This is one of the most compelling stories this product can tell: **how do different runs differ?**

Concept:

- Allow multi-select in the run list (checkboxes)
- Toggle “Compare” to overlay multiple run paths in the graph
- Provide a legend mapping colors to runs

Why:

- It turns the viewer into an analysis tool, not just a gallery.
- It matches the “arena” mental model: compare competitors.

Implementation hint:

- `src/components/force-directed-graph.tsx` already has compare-mode props; a viewer-level compare UI could likely reuse that.

---

## Recommendations: Play Game Page

Primary user goals:

1) Start a race quickly
2) Understand “how to play” instantly
3) Track progress in a compelling way
4) Compare humans vs AI runs
5) Review results + learn from the run

### Part 1: Race Setup

#### 1) Make the stepper feel “alive” (High impact, low effort)

- Add completion states with check icons and subtle fill animations.
- When the user completes a step (pages valid, participants valid), animate the number → check.
- Add short helper text for the active step (“Pick two different pages”, “Add at least one participant”).

#### 2) Improve page picking with previews (High impact, med effort)

Options:

- On hover/focus of a page, show a small popover preview (thumbnail + first sentence).
- Add “popular matchups” / “daily matchup” suggestions.

Why:

- “Capybara → Pokémon” is fun because it’s concrete; previews help users pick interesting races.

#### 3) Participants feel like “players” (Med/high impact, low/med effort)

- Add lightweight avatars: human icon with accent ring, model icon with distinct color.
- Color-code participant cards and status chips by type.
- Show an at-a-glance participant summary row: “2 humans, 3 AIs • hotseat enabled”.

#### 4) Presets as a first-class choice (Med impact, low effort)

Presets are currently good but understated.

- Consider a “Race style” segmented control (Sprint/Classic/Marathon) always visible (advanced dialog still exists for tuning).
- Show estimated “time/effort” for each preset.

#### 5) Make “server connected” a visible state, not a surprise (Med impact, low effort)

The setup currently warns when the API isn’t connected, but you can make this feel more polished by:

- Adding a small connection indicator near the header (“API: Connected” / “API: Offline”) with a colored dot.
- If offline, include “How to start the server” inline (short command snippet) so users don’t hunt.

### Part 2: Arena (During and After Race)

#### 1) Strengthen “active context” (High impact, low effort)

In the main header card:

- Make the active run/player more prominent (colored outline + label: “You (Active)” / “gpt-5-mini (Running)”).
- Surface the immediate next action:
  - Human + waiting: “Start turn”
  - Human + running: “Pick a link”
  - LLM running: “Thinking…” + step counter

Also consider:

- When the selected run changes, briefly highlight the map + details panel so users notice the context switch.
- Add a “You” badge on the user’s run in the leaderboard so it stands out.

#### 1b) Reduce action clutter with better grouping (Med/high impact, low/med effort)

In screenshots, there are several top-level actions visible simultaneously:

- Add challengers
- New race
- Export
- Save to viewer
- Per-run actions: Results/Article, Start/End turn, Give up, Delete

Suggested hierarchy:

- Keep 1–2 primary CTAs visible:
  - During race: “Start turn” (human) or “View results” (finished)
  - Always: “Save to viewer” as a strong secondary CTA
- Move “Export” and “Delete” into a kebab/overflow menu.
- Require confirmation for destructive actions (Delete race / Give up).

Proposed arena action layout sketch:

```text
Arena: Brisbane → List of Australian Leaders...

[ Save to viewer ] [ Add challengers ] [ New race ] [ More ▾ ]
                                      (Export, Delete race, etc)

Selected run header:
You (Human)  Target: ...  Hops: 3/12  Time: 0:36
[ Start/End turn ] [ View results ] [ Give up ▾ ]
```

#### 2) Leaderboard: clarity + delight (High impact, med effort)

- Add clear grouping and stronger status colors.
- Show per-run progress bar: hops used / max hops.
- Animate re-ordering (rank changes) with a subtle slide.
- Make “recently changed” animations more intentional (pulse once, then settle).

#### 3) Wiki + Links panes: reduce friction for human play (High impact, med effort)

- Keep the “Links” list and search extremely fast and keyboard friendly.
- Add keyboard shortcuts:
  - `/` focus link search
  - `Enter` select highlighted link
  - `Esc` clear search
- In “Split” mode, visually connect selected link → navigation outcome (brief highlight).

Extra quality-of-life options:

- Add an optional “visited pages” quick list to avoid loops.
- Provide a one-click “open in Wikipedia” for the current article.

#### 4) Run details: make it feel like a timeline (Med/high impact, med effort)

Instead of a static block, present run details as a timeline:

- Status + time + hops as prominent summary
- Path chips as a horizontal “breadcrumb” with step numbers
- Click a chip to jump the article preview and (for replay) set the replay hop

For LLM runs:

- Summarize each step with a “move card” that can expand to:
  - candidate links considered
  - reasoning / tokens (if available)
  - selected link highlight

#### 5) Matchup map: make progress visually rewarding (High impact, med/high effort)

The map is a signature element; make it *feel* like the race.

- Use distinct colors per run (assign once; keep consistent across UI: leaderboard badge, path, chips).
- Animate path growth as steps occur (line extends).
- Add “distance to target” / “target proximity” cues (even if heuristic).
- Add quick toggles: show all runs / show selected only / show wiki-neighbor links.

Avoiding overwhelm:

- Default to “selected only” once the graph becomes dense.
- Make “show all” a deliberate opt-in.

#### 6) Results: add a shareable “finish screen” moment (High impact, med effort)

- When a race ends, show a compact “podium” panel:
  - Winner(s)
  - Hops + time
  - 1-click Save to viewer
  - 1-click Copy summary
- Consider a subtle confetti burst for the winner (already exists) but ensure it’s tasteful and skippable.

---

## Accessibility + usability checklist (Don’t skip)

- Keyboard navigation works for the entire “human play” loop (leaderboard select → links search → choose link).
- Visible focus rings for interactive elements.
- `prefers-reduced-motion` support (disable confetti + pulsing + large transitions).
- Ensure the status palette is readable for common color-blindness types (add icons and text, not just color).
- Tooltips are not the only place critical info lives (mobile/keyboard users won’t rely on hover).

---

## Suggested Visual Direction (Concrete)

### Palette sketch

- Brand accent: **Blue 600** (or Violet 600)
- Background: keep neutral + subtle gradient
- Surfaces: introduce a slightly tinted card background for “secondary” cards

### Status colors (examples)

- Running: `#3b82f6` (blue)
- Waiting: `#64748b` (slate)
- Win: `#22c55e` (green)
- Fail/Abandoned: `#ef4444` (red) / `#a1a1aa` (neutral)
- Near miss: `#f59e0b` (amber)

### Motion primitives

- Default transition: 150ms ease-out
- Emphasis: 220ms ease-out
- Avoid long/slow transitions; default should feel “snappy”.

---

## Prioritized Backlog (Impact × Effort)

### P0 (1–2 days)

- Add brand accent + status palette usage across badges/buttons
- Viewer: focus mode + legend + hover tooltip
- Viewer: better run list result striping + autoplay label/speed
- Arena: stronger active run/player highlight

### P1 (3–7 days)

- Viewer: selected run details panel + copy/share path
- Viewer: small hop distribution chart
- Arena: timeline-style run details + better replay scrubber
- Arena: per-run color identity used consistently (leaderboard + map + chips)

### P2 (1–3 weeks)

- Page previews when selecting start/target pages
- More expressive map animation + compare modes
- “Finish screen” shareable summary with export options
- Responsive improvements for smaller screens (or a dedicated “spectate mode”)

---

## Appendix: Screenshot References

- View Runs (default): `docs/ux-audit/screenshots/playwright-view-runs-default-again.png`
- View Runs (CTA): `docs/ux-audit/screenshots/validation/p0-view-runs-cta.png`
- Play Game (setup): `docs/ux-audit/screenshots/playwright-play-game-setup.png`
- Play Game (arena, in progress): `docs/ux-audit/screenshots/playwright-arena-in-progress-initial.png`
- Arena (split mode): `docs/ux-audit/screenshots/playwright-arena-split-view.png`
