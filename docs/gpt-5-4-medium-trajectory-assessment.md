# GPT-5.4 Medium Trajectory Assessment

## Scope

This note assesses a small, representative set of `gpt-5.4` trajectories from the SimpleWiki benchmark at `medium` reasoning effort.

The goal is clarity:

- show the information the model saw
- show the reasoning it wrote down
- show the link it chose
- show what happened next

## What The Model Was Shown

Each move uses the same prompt shape:

```text
Current article: <current>
Target article: <target>
Available links (numbered):
1. ...
2. ...
...

Your path so far: <path>
```

The prompt then asks the model to briefly analyze the links and answer with `<answer>NUMBER</answer>`.

## High-Level Read

- Overall win rate: `76.00%` over `200` runs.
- Median winning path length: `5` hops.
- Median winning slack over shortest path: `+1` hop.
- Strongest slice: `diag_hub_escape_v1` at `10/10` wins.
- Also perfect: `diag_hub_seek_v1` and `diag_wide_choice_v1`, both `10/10`.
- Weakest slice: `diag_dead_end_prone_v1` at `6/10` wins.
- Revisit rate: `30.29%`, which matters because the main failure mode is looping after a locally plausible move.

## Example 1: Clean Hierarchical Planning

`Ramsholt` -> `Moscavide (Lisbon Metro)`
Slice: `core_rank_v1`
Result: `win` in `5` moves
Path: `Ramsholt -> List of countries -> Portugal -> Lisbon -> Lisbon Metro -> Moscavide (Lisbon Metro)`

### Step 1

- `Seen:` current article `Ramsholt`, target `Moscavide (Lisbon Metro)`, `113` links.
- `Important options:` `England`, `Geographic coordinate system`, `List of sovereign states`.
- `Model reasoning:` it rejected local Suffolk links and said `List of sovereign states` was best because it should directly include `Portugal`, which is the clearest route to `Lisbon` and then `Lisbon Metro`.
- `Choice:` `92. List of sovereign states`
- `Outcome:` moved to `List of countries`

### Step 2

- `Seen:` current article `List of countries`, target unchanged, `313` links.
- `Model reasoning:` from a country list, the most direct step is `Portugal`.
- `Choice:` `47. Portugal`
- `Outcome:` moved to `Portugal`

### Step 3

- `Seen:` current article `Portugal`, `211` links.
- `Model reasoning:` go to `Lisbon` first because the target is a Lisbon Metro station.
- `Choice:` `53. Lisbon`
- `Outcome:` moved to `Lisbon`

### Step 4

- `Seen:` current article `Lisbon`, `174` links.
- `Important options:` `Loures`, `Parque das Nações`, `Lisbon Metro`.
- `Model reasoning:` `Lisbon Metro` is the most likely page to contain the exact station link.
- `Choice:` `109. Lisbon Metro`
- `Outcome:` moved to `Lisbon Metro`

### Step 5

- `Seen:` current article `Lisbon Metro`, `66` links.
- `Choice:` `46. Moscavide (Lisbon Metro)`
- `Outcome:` win

### Assessment

- This is the model at its best.
- It zooms out once, then descends country -> city -> transit system -> station.
- No wasted recovery steps.
- This is the most typical successful pattern in the strong slices: pick a good hub, then narrow cleanly.

## Example 2: Wide-Choice Pruning

`Rustiques` -> `Mark Cavendish`
Slice: `diag_wide_choice_v1`
Result: `win` in `4` moves
Path: `Rustiques -> France -> Tour de France -> Eddy Merckx -> Mark Cavendish`

### Step 1

- `Seen:` current article `Rustiques`, target `Mark Cavendish`, `441` links.
- `Important options:` `France`, `Carcassonne`, `Aude`, `Occitanie`, many nearby communes.
- `Model reasoning:` it explicitly rejected the many local commune links as dead ends and chose `France` as the richest hub for sport and cycling.
- `Choice:` `1. France`
- `Outcome:` moved to `France`

### Step 2

