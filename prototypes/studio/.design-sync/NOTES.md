# design-sync notes — FREE UI

Project: **FREE UI** (`2e927ede-a3e4-4b85-9e9e-32b3acedd06a`) ·
https://claude.ai/design/p/2e927ede-a3e4-4b85-9e9e-32b3acedd06a

## Setup quirks (this repo)

- **The "package" is `prototypes/studio/src/ui`** — an in-app primitive library,
  not a published package. `pkg` is a label (`free-ui`); the converter resolves
  `PKG_DIR` to `prototypes/studio` by walking up from `--entry`.
- **Run all design-sync commands from `prototypes/studio/`** (package dir = config
  home). `.design-sync/`, `.ds-sync/`, `ds-bundle/` all live there.
- **`pnpm build:lib` is required before the converter** — it runs `vite build`
  (→ `dist-lib/free-ui.js` + `free-ui.css`) then `tsc -p tsconfig.lib.json`
  (→ `dist-lib/*.d.ts`). `dist-lib/` is gitignored, so it must be rebuilt on a
  fresh clone.
- **`studio/package.json` has `"types": "dist-lib/index.d.ts"`** — this is how the
  converter's `findTypesRoot` locates the `.d.ts` tree for component discovery +
  prop extraction. Don't remove it.
- Converter command:
  `node .ds-sync/package-build.mjs --config .design-sync/config.json --node-modules ./node_modules --entry ./dist-lib/free-ui.js --out ./ds-bundle`
- **Playwright**: local cache has chromium build **1228** → install
  `playwright@1.61.1` (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`) into `.ds-sync/` for
  the render check; no browser download needed.

## Fonts

- Brand fonts (Albert Sans, Source Serif 4, IBM Plex Mono) are **shipped as woff2**
  via `cfg.extraFonts` → `.design-sync/fonts/brand-fonts.css` + 22 woff2 (latin +
  latin-ext, the weights the app uses).
- **Remote `@import` is NOT supported by the package shape** — the converter only
  pulls remote imports from a Storybook static dir, and Vite/Lightning strips the
  `@import` from the compiled CSS. Don't retry that approach; ship woff2.
- Fetched with `.design-sync/fetch-fonts.mjs` (Chrome UA → Google Fonts):
  `node .design-sync/fetch-fonts.mjs ./.design-sync/fonts`. To refresh or add
  weights/subsets, edit the css2 URL in that script and re-run.

## Re-sync risks (watch-list)

- **Fonts are a fetched snapshot.** If the app changes font families, weights, or
  subsets (see `index.html` `<link>` + `index.css` `@theme`), the shipped woff2 go
  stale silently — re-fetch.
- **The app does not yet consume `src/ui`.** The primitives mirror inline className
  patterns in `App.tsx`/`SchemaPanel.tsx`/`ResultsTab.tsx`/etc. If those drift, the
  previews (which import the real `free-ui` exports) stay correct but may diverge
  from how the app actually looks. Adopting the primitives in the app would remove
  that risk.
- `EmptyState` uses `cfg.overrides.EmptyState.cardMode: "column"` (presentation
  only — its 3 stories overflow a grid cell otherwise).
- `dist-lib/` is a build artifact — always `pnpm build:lib` before re-syncing.

## Known render warns

None — render check is clean (8/8, 0 bad/thin, 0 floor cards).
