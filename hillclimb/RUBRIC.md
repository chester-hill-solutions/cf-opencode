# Hill-climb rubric — cf-opencode settings panel

**FROZEN.** Written before the baseline and never edited during the run.

## Surface

- `public/index.html` — the settings panel served at `/` by the Worker: access/token block,
  workspace repo + branch, model, runtime (poll seconds, streaming), and permission lists
  (allow / ask / deny), with load/save actions and a status line.

Out of scope: `src/**` (Worker, DO, settings validation), `control-server.ts`, `Dockerfile`,
`wrangler.jsonc`, tests. A change that only scores by editing out-of-scope code is out of scope.

**Mounted-check:** the Worker serves this file as a static asset at `/`; verified `GET /` → `200 text/html`
against the deployed Worker, and the capture harness serves the same file from `public/`.

## Scoring

Each criterion is scored **0–10 per viewport** by a blind critic that sees images only.

```
viewportScore = Σ (weight × criterionScore)        // max 100
runScore      = mean(viewportScore over all fixed viewports)
```

A 10 is described below. A 5 means "competent but visibly unconsidered".

| Criterion | Weight | What 10 looks like on *this* surface |
|---|---|---|
| Task clarity | 20 | In under 3 seconds a first-time operator can say what this page configures, which fields are required, and whether the current values are loaded or unsaved. |
| Visual hierarchy | 15 | One dominant element per state (the form, or the status when saving/erroring); section labels, fields and actions rank without competing. |
| Density and rhythm | 15 | One spacing and type system across all five sections; labels, inputs and help text align; the page reads as a single form, not five pasted cards. |
| State coverage | 15 | Empty (no token), loaded, edited/dirty, saving, long permission lists and validation error each look intentional at every viewport. |
| Accessibility | 15 | Dark-theme contrast ≥ 4.5:1 for text; visible focus ring on every control; inputs have programmatic labels; buttons ≥ 24 pt; the form is operable by keyboard alone. |
| Consistency | 10 | Reuses one control language (input, textarea, button, status pill) with no one-off sizes or colours. |
| Polish | 10 | No clipped or orphaned text, no misaligned edges, no stray dividers, no horizontal scroll at any viewport, no jump between viewports. |

### Why these weights

Task clarity carries 20 because an admin page that does not answer "what am I changing, and is it saved?"
has failed at its only job. State coverage and accessibility carry 15 each because a settings surface is
mostly states, and a save/error state that looks unconsidered is the moment an operator stops trusting it.

## Hard gates (pass/fail; a fail vetoes the iteration regardless of score)

| Gate | How it is checked |
|---|---|
| Build | `bun run typecheck` |
| Tests | `bun run test` |
| Console | capture log contains no `Uncaught`, `Unhandled`, or `pageerror` |
| Captures | all 6 states × 3 viewports, DPR 2, every file ≥ 20 kB, dimensions = 2 × viewport |
| Scope | ≤ 1 file changed (`public/index.html`); empty diff is not an iteration |
| **No regression** | **No viewport scores below the current best.** |
| Removal | No content, control, or function removed to raise a score |

## Fixed conditions

- Viewports (window frame, points): **`900x650`, `1280x800`, `1600x1000`**, DPR **2**.
- States, in fixed order: **`empty`, `idle`, `active`, `waiting`, `long`, `error`**:
  - `empty` — no token, page as first seen
  - `idle` — token present, settings loaded
  - `active` — a field edited and focused (unsaved)
  - `waiting` — save submitted, PUT in flight
  - `long` — long repo URL and 40 allow patterns
  - `error` — save rejected by validation
- Data: frozen fixture served by the capture harness; no network.
- Harness: `hillclimb/harness/capture.cjs` + `RUBRIC.md` + console patterns; SHA-256 recorded in `run.json`.

## Decision rule

```
keep  ⇔  runScore(candidate) − runScore(best) ≥ 2.0
         AND every hard gate passes
         AND no viewport regresses
```

A delta below 2.0 is noise. A gate failure is a revert regardless of score.

## Anti-gaming rules

1. Never edit this rubric, the harness, the viewport list, the state list or the fixture mid-run.
2. Never delete content, hide elements, collapse information or remove functionality to raise a score.
3. Never cherry-pick a flattering viewport or state.
4. Never batch ideas. One iteration, one variable, one diff.
5. The agent that wrote the change never scores it. The critic sees images and this file only.
6. A change that cannot be explained in one sentence of mechanism is not a hill-climb step.