- `Seen:` current article `France`, `520` links.
- `Important options:` `United Kingdom`, `Isle of Man`, `Summer Olympics`, `Tour de France`.
- `Model reasoning:` `Tour de France` is strongest because Cavendish is one of the most famous riders in Tour history and that page is likely to link directly to him.
- `Choice:` `343. Tour de France`
- `Outcome:` moved to `Tour de France`

### Step 3

- `Seen:` current article `Tour de France`, `53` links.
- `Important options:` `Eddy Merckx`, `Lance Armstrong`, `Cadel Evans`, `List of Tour de France winners`.
- `Model reasoning:` it used a specific semantic fact: Cavendish is famous for matching or breaking Merckx's stage-win record, so `Eddy Merckx` is a better bridge than generic cycling pages.
- `Choice:` `10. Eddy Merckx`
- `Outcome:` moved to `Eddy Merckx`

### Step 4

- `Seen:` current article `Eddy Merckx`, `120` links.
- `Choice:` `31. Mark Cavendish`
- `Outcome:` win

### Assessment

- This is a strong example of pruning under heavy distraction.
- The model does not try to inspect everything equally.
- It collapses a huge choice set into a small set of plausible bridges and then commits.
- The notable strength here is not just knowing cycling; it is refusing to waste moves on local geographic noise.

## Example 3: Escaping A Bad Local Context

`Charmoille, Haute-Saône` -> `Sydney Derby`
Slice: `diag_hub_escape_v1`
Result: `win` in `5` moves
Path: `Charmoille, Haute-Saône -> France -> Association football -> Australia -> A-League Men -> Sydney Derby`

### Step 1

- `Seen:` current article `Charmoille, Haute-Saône`, target `Sydney Derby`, `559` links.
- `Model reasoning:` local French administrative pages were judged too narrow, so it picked `France` as the best national hub.
- `Choice:` `1. France`
- `Outcome:` moved to `France`

### Step 2

- `Seen:` current article `France`, `520` links.
- `Model reasoning:` no written rationale survived here, but the choice was `Association football`.
- `Choice:` `26. Association football`
- `Outcome:` moved to `Association football`

### Step 3

- `Seen:` current article `Association football`, `179` links.
- `Important options:` `Australia`, `AFC`, `Oceania Football Confederation`, generic sport links.
- `Model reasoning:` `Australia` is the direct country match because `Sydney Derby` is an Australian football rivalry.
- `Choice:` `4. Australia`
- `Outcome:` moved to `Australia`

### Step 4

- `Seen:` current article `Australia`, `488` links.
- `Important options:` `Sydney`, `New South Wales`, `Sport`, `A-League Men`.
- `Model reasoning:` `A-League Men` is better than `Sydney` because the target is specifically a rivalry inside that competition.
- `Choice:` `398. A-League Men`
- `Outcome:` moved to `A-League Men`

### Step 5

- `Seen:` current article `A-League Men`, `34` links.
- `Model reasoning:` it compared rivalry pages and club pages, then picked the exact target.
- `Choice:` `24. Sydney Derby`
- `Outcome:` win

### Assessment

- This shows why `diag_hub_escape_v1` is the model's strongest slice.
- It can leave an irrelevant local page quickly, choose the right domain, then narrow with discipline.
- The key behavior is not just "go broad"; it is "go broad in the right domain".

## Example 4: Good Semantic Intuition, Weak Global Control

`Brenda Blethyn` -> `Bringing Up Baby`
Slice: `diag_dead_end_prone_v1`
Result: `lose` at max steps
Path start: `Brenda Blethyn -> Academy Award for Best Actress -> Katharine Hepburn -> The Philadelphia Story -> Katharine Hepburn -> The Philadelphia Story -> Cary Grant -> North by Northwest -> Cary Grant -> ...`

### Early steps

- `Step 1 seen:` `Brenda Blethyn`, target `Bringing Up Baby`, `29` links.
- `Model reasoning:` `Academy Award for Best Actress` was the strongest route because Katharine Hepburn is central to that page and from Hepburn it expected to reach the film.
- `Choice:` `15. Academy Award for Best Actress`

