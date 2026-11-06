# A3 requests — files outside my ownership

From worker A3 (app shell). Nothing here is edited by me; each item names the
file, the change, and why the shell needs it.

## 1. `src/components/layout/ToolWorkspace.tsx` — drop the duplicated title block

`AppLayout` now renders `ToolPageHeader` (exported from
`src/components/layout/AppLayout.tsx`) for every `/tool/:toolId` route, **above**
the outlet. It carries the breadcrumb (`BrowserSnip / PDF Tools / <category> /
<tool>`), the tool's one-line promise from the registry, the optional-engine
badge and the star toggle.

The workspace header still renders its own back link + icon tile + tool name, so
a tool page shows the tool name twice in two stacked bars. Keep the action half
(`Process`, `Processing…`, `Log`) and delete the identity half (the
`navigate(dashboardPath)` button, the `TOOL_ACCENT` icon tile and the
`{tool.name}` span) plus the now-redundant `!tool` early return's "Tool not
found" copy can stay as-is.

Same file, dark mode: `bg-white/85`, `bg-white/95`, `bg-white` and
`text-cream-border` (line ~331 is one instance) are literal Tailwind colours, so
the workspace pane stays paper-white while the shell around it goes dark. The
shell tokens already exist in `src/index.css` with dark values — use
`shell-header`, `shell-panel`-free equivalents: `.shell-app`, `.shell-btn`,
`.shell-row`, `.shell-muted`, `.shell-soft`, `.shell-title`, `.shell-meta`,
`.doodle-section`, `.tool-card`, `.sketch-border`. Those three component classes
are now tokenised, so `doodle-section`/`tool-card`/`sketch-border` are themed for
free. The `TOOL_ACCENT` hex map is a per-category tint, not a surface — leaving
it is fine, it just will not shift with the theme.

## 2. `tailwind.config.js` + `index.html` — make the palette itself theme-aware (one-time, app-wide)

Phase A gives the shell a complete dark palette, but ~300 files use `bg-cream`,
`text-ink`, `border-cream-border`, `bg-white`, and those utilities compile to
literal hexes, so they ignore `html.dark`. Two small edits fix that for the whole
app without touching any component:

```js
// tailwind.config.js — channel-triplet vars, resolved at paint time.
// Whoever lands this adds the matching `--*-rgb` values to the `:root` and
// `html.dark` blocks in src/index.css (that file is A3-owned; ask me and I will
// add them, or add them alongside — light values are the current hexes).
colors: {
  ink: {
    DEFAULT: 'rgb(var(--ink-rgb) / <alpha-value>)',      // 27 27 24  /  dark 242 242 236
    soft: 'rgb(var(--ink-soft-rgb) / <alpha-value>)',    // 85 85 78
    muted: 'rgb(var(--ink-muted-rgb) / <alpha-value>)',  // 117 117 107
  },
  cream: {
    DEFAULT: 'rgb(var(--cream-rgb) / <alpha-value>)',        // 247 247 244
    light: 'rgb(var(--cream-light-rgb) / <alpha-value>)',    // 255 255 255
    border: 'rgb(var(--cream-border-rgb) / <alpha-value>)',  // 227 227 221
    soft: 'rgb(var(--cream-soft-rgb) / <alpha-value>)',      // 241 241 236
  },
  accent: {
    DEFAULT: 'rgb(var(--accent-rgb) / <alpha-value>)',       // 37 99 235
    hover: 'rgb(var(--accent-hover-rgb) / <alpha-value>)',   // 29 78 216
    ring: 'rgba(var(--accent-rgb) / 0.18)',
  },
  success: 'rgb(var(--ok-rgb) / <alpha-value>)',
  warn: 'rgb(var(--warn-rgb) / <alpha-value>)',
  danger: 'rgb(var(--bad-rgb) / <alpha-value>)',
}
```

Light values stay byte-identical to today, so nothing shifts for the default
theme; `darkMode: 'class'` is already configured and `useTheme` already sets
`html.dark`.

`index.html` — apply the stored theme before first paint so a dark-mode reload
does not flash the light palette (the shell hook runs after mount):

```html
<script>
  try {
    if (localStorage.getItem('browsersnip:theme') === 'dark') {
      document.documentElement.classList.add('dark');
    }
  } catch (e) {}
</script>
```

Until that lands, the honest state is: header, rail, palette and tool header are
dark; the page inside the outlet is still light. `src/index.css` already carries
a dark value for every token the shell uses, so this is the remaining gap, not a
shell bug.

## 3. `src/components/dashboard/PdfDashboard.tsx` — one search, one behaviour (optional)

The dashboard filter uses its own `includes()` over `TOOLS` from
`lib/constants`; `⌘K` uses `searchPalette()` over the registry (`lib/pdf/tools/
registry`), so the same words rank differently in the two places and the
dashboard's copy "filter tools…" implies the same search. Either import
`searchPalette` (exported from `src/components/layout/CommandPalette.tsx`,
pure, no React) or keep the local filter and read a `?category=` param — the
rail's categories would then be able to deep-link into a filtered dashboard
instead of only expanding in place.

## 4. `src/stores/file-store.ts` — please keep the write path (no change asked)

The shell records a recent entry by observing `file` / `files` / `activeTool`
from `useFileStore`, storing `{ name, size, toolId, at }` only. That works for
every picker that goes through `setFile` / `addFile` / `setFiles`. If A2's
`FileQueue` ever loads a document through a side channel that bypasses those
actions, the row will not appear in Recents — worth one line of attention in
review, no edit needed today.
