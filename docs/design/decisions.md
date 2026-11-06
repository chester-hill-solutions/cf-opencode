# Aboiteau identity decisions

## Approved by the user

- Kinetic screenprint as the visual starting point: ultramarine, vermilion, warm paper, a broad yellow ink swatch and restrained pink overprinting.
- Acadian influence as an homage carried through rhythm, material and controlled flow. No star or literal flag treatment.
- A standalone A mark, refined from the initial two-piece gate shape. The final approved version uses a thick, straight diagonal cut that connects naturally with the inner counter. The approved raster reference is preserved in `packages/ui/assets/logo-approved-reference.png`.
- The selected colour treatment is **B3 — Squeegee print**, approved on 2026-11-06: ultramarine structure, a broad yellow impression on the upper piece, vermilion across the lower left and crossbar, and a small pink overprint. Preserve its restrained screenprint texture and clean diagonal cut. The selected reference is [`18-logo-screenprint-squeegee.png`](18-logo-screenprint-squeegee.png); its generation prompt is recorded in `logo-swatch-variants.json`.
- The next implementation is a dedicated Aboiteau UI kit, applied first to settings.

## Implemented proposals

- The approved mark is traced as shared SVG paths in `packages/ui/src/brand.ts`, used by the React logo and generated favicon.
- The working type family is self-hosted DM Sans. UI type, spacing, colour roles and responsive layouts are proposed implementation choices, not separately approved identity decisions.
- The source-vendored CHS controls supply behaviour. Aboiteau owns the theme and product compositions.
- Colour is an encoding, not a finish. `data-accent` maps the six brand colours to `--abo-accent`, `--abo-accent-strong`, `--abo-accent-ink` and `--abo-accent-soft`. Settings sections, onboarding steps, gallery sections and chart series share the same set; every accent is paired with a number or written label. Decorative artwork is not used as a page banner.
- Settings keeps repo, branch, model catalogue/custom reference, polling, streaming, and allow/ask/deny editing. The token storage key stays compatible with the previous page.

## Retired logo directions

The soft wordmark-only and rounded counterform explorations are not active. The generic A and the bent channel that read as a tap were rejected. Do not reintroduce those shapes or the original star.

## Source evidence

Product behaviour was checked in `src/index.ts`, `src/settings.ts`, `src/models.ts`, and `src/conversation.ts`. `docs/roadmap.md` describes later product ambitions; the settings copy does not claim those are shipped.

[CSCE’s aboiteau reference](https://cscehistory.ca/national/acadian-aboiteau/) and [Mount Allison’s archival context](https://libraryguides.mta.ca/tantramar_marshland/acadian_settlement) informed the structural idea. Their images were not reproduced in the kit. Expressive art was generated with the built-in image_gen tool; it is not documentary imagery.