- `Step 2:` it then chose `Katharine Hepburn`.
- `Step 3:` from `Katharine Hepburn`, it chose `The Philadelphia Story`.
- `Step 4:` from `The Philadelphia Story`, it correctly identified both `Cary Grant` and `Katharine Hepburn` as strong bridges and chose one of them.

### Where it goes wrong

- From `Katharine Hepburn`, it repeatedly falls back to `The Philadelphia Story`.
- From `The Philadelphia Story`, it pivots to `Cary Grant`.
- From `Cary Grant`, it picks `North by Northwest`, then returns to `Cary Grant`.
- Later it broadens to `Movie` and `Academy Award`, but eventually falls back into the same Hepburn or Cary Grant neighborhood.

### Why this is a useful failure

- The local reasoning is often sensible.
- The model knows the correct actor cluster around the target.
- The failure is search control: it keeps taking plausible classic-film adjacency edges without checking whether the trajectory is actually converging.
- This is exactly what the `30.29%` revisit rate looks like in practice.

### Assessment

- The model is not "confused" in the ordinary sense.
- It is semantically on-topic almost the entire time.
- It loses because it does not maintain a strong enough anti-loop policy once it is inside a dense relevant cluster.

## Example 5: Concept Match That Produces No Graph Progress

`Euphorbia` -> `Married... with Children`
Slice: `diag_dead_end_prone_v1`
Result: `lose` at max steps
Path start: `Euphorbia -> Plant -> Glasgow -> United States -> Television -> Television program -> Television program -> Television program -> ...`

### Productive early phase

- `Step 1:` from `Euphorbia`, it picks `Plant` because the narrow taxonomy links are useless for a sitcom target.
- `Step 2:` from `Plant`, it picks `Glasgow` as a non-biology escape hatch into culture and media.
- `Step 3:` from `Glasgow`, it picks `United States` because the target is an American sitcom.
- `Step 4:` from `United States`, it picks `Television`.
- `Step 5:` from `Television`, it picks `Television program`.

Up to this point, the trajectory is reasonable.

### Failure pattern

- From `Television program`, the model keeps choosing `11. Television series`.
- Its written reasoning is stable and superficially correct: the target is a television series, so `Television series` looks like the best conceptual match.
- But selecting that link resolves back to `Television program`, so the state does not change.
- Steps `6` through `20` are therefore the same effective decision repeated until timeout.

### Why this matters

- This is the clearest failure mode in the run set.
- The model is matching on article type instead of graph transition value.
- It is not detecting that its "best" move is a no-op under canonicalization or redirect behavior.

### Assessment

- This is not a knowledge failure.
- It is a graph-awareness failure.
- Once the model reaches a redirect or synonym trap, it can keep producing fully coherent rationales while making zero progress.

## Bottom Line

- `gpt-5.4` at `medium` is strong when a task can be solved by finding the right hub and then narrowing cleanly.
- It is especially strong at escaping irrelevant local pages and at pruning very large link sets.
- Its typical failures are not wild hallucinations; they are controlled but unproductive loops.
- Recurring failure shape: `semantic near-loop`, where it stays inside a relevant cluster like Hepburn / Cary Grant / classic films.
- Recurring failure shape: `canonicalization trap`, where it repeatedly chooses a redirect-like concept that returns to the same article.

## Source Files

- Prompt template: `/Users/andrewg/projects/wikiracing-llms/parallel_eval/benchmark/prompt.py`
- Run summary: `/Users/andrewg/projects/wikiracing-llms/results/benchmarks/classic_local_simplewiki_v1_matrix_cells_20260308_postfix_accel/gpt-5.4__medium/runs/gpt-5-4__medium/summary.json`
- Curated run source: `/Users/andrewg/projects/wikiracing-llms/public/benchmarks/viewers/gpt-5-4-medium.json`
- Raw step artifacts: `/Users/andrewg/projects/wikiracing-llms/results/benchmarks/classic_local_simplewiki_v1_matrix_cells_20260308_postfix_accel/gpt-5.4__medium/runs/gpt-5-4__medium`
