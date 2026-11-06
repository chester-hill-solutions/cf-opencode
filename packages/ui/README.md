# @aboiteau/ui

Aboiteau’s dedicated UI kit: brand assets, semantic design tokens and accessible React components. The settings page and the live `/ui-kit/` gallery consume this same package.

## Use

```tsx
import { Button, Field, FieldLabel, Input } from "@aboiteau/ui"
import "@aboiteau/ui/theme.css"

<Field>
  <FieldLabel htmlFor="repository">Repository URL</FieldLabel>
  <Input id="repository" type="url" />
</Field>
<Button size="touch">Save settings</Button>
```

The host compiles Tailwind v4 and includes this package in its source scan. Aboiteau’s build does this in `web/styles.css`. `data-style="aboiteau"` scopes the theme when embedding alongside other themes. The host serves the assets under `/brand/`; `scripts/build-ui.ts` provides that setup here.

## Ownership

- `src/components/ui/` contains unmodified source vendored from CHS UI kit 0.4.0, including React Aria behaviour. The registry manifest is `.chs-ui.json`.
- `src/styles/base.css` and `foundation.css` are the shared CHS foundation. Update them from upstream, not by adding Aboiteau-specific rules.
- `src/styles/aboiteau.css` owns Aboiteau’s colours, typography, spacing, control dimensions, borders and slot treatments. Change the theme before changing a primitive.
- `src/components/brand.tsx`, `status.tsx` and `src/brand.ts` are Aboiteau compositions. They add brand/display behaviour without replacing control semantics.
- Product layout and API logic stay in `web/`, outside the kit.

Upstream: [CHS UI kit](https://github.com/chester-hill-solutions/chester-hill-solutions/tree/main/packages/ui-kit). Add primitives through its registry/CLI, then export the required public API from `src/index.ts`. There are no behaviour forks in this first version.

## Visual rules

Use the approved A mark with its wide, uninterrupted diagonal cut. `Logo` uses `currentColor`; keep the two shapes and counter intact. The SVG path source also generates the favicon, so there is one geometry definition.

Ultramarine carries actions and focus. Paper and ink carry reading. Vermilion, yellow and pink are expressive accents; yellow appears as an ink swatch. Keep artwork away from fields and reading. Solid semantic colours and text labels communicate status.

Controls use complete borders, visible focus, and at least 44px targets. Status is written out. Forms retain drafts on error. Motion respects reduced-motion preferences.

DM Sans is self-hosted from `@fontsource-variable/dm-sans` under the SIL Open Font License. The build includes its licence. The generated wordmark studies were references; working UI type uses the real font.

## Preview and verify

```sh
bun run dev:ui
# http://127.0.0.1:4173/ui-kit/

bun run typecheck
bun run test:ui
```

To connect the local settings UI to a running API, start with `ABOITEAU_API_ORIGIN=http://127.0.0.1:8787 bun run dev:ui`. The unconnected preview clearly reports that no API is available; it does not simulate saving.
