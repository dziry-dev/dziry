# skia-proto — framework design

> Generated from a 12-agent research workflow run on 2026-07-30.
> Section 1 is the synthesized plan. The appendices are the raw research it was
> derived from, kept so the reasoning behind each decision stays recoverable.
>
> Run ID: `wf_193828c4-f3e`

---

# dziri — Component Model, Router, and Reactivity

**Status:** architectural decision record. Supersedes ROADMAP D2's multi-window cut (authoring shape only) and NOTES.md:587 (module-level-export rule). Everything below is decided; nothing is offered as an alternative.

**Correction to the record before anything else:** `MEMORY.md` / `skia-proto-architecture.md` still say "no Rust runtime." That has been false since 2026-07-30. The engine is `native-src/dziri-engine` (cdylib, SDL3 static, skia-safe 0.87 + textlayout, Taffy 0.9), Bun's FFI surface is 21 symbols, and the bulk path is shared memory. Fix the memory file and add a `CLAUDE.md` as milestone 0.

---

## 1. Decisions

| Decision | Choice | Rationale |
|---|---|---|
| **App model** | `app.tsx` default-exports `<App>` — a compile-time **manifest** written in JSX, not a component. Produces no nodes and does not exist at runtime. | The compiler is already an evaluator (`src/compile.ts:63-70` imports the module). A `dziri.config.ts` would be a second declaration language that cannot name a handler by identity. |
| **Window model** | `<Window>` declares a window **kind**. The set of kinds is closed and statically enumerable; the set of live instances is dynamic. `{cond && <Window/>}` is a compile error. | SwiftUI's Scene vocabulary + Tauri's `create: false`. Capacities, style tables, string arenas, menu tables and the `WindowId` union are all sized at build time because the kind set cannot change. |
| **Window identity** | Singleton kinds only in v1. Directory name **is** the id, recovered by object identity — never restated in a prop. | Same identity trick `resolve-refs.ts` uses, one level up. `WindowGroup` (value-keyed multi-instance) is designed and deferred. |
| **Navigation unit** | **A region, not a window.** A window shell declares named `<Region>`s; each region owns its own screen set, stack and history. | Zed (Workspace→Pane→Item), VS Code, Mail. Desktop's default case is N concurrently visible independently-navigating panes. This is exactly the case that forced Next.js to invent `@slot` and `(.)`intercept. Do not inherit a model whose two ugliest features patch your default case. |
| **Router API** | Neither (a) nor (b) as posed. **Screens are plain components** (no `createFileRoute`, no restated path). Filenames own the path and the args. One *optional* `export const screen = {...}` carries only what the filesystem cannot say: `load`, `keepAlive`, `deepLink`, `title`. | TanStack's ceremony exists because TanStack has no compiler. Restating the path is the one thing a compiler makes indefensible. But a bare component cannot declare async, and that declaration is what lets the compiler **delete** the promise cell, the boundary node and the pending subtree for synchronous screens. |
| **Route values** | Navigation carries an inert typed struct `{screen, args}` pushed onto a per-region stack. Args live **in the frame**, not in module-global signals. | SwiftUI `NavigationPath`. Global param signals make route values unconstructable without navigating, break history replay, and make two regions showing the same screen impossible. |
| **`loaderDeps`** | **Rejected.** A screen's load function takes exactly one input — its args — so the dependency set is the args tuple, whose arity and types come from the filename. Nothing to declare, nothing to drift. | Fixed-arity cache key with zero hand-maintained duplication. Strictly better than TanStack's array. |
| **Search / query params** | **Rejected.** View state that must survive back/forward is a path segment (`[tab=projectTab]`). Everything else is a signal. | Query strings earn their keep through URL shareability, which does not exist on the desktop. Keeping them costs a runtime query parser and a second codec vocabulary. |
| **Path matching** | Fully static: a generated `switch` on `path.split("/")` with literal `===` compares, reached only from the OS. In-app navigation touches no string, ever. | Ledger entry #7: "OS-supplied deep-link string." Compiler-emitted code, no grammar, no tree construction; the URL scheme must be registered at build time anyway, so the registration files are generated from the same table. |
| **Route activation** | All screens of a window live in **one node table**; navigation writes `hidden` bytes on the divergent path (1–3 writes). No node is ever created, moved or destroyed by navigation. | `hidden` is already honoured by Taffy, Skia and hit-testing. Back/forward preserves scroll, focus and per-screen state for free. Code splitting dissolves — what Next splits is parse-and-eval cost that does not exist here. |
| **Reactivity core** | Signals driving compiled writes into a static arena. **Reject recomposition outright.** | Compose's slot table exists to recover at runtime an identity the compiler already knows, and it erases the static/dynamic distinction — forfeiting the one optimization uniquely available here (a zero-binding subtree is constant data). |
| **Dirty planes** | Four planes — PAINT / TEXT / LAYOUT / STRUCTURE — derived automatically from `STYLE_FIELDS[i].affectsLayout` and crossed to the engine as a mask. | `src/window-host.ts:80-93` currently *discards* the `Dirty` return from `applyStylePatches`, and `engine.rs:273` is `if self.fresh \|\| diff.any` — so a colour-only theme toggle relayouts today. The information exists and is being thrown away. Rust cannot recover it: `commit()` is a memcmp and knows which slots changed, never whether the field affects layout. |
| **Component-local state** | **Yes** — via a construction pass. Components run exactly twice in their lifetime: once at build, once at process start. Signals are harvested by creation ordinal; handlers and refs by node id. | Deletes NOTES.md:587's module-level-export rule and most of `resolve-refs.ts`. Honest cost: the construction pass is a second compile minus CSS, so the JSX runtime ships to the runtime bundle. |
| **React primitives kept** | `signal`, `computed`, `effect` (+cleanup, +gates), `untrack`/`peek`, `ref` (node id), `resource`, `source`, `onFrame`, `Suspense`, error boundaries, `Overlay`, `key`, custom factories, `batch`. | Each earns its place below. |
| **React primitives rejected** | `useCallback`, `React.memo`, `forwardRef`, `useImperativeHandle`, `useTransition`, `useDeferredValue`, `StrictMode`, dependency arrays, `flushSync`, `useLayoutEffect`-as-shipped. | No reconciler to stabilize identity for, no bodies to double-invoke, and transitions are free structurally because both trees are already in the arena. |

---

## 2. App & Window model

### 2.1 Layout — every meaningful filename

```
my-app/
  app.tsx                   REQUIRED. default-exports <App>. The manifest.
  app.css                   optional. Prepended to every window's stylesheet.
  app.gen.ts                GENERATED. Manifest data + menu/tray tables.
  windows.gen.ts            GENERATED. WindowId union + typed open/close/focus.
  params/                   compile-time param matchers.
    uuid.ts                 exports `parse(raw): string | null`
    projectTab.ts
  state/                    app-scoped signal modules (convention).
  components/               shared build-time components (convention).
  windows/
    main/                   <- directory name IS the window id.
      window.tsx            REQUIRED. default-exports <Window>. Declares regions.
      window.css            optional. Appended after app.css for this window.
      state.ts              optional. Window-scoped signals.
      regions/              REQUIRED if the shell declares any <Region>.
        sidebar/            <- directory name IS the region name.
        main/
        inspector/
      nav.gen.ts            GENERATED. Typed per-region nav + Screens constructors.
      ui.gen.ts             GENERATED. This window's node table (all screens).
    settings/
      window.tsx
      window.css

  *.gen.ts   always generated, never hand-edited, gitignored.
  +screen.ts generated sibling inside each screen directory (typed args + data).
```

There is no `index.tsx` for a window: `index` would have to mean both "the window declaration" and "the window's root component." `window.tsx` says which.

There is no `pages/` alias for `regions/main/`. One spelling. The extra directory costs nothing and makes the region concept unavoidable, which is the point.

### 2.2 `app.tsx`

```tsx
/** @jsxImportSource dziri */
import { App, Menu, MenuItem, Separator, Tray } from "dziri/scene";
import main from "./windows/main/window.tsx";
import settings from "./windows/settings/window.tsx";
import { onLaunch, onQuit, onOpenUrl } from "./state/lifecycle.ts";
import { newDoc, save, canSave, toggleSidebar, sidebarShown, quit, showMain } from "./state/commands.ts";
import { openWindow } from "./windows.gen.ts";

export default (
  <App
    quitOn="lastWindowClosed"     // | "explicit"  (macOS shape, tray-only apps)
    singleInstance                // named mutex / lockfile; argv forwarded
    urlScheme="myapp"             // emitted into Info.plist / registry / .desktop
    onLaunch={onLaunch}
    onQuit={onQuit}
    onOpenUrl={onOpenUrl}
  >
    {main}
    {settings}

    <Menu>
      <MenuItem label="New"  accel="Cmd+N" onSelect={newDoc} />
      <MenuItem label="Save" accel="Cmd+S" onSelect={save} enabled={canSave} />
      <Separator />
      <MenuItem label="Sidebar" onSelect={toggleSidebar} checked={sidebarShown} />
      <MenuItem label="Settings…" accel="Cmd+," role="settings"
                onSelect={() => openWindow("settings")} />
      <MenuItem label="Quit" accel="Cmd+Q" role="quit" onSelect={quit} />
    </Menu>

    <Tray tooltip="MyApp">
      <MenuItem label="Show" onSelect={showMain} />
      <MenuItem label="Quit" role="quit" onSelect={quit} />
    </Tray>
  </App>
);
```

Compile errors, each stated as a rule:

```
<App>{isPro && <Window/>}</App>
  -> a window kind cannot be conditional: the manifest is sized at build time.
     Declare it and gate openWindow("pro") instead.
<App><div/></App>            -> type error: App's children are SceneNode.
<Window><Window/></Window>   -> type error: Window's children are Element.
<App>{main}{main}</App>      -> windows/main declared twice.
```

`App`, `Window`, `Menu`, `MenuItem`, `Tray` are ordinary function components that return `SceneNode`s instead of `Element`s. They are erased exactly as function components are today (`jsx-runtime.ts:422`). Nothing named `App` or `Window` survives compilation. Scene children reject `false`/`null` explicitly — `flatten()` drops falsy children, which would silently swallow a conditional window.

### 2.3 `windows/main/window.tsx`

```tsx
/** @jsxImportSource dziri */
import { Window, Region } from "dziri/scene";
import { Rail } from "../../components/rail.tsx";

export default (
  <Window
    title="MyApp"          // static string. A signal title is a compile error
                           // until dziri_window_set_title exists (M13).
    width={1200} height={720}
    minWidth={880} minHeight={560}
    chrome="native"        // | "none" -> engine `decorated`; fixed at creation
    open                   // instantiated at launch
    onClose="quit"         // | "hide" | "destroy"
  >
    <body className="shell">
      <Rail />
      <Region name="sidebar"   className="pane rail" />
      <Region name="main"      className="pane content" />
      <Region name="inspector" className="pane inspector" />
    </body>
  </Window>
);
```

`name` is checked against `windows/main/regions/*` at compile time — a typo is a compile error naming the expected directory. A `<Region>` with no matching directory, or a directory with no `<Region>`, is an error and a warning respectively.

A window with no `<Region>` mounts plain markup and links no router code at all. Settings and tray popovers want this.

### 2.4 Generated manifest

```ts
// app.gen.ts (GENERATED)
export const APP = { quitOn: 0, singleInstance: 1, urlScheme: "myapp",
                     onLaunch, onQuit, onOpenUrl } as const;

export const WINDOWS = [
  { id: "main", title: "MyApp", width: 1200, height: 720,
    minWidth: 880, minHeight: 560, decorated: 1, open: 1, onClose: 2 /*quit*/,
    regions: 3, load: () => import("./windows/main/ui.gen.ts") },
  { id: "settings", title: "Settings", width: 520, height: 420,
    minWidth: 0, minHeight: 0, decorated: 1, open: 0, onClose: 0 /*hide*/,
    regions: 0, load: () => import("./windows/settings/ui.gen.ts") },
] as const;

// Flat menu table. Structure, labels, accelerators and roles are all static;
// `enabled` and `checked` are the only dynamic columns.
export const MENU = {
  parent:  new Int16Array([-1, -1, -1, -1, -1, -1]),
  label:   new Int32Array([ 0,  1, -1,  2,  3,  4]),
  accel:   new Int32Array([ 5,  6, -1, -1,  7,  8]),
  role:    new Uint8Array([ 0,  0,  1,  0,  2,  3]),
  command: [newDoc, save, null, toggleSidebar, null, quit],
  enabled: [null, canSave, null, null, null, null],
  checked: [null, null, null, sidebarShown, null, null],
};
```

```ts
// windows.gen.ts (GENERATED) — imports the runtime only, never app state,
// so it can never form a cycle with the modules that call openWindow.
import { openWindow as _open, closeWindow as _close, focusWindow as _focus } from "dziri/runtime";
export type WindowId = "main" | "settings";
export const openWindow  = _open  as (id: WindowId) => Promise<void>;
export const closeWindow = _close as (id: WindowId) => void;
export const focusWindow = _focus as (id: WindowId) => void;
```

`openWindow("setings")` is a compile error. Deleting `windows/settings/` breaks every call site rather than failing at runtime.

### 2.5 Lifecycle, stated exactly

- **create** — `openWindow(id)`: look up the row, `await row.load()` (first open only; Bun caches the module), `createUi()` for fresh tables, run the construction pass for that window, seed bindings/lists/patches once, `host.createWindow(config)`, `new Uploader(slot, ui)`, `uploadAll()`, register subscriptions against this window's dirty flag. Already open ⇒ focus. Singleton kinds make SwiftUI's `openWindow(value:)` dedupe free.
- **close** — the policy is a compiled integer, not a runtime policy object. `"hide"` retains the slot and tables (scroll, focus, list slots, string arena all survive; reopening is a raise). `"destroy"` disposes subscriptions, frees the slot's `Tables`/`LayoutTree`/`Surface`, drops the `CompiledUi`. `"quit"` runs the app-quit path.
- **Invariant: closing a window never touches app state.** Module-level signals in `state/` outlive every instance. Close only decides whether the *node table* survives. This is only safe because components are erased and state cannot hide inside them.
- **quit** — `quitOn` compiles to the loop's exit condition. `onLaunch`/`onQuit`/`onOpenUrl` are host-called at fixed points. There is deliberately no `useEffect` for app lifecycle: it is a small enumerable set of host moments, so it is props on `<App>`.

### 2.6 `ui.gen.ts` must become a factory

Today `ui.gen.ts` exports module-level mutable `const`s, and Bun's module cache makes them process-global. Destroy-then-reopen would resume the previous session's mutated string arena and relinked list nodes. The emitter must produce:

```ts
export function createUi(): CompiledUi { /* fresh typed arrays each call */ }
```

One call site changes in `src/app.ts`. This is a hard prerequisite for `onClose="destroy"`, not a nice-to-have.

### 2.7 What this costs

Multi-window means `Engine` becomes `Host { sdl, video, event_pump, measurer, painter, windows: Vec<WindowSlot> }`, one `sdl3::init()`, one shared `EventPump`, per-slot `Tables`/`LayoutTree`/`Surface`/`InputState`, `Event` gains a `window` field, and four new symbols (`window_create`, `window_destroy`, `window_raise`, `window_set_title`). Roughly 21 → 25 symbols plus a protocol bump. That reverses ROADMAP D2 and must be written into ROADMAP.md with its reasoning.

Until M13 lands: the compiler, the manifest and typed `openWindow` all work; opening a second kind throws a runtime error naming the roadmap item. The authoring shape is provable before the Rust cost is paid.

---

## 3. Routing

### 3.1 The pages-router premise is wrong for native — here is the corrected model

Both candidate router designs assumed a window has one active location, one `<Outlet/>`, and that the directory ancestor chain is the layout chain. That is the web's model. Every desktop application of consequence is **N concurrently visible, independently navigating regions**: Zed's Workspace→Pane→Item with per-pane history, VS Code's sidebar + editor groups + panel, Mail's folder/list/reading-pane, Finder's per-tab directory stack. The web reaches this shape only through Next's parallel routes (`@slot`) and intercepting routes (`(.)`), which are its two ugliest features and exist precisely to patch the case that is dziri's *default*.

So: **the unit of navigation is a region.** A window is a container for regions. `windows/<w>/regions/<r>/` is a file-based screen set scoped to one region. Everything else — file conventions, `hidden` activation, typed values, static matching — is unchanged and generalizes for free, because N regions are N disjoint node ranges of the same table.

This also relieves pressure on multi-window: a split region replaces a second window for most desktop cases.

### 3.2 File conventions (complete)

```
windows/main/regions/main/
  layout.tsx                 persistent wrapper, nests, receives `children`
  index.tsx                  "/"
  loading.tsx                shown while this scope's load() is pending
  error.tsx                  shown when this scope throws
  not-found.tsx              fallback for unmatched deep links in this scope
  settings.tsx               "/settings"        (file === folder/index)
  projects/
    layout.tsx               wraps every /projects/* screen
    index.tsx                "/projects"
    [id=uuid]/
      index.tsx              "/projects/:id"
      +screen.ts             GENERATED sibling: typed Args + data cells
      loading.tsx
      error.tsx
      [tab=projectTab].tsx   "/projects/:id/:tab"  — view state as a segment
  (dev)/inspector.tsx        "(group)" organises, contributes no segment
  _FileRow.tsx               leading "_" = not a screen, colocated component
  routes.gen.ts              GENERATED for this region
```

Segment forms: `[id]` (string), `[id=uuid]` (validator is `params/uuid.ts` exporting `parse`, resolved by module identity at build time), `[...rest]` (catch-all). Precedence static > typed > catch-all is resolved into switch ordering at compile time; nothing ranks at runtime.

Param matchers as *modules* beat a closed codec vocabulary: extensible with no `p.custom()` escape hatch, and named by the identity mechanism the compiler already has.

Escape hatch: `windows/<w>/regions/<r>/screens.ts` may export an explicit manifest onto the same internal screen-table IR, for plugin-contributed or generated screens. React Router 8's retreat from filename magic is direct evidence this should stay open; it costs nothing.

### 3.3 A screen file

```tsx
// windows/main/regions/main/projects/[id=uuid]/index.tsx
/** @jsxImportSource dziri */
import type { Args, Screen } from "./+screen.ts";
import { args, data } from "./+screen.ts";
import { db } from "../../../../../state/db.ts";
import { FileRow } from "../../_FileRow.tsx";
import { main, Screens } from "../../../../nav.gen.ts";

// The ONLY declarative export. No path. No params block. No search block.
// No pending/error fields — loading.tsx and error.tsx already said that.
export const screen = {
  title: "Project",
  keepAlive: 3,                 // cache 3 (id) instantiations
  deepLink: "focus-or-open",    // compiled into a flag bit
  // SYNCHRONOUS: not declared async, return type is not a Promise.
  // The compiler therefore emits NO promise cell, NO boundary node and NO
  // pending subtree for this screen — and `loading.tsx` beside it is an error.
  load: ({ id }) => db.project(id),
} satisfies Screen<Args>;

export default function Project() {
  return (
    <div className="page">
      <h1 className="title">{data.name}</h1>
      <p  className="meta">{data.fileCount} files · {args.id}</p>

      <div className="list">
        {data.files.map(
          (f) => <FileRow name={f.name} size={f.size} onClick={openFile} />,
          { key: (f) => f.id },
        )}
      </div>

      <button className="ghost" onClick={() => main.back()}>Back</button>
    </div>
  );
}

function openFile(f: { id: string }) {
  main.push(Screens.projectTab({ id: args.peek().id, tab: "files" }));
}
```

An async screen — and only an async screen — links the substrate:

```tsx
// .../[id=uuid]/[tab=projectTab].tsx
export const screen = {
  keepAlive: 1,
  load: async ({ id, tab }, signal) => api.tabData(id, tab, signal),
} satisfies Screen<Args>;
```

The generated sibling closes the recorder/return-type drift hole the audit flagged: `data` is typed *from* `load`'s inferred return type, so `data.nmae` is a type error rather than a wrong-looking frame.

```ts
// +screen.ts (GENERATED, gitignored)
import type { screen } from "./index.tsx";           // type-only: no runtime cycle
import { argCell, dataCell, type Cell, type Reactive } from "dziri/router";

export type Args = { id: string };
export type Screen<A> = {
  title?: string; keepAlive?: number;
  deepLink?: "focus-or-open" | "open" | "push";
  load?: (args: A, signal: AbortSignal) => unknown;
};
type Loaded = Awaited<ReturnType<NonNullable<typeof screen.load>>>;

export const args: Cell<Args>       = argCell(2 /* ScreenId */);
export const data: Reactive<Loaded> = dataCell(2);
```

`Reactive<T>` maps each leaf of `T` to `Cell<leaf>`, so `{data.name}` is legal in child position and `data.name * 2` is a compile error under the same rule that already rejects `style={{color: signal}}`.

### 3.4 Generated artifact

```ts
// windows/main/regions/main/routes.gen.ts  (GENERATED)
// 6 screens · 3 with args · 2 with load (1 async) · 1 boundary
// 412 nodes across all screens, 61 style slots (shared chrome interned once)

import { screen as S1 } from "./projects/index.tsx";
import { screen as S2 } from "./projects/[id=uuid]/index.tsx";
import { screen as S3 } from "./projects/[id=uuid]/[tab=projectTab].tsx";
import { parse as m_uuid }       from "../../../../params/uuid.ts";
import { parse as m_projectTab } from "../../../../params/projectTab.ts";

export const enum S { index=0, projects=1, project=2, projectTab=3, settings=4, notFound=5 }

/** Layout/ancestor chain. -1 = root. */
export const parent = new Int32Array([-1, -1, 1, 2, -1, -1]);

/** Flattened reveal chains (leaf first): node ids to un-hide on activation. */
export const chainStart = new Uint16Array([0, 1, 2, 4, 7, 8]);
export const chainLen   = new Uint8Array ([1, 1, 2, 3, 1, 1]);
export const chain      = new Int32Array ([12, 47, 96, 47, 231, 96, 47, 355, 380]);

/** bit0 hasLoad · bit1 loadIsAsync · bit2 hasError · bit3 deepLinkFocus */
export const flags     = new Uint8Array([0b0000, 0b0001, 0b0101, 0b0111, 0b0000, 0b0000]);
export const keepAlive = new Int32Array([0, 1, 3, 1, 0, 0]);

/** Boundary structure. -1 everywhere a screen is synchronous. */
export const boundary        = new Int32Array([-1, -1, -1, 231, -1, -1]);
export const boundaryContent = new Int32Array([-1, -1, -1, 232, -1, -1]);
export const boundaryPending = new Int32Array([-1, -1, -1, 289, -1, -1]);
export const boundaryError   = new Int32Array([-1, -1, -1, 301, -1, -1]);

/** Ancestor load chain, flattened at build time. Inner arrays run in parallel. */
export const loadPlan: readonly (readonly (readonly S[])[])[] = [
  [], [[S.projects]], [[S.projects], [S.project]],
  [[S.projects], [S.project], [S.projectTab]], [], [],
];

export const load = [null, S1.load, S2.load, S3.load, null, null] as const;

/** Typed constructors. A link is a struct, not an interpolated string. */
export const Screens = {
  index:      ()  => ({ screen: S.index,    args: EMPTY }) as const,
  projects:   ()  => ({ screen: S.projects, args: EMPTY }) as const,
  project:    (a: { id: string })                 => ({ screen: S.project,    args: a }) as const,
  projectTab: (a: { id: string; tab: "files"|"runs"|"settings" })
                                                  => ({ screen: S.projectTab, args: a }) as const,
  settings:   ()  => ({ screen: S.settings, args: EMPTY }) as const,
};

/**
 * Deep-link entry. Reached ONLY from the OS — never from in-app navigation,
 * which carries typed values and parses nothing. Generated switch, literal
 * compares, no matcher, no regex table, no ranking.
 */
export function parse(seg: readonly string[], out: Target): boolean {
  switch (seg.length) {
    case 0:
      out.screen = S.index; out.args = EMPTY; return true;
    case 1:
      if (seg[0] === "projects") { out.screen = S.projects; out.args = EMPTY; return true; }
      if (seg[0] === "settings") { out.screen = S.settings; out.args = EMPTY; return true; }
      return false;
    case 2: {
      if (seg[0] !== "projects") return false;
      const id = m_uuid(seg[1]!);
      if (id === null) return false;
      out.screen = S.project; out.args = { id }; return true;
    }
    case 3: {
      if (seg[0] !== "projects") return false;
      const id = m_uuid(seg[1]!);
      if (id === null) return false;
      const tab = m_projectTab(seg[2]!);
      if (tab === null) return false;
      out.screen = S.projectTab; out.args = { id, tab }; return true;
    }
    default: return false;
  }
}
```

```ts
// windows/main/nav.gen.ts (GENERATED)
import { region } from "dziri/router";
import * as R0 from "./regions/sidebar/routes.gen.ts";
import * as R1 from "./regions/main/routes.gen.ts";
import * as R2 from "./regions/inspector/routes.gen.ts";

export const sidebar   = region(0, R0);
export const main      = region(1, R1);
export const inspector = region(2, R2);
export { S, Screens } from "./regions/main/routes.gen.ts";

/** Adding or deleting a screen file breaks every dispatch site at compile time. */
export function titleFor(id: S): string {
  switch (id) {
    case S.index:      return "Home";
    case S.projects:   return "Projects";
    case S.project:    return "Project";
    case S.projectTab: return "Project";
    case S.settings:   return "Settings";
    case S.notFound:   return "Not found";
  }
}
```

Also emitted from the same table, so they cannot drift: `deeplink.plist.gen` (`CFBundleURLTypes`), `deeplink.reg.gen` (HKCU protocol handler), `deeplink.desktop.gen`.

### 3.5 Activation — the entire structural cost of a navigation

```ts
// src/runtime/router.ts
export function activate(ui: CompiledUi, r: RegionState, to: Frame): void {
  const from = r.frame;
  // Hide the outgoing divergent path, reveal the incoming one. `hidden`
  // excludes a node AND its subtree from layout, paint and hit-testing.
  for (let s = from.screen; s !== -1 && !onPath(to.screen, s); s = r.parent[s]!)
    for (const n of revealChain(r, s)) ui.nodes.hidden[n] = 1;
  for (let s = to.screen; s !== -1 && !onPath(from.screen, s); s = r.parent[s]!)
    for (const n of revealChain(r, s)) ui.nodes.hidden[n] = 0;
  r.frame = to;
  mark(Plane.STRUCTURE);
}
```

A layout shared by the outgoing and incoming screen is hidden then re-shown inside one tick; `Tables::commit()` memcmps and reports no change for it at all. **No node is created, moved or destroyed by navigation, ever.**

The stack is `Frame[]` per region, capped at 64: `{ screen: S, args: object, dataSlot: number }`. Args ride the frame, so back/forward replays exactly, and two regions can show the same screen with different args — which is what tabs, split panes and master-detail actually are.

`ref`s, focus and scroll survive because node ids never change.

### 3.6 What is runtime, and the ledger entries it adds

| Concern | Why it cannot be compile-time |
|---|---|
| Active frame + stack per region | It is the definition of navigation. The screen set, tree, chains, matching and decoders are all static; only the cursor is not. |
| Load completion time | It is I/O. But *whether* a screen has an async load is static, so a region of synchronous screens links zero promise cells. |
| OS-supplied deep-link string | The OS hands the process a string at a boundary whose scheme must be registered at build time. The parser is compiler-emitted code, not an interpreter. |

Three additions to NOTES.md's six-entry ledger. That is the honest price.

**Deliberately absent:** path matcher, route ranker, runtime tree walk, code-split resolver, `beforeLoad` context chain (a screen's context is a static field-access path), transitions. "Keep the outgoing screen up while the new one loads" is just *deferring one `hidden` byte write* — the thing `useTransition` fakes with concurrent rendering, obtained for free.

---

## 4. Reactivity & primitives

### 4.1 The core model

The retained tree is **not** a graph of JS node objects. It is the flat typed arrays in `ui.gen.ts`, memcpy'd into shared arenas and read by Rust. A binding is therefore not "an effect that mutates a node" — it is a **compiled write of one integer or one string into a statically known cell index**. This is strictly stronger than Solid/Svelte/Vapor, who must mutate real DOM nodes.

The compiler produces exactly three things: constant arena data, a finite named table of dynamic holes (each carrying its dependency ordinals and its dirty plane), and nothing else.

**Components run exactly twice in their entire lifetime** — once during `bun run compile` (producing the arena) and once at process start (producing the cells). Never per frame, never per navigation, never per state change. The construction pass is the runtime half of compilation.

**Four planes, derived not declared.** `STYLE_FIELDS[i][3]` (`affectsLayout`) already exists. `background` → PAINT. `width` → LAYOUT. Text → TEXT. `hidden`/list relink → STRUCTURE. Compose achieves phase separation only through developer discipline (`Modifier.drawBehind` vs `.background`); dziri derives it automatically and reports it in the compile stats line.

### 4.2 Before / after — one component

```tsx
// app/counter.tsx  (AUTHORED)
/** @jsxImportSource dziri */
import { signal, computed, effect, cn } from "dziri";

function Badge({ text }: { text: string }) {
  return <span className="badge">{text}</span>;
}

export default function Counter() {
  const count   = signal(0);                    // signal ordinal 0
  const doubled = computed(() => count.value * 2);  //          1
  const hot     = computed(() => count.value > 9);  //          2

  effect(() => console.log("count:", count.peek()));

  return (
    <div className={cn("counter", { hot })}>
      <Badge text="live" />
      <p className="readout">{count} clicks · {doubled} doubled</p>
      <button className="bump" onClick={() => count.value++}>bump</button>
    </div>
  );
}
```

```ts
// app/ui.gen.ts  (GENERATED) — 6 nodes, 4 style slots, exactly 2 dynamic holes
// No CSS, no selectors, no property names, no components, no state imports.
export const Plane = { PAINT: 1, TEXT: 2, LAYOUT: 4, STRUCTURE: 8 } as const;
export const signalCount = 3;
export const shapeHash   = "9f2c41b0";

/** Tail past index 1 is mutable: text bindings own their slots. */
export const strings = ["live", "bump", ""];

export const styles = {                    // interned over the VALUE VECTOR
  count: 4,
  bg:     new Uint32Array ([0, 0, 0, 4280756014]),
  fg:     new Uint32Array ([4293190887, 4288782762, 4293190887, 4294243573]),
  radius: new Float32Array([0, 999, 0, 6]),
  padT:   new Float32Array([12, 2, 0, 8]),
  /* …42 more fields */
};

export const nodes = {                     // CONSTANT. Never written at runtime.
  count: 6,
  kind:        new Uint8Array ([0, 0, 1, 0, 1, 3]),
  style:       new Uint16Array([0, 1, 1, 2, 2, 3]),
  text:        new Int32Array ([-1, -1,  0, -1,  2,  1]),
  parent:      new Int32Array ([-1,  0,  1,  0,  3,  0]),
  firstChild:  new Int32Array ([ 1,  2, -1,  4, -1, -1]),
  nextSibling: new Int32Array ([-1,  3, -1,  5, -1, -1]),
  list:        new Int16Array (6).fill(-1),
  hidden:      new Uint8Array (6),
};

/** THE ONLY DYNAMIC THINGS IN THE PROGRAM. */
export const bindings = [
  { id: 0, plane: Plane.TEXT, node: 4, slot: 2, deps: [0, 1],
    read: (s) => `${s[0].value} clicks · ${s[1].value} doubled`,
    debug: "counter.tsx:16 {count} clicks · {doubled} doubled" },
];

export const patches = [
  { id: 1, plane: Plane.PAINT, deps: [2],
    entries: [{ field: "bg", slots: new Uint16Array([0]),
                on: new Float64Array([4281479738]), off: new Float64Array([0]) }],
    debug: "counter.tsx:15 .hot" },
];

export const effects      = [{ id: 0, gate: -1, debug: "counter.tsx:12" }];
export const handlerSites = new Int32Array([5]);   // node ids carrying onClick
export const root = 0;
```

What happened, precisely:

- **`Badge` is gone.** It contributed `nodes[1..2]` and `strings[0]`. Zero bindings, zero records, zero steady-state cost. A subtree with no bindings is *constant data*. This optimization is available only because the set of dynamic holes is a first-class static artifact — a recomposition model deliberately erases that distinction.
- **`props.text` is gone.** It was a build-time argument.
- **Five JSX children collapsed to one node, one string slot, one generated closure.** The author wrote interpolation; the compiler emitted `read`.
- **Signals are named by ordinal (`s[0]`), not by import.** `ui.gen.ts` imports no app module. This is what deletes NOTES.md:587.

### 4.3 The construction pass

```ts
// src/runtime/construct.ts
import { setCompiling, setListBuilder, setConstructing } from "dziri/internal";
import { buildList } from "dziri/compiler/jsx-runtime";

export function construct(entry: () => Element): Live {
  const signals: Cell<unknown>[] = [];
  setCompiling(true);            // .value on arrays yields the recording proxy
  setListBuilder(buildList);     // signal.map() throws without this
  setConstructing(signals);      // signal()/computed()/resource() push their ordinal
  const tree = entry();          // components run for the SECOND and LAST time
  setConstructing(null);

  const handlers = new Map<number, Fn>();
  const refs: Ref[] = [];
  walkInEmitOrder(tree, (el, nodeId) => {          // same pre-order the emitter used
    if (el.onClick) handlers.set(nodeId, el.onClick);
    if (el.ref) { el.ref.node = nodeId; refs.push(el.ref); }
  });
  return { signals, handlers, refs };               // tree is dropped
}
```

Be honest about what this costs, because the design's original claim was wrong:

1. It **ships the JSX runtime, `item-path.ts`, `flatten`/`normalize`/`cn`/`styleAttr` to the runtime.** `jsx-runtime.ts:8` ("nothing here ships to the runtime") is downgraded to "nothing here reaches the IR." Acceptable for a desktop process; there is no bundle-size budget, only a startup CPU cost.
2. It **allocates one `Element` per node at startup**, transiently. "A zero-binding subtree costs nothing forever" is true in steady state and in peak RSS after GC — not at startup. Say so in the docs.
3. It must run in the **same mode** as the build pass (`compiling = true`, compiler list builder), or the two evaluations take different branches with identical signal counts — a hash collision by construction.
4. `shapeHash` is a structural hash over (node count, tag sequence, binding sites, signal ordinals), not a count. Divergence is a **hard startup abort naming the first diverging ordinal**. Never a warning.

`resolve-refs.ts` is deleted except for the app-manifest identity lookup.

### 4.4 The scheduler

```ts
// src/runtime/scheduler.ts
const Q: Binding[][] = [[], [], [], []];   // PAINT, TEXT, LAYOUT, STRUCTURE
let planes = 0;
export const changedNodes: number[] = [];

export function attach(gen: Generated, live: Live) {
  for (const b of [...gen.bindings, ...gen.patches, ...gen.branches])
    for (const d of b.deps) live.signals[d]!.subscribe(() => enqueue(b));
}

function enqueue(b: Binding) {
  if (b.queued) return;                    // one enqueue per binding per frame
  b.queued = true;
  Q[log2(b.plane)]!.push(b);
  planes |= b.plane;
}

export function flush(ui: CompiledUi, live: Live): number {
  for (const b of Q[3]!) applyStructure(ui, b, live);   // lists, Show, boundaries
  for (const b of Q[2]!) writeCell(ui, b, live);        // layout-affecting styles
  for (const b of Q[1]!) {                              // text
    const next = b.read(live.signals);
    if (ui.strings[b.slot!] !== next) { ui.strings[b.slot!] = next; changedNodes.push(b.node!); }
  }
  for (const b of Q[0]!) writeCell(ui, b, live);        // paint-only styles
  for (const q of Q) { for (const b of q) b.queued = false; q.length = 0; }
  const mask = planes; planes = 0;
  return mask;
}
```

Signal write → `computed` invalidation still fires **synchronously** (`signal.ts:62` documents why: skipping it double-notifies). Binding subscribers only *enqueue*. The flush happens at the frame boundary, not in a microtask, because dziri owns the loop. `batch()` therefore stops being a correctness requirement and becomes a coalescing convenience — one user action costs one frame by construction. The two propagation timings are a permanent, deliberate split and must be tested.

This replaces `bindings.ts:54`'s admitted "one callback for the whole document," which re-evaluates every text binding on any signal change. Correct at 126 nodes; wrong at 10k.

### 4.5 Engine changes for planes

```rust
// engine.rs tick()
let diff  = self.tables.commit();
let plane = self.tables.plane_mask();               // NEW: read from control span
self.resync(&diff, plane)?;

let geometry = plane & (LAYOUT | TEXT | STRUCTURE) != 0;
if self.fresh || (diff.any && geometry) {
    self.tree.compute(...)?;                        // was: if self.fresh || diff.any
    self.needs_paint = true;
} else if diff.any {
    self.needs_paint = true;                        // paint-only: Taffy never hears
}
// resync(): skip apply_style entirely when plane == PAINT.
```

| Plane | Bun writes | Taffy | Skia |
|---|---|---|---|
| PAINT | style cells | **untouched** | repaint damage |
| TEXT | `strings[slot]` | `mark_dirty(node)` only | repaint damage |
| LAYOUT | style cells | `apply_style` on nodes wearing changed slots | repaint damage |
| STRUCTURE | child chain / `hidden` | rebuild or scoped restyle | full repaint |

Two bugs must be fixed alongside: `engine.rs:311` responds to `diff.node_styles` with `apply_all_styles()`, so flipping one `hidden` byte triggers an O(n) restyle — and `Show`, `Suspense`, error boundaries and every navigation ride on `hidden`. The diff must carry changed-hidden node ids. And `paint.rs` clears and repaints the whole surface, so until damage rects land the PAINT plane saves Taffy but saves Skia nothing. Do not claim otherwise.

### 4.6 Primitives — every ruling

| Primitive | Ruling | Compiled form |
|---|---|---|
| `useState` | **keep, redesigned** → `signal()` | JS object + entry in `s[]` by creation ordinal. Creatable anywhere — in a branch, a loop, a helper. **Mandatory guard:** `.value` read at construction scope with no active `listener` throws. |
| `useEffect` | **keep, redesigned** → `effect()` | Registered at construction, runs post-commit at the frame boundary, at most once per frame. Auto-tracked, **no dep array**. Emits `{ id, gate: nodeId \| -1 }`; effects under a closed `hidden` subtree do not run. |
| cleanup | **keep** (new) | `effect(() => { const t = setInterval(…); return () => clearInterval(t) })`. Three compile-time scopes: window, gate (the enclosing `hidden` node), explicit `dispose()`. |
| `untrack` / `peek` | **keep** (new) | `sig.peek()` reads `current` without consulting the `listener` global; `untrack(fn)` nulls it for the duration. No compiled artifact — "is this read tracked" is a property of the reading code. |
| `useLayoutEffect` | **reject for v1** | `tick()` is `layout → write_bounds → draw → present` in one call, so any callback after it has `useEffect` timing. Shipping it as `afterLayout` would promise a guarantee it does not provide. Only `ref.bounds()` exists, documented as **one frame stale**. Unblocked by M9. |
| `useMemo` | **compile-away** / `computed()` | Pure-of-constants folds at build. Signal-derived is `computed`, which is lazy, cached, and `Object.is`-short-circuited. The dependency array is rejected outright — it is a manual approximation of tracking that is real here. |
| `useCallback` | **reject** | Handler identity is a compile-time constant: `handlers` is a fixed table keyed by node id. Nothing re-creates a handler because nothing re-runs a body. |
| `React.memo` | **reject** | Nothing renders. No output to memoize, no runtime props to compare. |
| `useRef` (box) | **compile-away** | A plain `let` in the component closure. Bodies run once, so it already survives. |
| `useRef` (handle) | **keep, redesigned** → `ref()` | A compile-time integer: `panel.node === 37`. `.bounds()` reads the bounds arena (last frame). `.focus()` calls `engine.setInputState`. No `.current`, no null state, no commit phase. |
| `forwardRef` / `useImperativeHandle` | **reject** | A ref is an integer resolved at build; props are build-time arguments, so a component can accept or return one directly. There are no instances to fake an API for. |
| `useContext` | **compile-away entirely** → `token()` | Provider/consumer chain is statically known because the tree is. A static value inlines into the style or string table; a signal value degenerates into an ordinary binding. A value that is neither is a compile error. Runtime artifact: **none**. Renamed to break React expectations — it is lexical build-time scoping, nothing more. |
| `Suspense` | **keep, redesigned** | Two materialized sibling subtrees + complementary `hidden` bytes. `boundaries = [{kind, content, fallback}]` is compile-time. The **source set is not**: a binding's deps are opaque signal objects and `computed` capture is dynamic, so pending propagates transitively at runtime via one extra bit beside `stale`. Nothing is thrown. `refetch()` sets `"stale"`, not `"pending"`, so stale-while-refetching is free. |
| Error boundary | **keep, redesigned, narrowed** | "Render threw" is now a compile error. Catches handler / effect / `load` throws only. Two compile-time maps: `nodeBoundary` (interactive node → boundary, for dispatch) and `bindingBoundary` (binding → boundary, for **gating** — otherwise a failed subtree's bindings keep throwing once per frame forever). A trip runs cleanup for every gated effect. **Engine panics take a separate, explicitly non-recoverable path** — `panic = "unwind"` plus a dead window is worse than an abort with a diagnostic. |
| `useTransition` / `useDeferredValue` | **reject** | Solid implements them by cloning the reactive graph and dual-rendering. Both trees are already in the arena, so the payoff is free. One-way door, taken deliberately: forking is harder with intrusive dep lists. |
| `createPortal` | **keep, redesigned** → `<Overlay>` | `layer: Uint8Array` per node, compile-time constant; painter sorts by (layer, tree order). **Not ~30 lines:** `paint.rs:244` `hit_test` prunes on parent bounds, so an overlay outside its parent's box paints and cannot be clicked. Requires a bounds-rooted traversal, cross-layer focus order, and an Escape policy (`src/window-host.ts:277` hardcodes a global clear). |
| `key` | **keep as-is** | Already mandatory — a type error *and* a compile error (`jsx-runtime.ts:36`). The key **function** compiles to an `ItemPath`; the key **values** are runtime, already in the ledger. Load-bearing because focus is a node id. The one React primitive that transfers intact, and it transfers because it was never about reconciliation. |
| `Fragment` | **compile-away** | Already does: `"#fragment"` spliced out by `flatten()`. Zero nodes. |
| Custom hooks | **keep** — call them **factories** | Plain build-time functions. There are no rules of hooks; the problem does not get solved, it ceases to exist. Two documented constraints: a factory called conditionally runs once for whichever branch was live at construction (the compiler rejects state creation under a *signal-valued* predicate), and factories must return signals, never values. |
| `useSyncExternalStore` | **keep, redesigned** → `source()` | `source(subscribe, initial)`: a signal whose writer is external (file watcher, OS theme change, websocket, child-process stdout, tray events), whose unsubscribe registers in the owning disposal scope. More common in a desktop app than Suspense, and entirely missing today. |
| per-frame callback | **keep** (new) → `onFrame(dt)` | Registered in the window scope, invoked between `drainEvents` and the next upload. **Deliberately not routed through the signal graph** — a drag writes style cells directly and marks PAINT, the same way animation records do. Propagating a signal per node per frame at 120 Hz is the failure mode Compose and Flutter both avoid. |
| Controlled input | **keep, redesigned** | `bindValue` is append-and-backspace (`src/window-host.ts:274` handles two keycodes). Replace with: the engine reports the **intended** edit, Bun decides the resulting string. Requires a node-scoped caret/selection model plus Home/End/arrows/Delete/Ctrl-A/C/V. ROADMAP defers *rich* text; plain-text editing cannot be deferred with it. |
| `useReducer` | **compile-away** | `const state = signal(init); const send = a => state.value = reduce(state.value, a)`. Userland. |
| `batch` | **keep** | Retained as an opt-in coalescer; the frame-boundary flush subsumes its repaint role. |
| `flushSync` | **reject** | There is no synchronous surface to read back; reading bounds synchronously is the layout-phase problem, not a batching problem. |
| List windowing | **keep** (new), blocked | A windowed list is an arena of `visibleCapacity` slots plus a scroll-offset signal; the runtime rebinds slot *i* to item *(offset + i)* — a slot rewrite the arena already does for reorders, with no structural change. Must be designed now so stride and relink semantics never change. Blocked on clipping. |
| `StrictMode` | **reject the concept, ship the check** | The construction pass *is* the purity check: comparing it to the build pass catches exactly the impurity that matters. `shapeHash` mismatch = hard abort. |

### 4.7 Semantic breaks from React that users MUST know

1. **A signal is a live cell, not a per-render snapshot.** With run-once bodies, `const doubled = count.value * 2` compiles to `0` and never updates — correct on frame one, frozen forever, silent. **This is the single biggest trap in the design** and the guard is non-negotiable: `signal.ts` gets a `constructing` flag and the `.value` getter throws when `constructing && listener === null`, with the message *"reading .value during construction captures a dead snapshot; wrap it in computed() or interpolate the signal itself."* ~4 lines using the `listener` global that already exists at `signal.ts:48`. Without it, `useState`-as-signal should not ship.
2. **Component bodies never re-run.** Props are build-time arguments. A prop is not reactive unless it *is* a signal. `if (count.value > 3) return <A/>` picks a branch permanently at startup.
3. **Nothing unmounts.** `hidden` retains. An effect under a hidden panel keeps running unless gated, and its subscriptions leak unless it has cleanup. Because `hidden` is the mechanism behind `Show`, Suspense, error boundaries *and* every navigation, this is the default case.
4. **No rules of hooks — but a conditional factory runs once**, for whichever branch was live at construction, and nothing re-evaluates the predicate.
5. **Context is lexical build-time scoping.** No dynamic provider selection. A value that is neither static nor a signal is a compile error.
6. **You cannot throw to suspend.** Only a declared `load` can pend; there is no body to re-enter.
7. **Error boundaries do not catch render errors** — that class is now a compile error. They catch handler, effect and `load` throws.
8. **`ref.bounds()` is one frame stale** until the layout/paint split lands. Measure-then-position flickers one frame.
9. **Every conditional branch is materialized.** Node count scales with total UI, not visible UI. The compiler reports the materialized/live ratio and warns past a threshold.
10. **Per-row state must be data in the array.** Signals can only be created during the construction pass. `app/state.ts`'s `mark` computed already models this correctly.

---

## 5. Compiler pipeline

| Stage | Input | Work | Artifact |
|---|---|---|---|
| **0 · protocol** | `src/protocol/schema.ts` | codegen both sides | `src/protocol/generated.ts`, `protocol.rs` |
| **1 · discover** | `windows/*/window.tsx`, `windows/*/regions/*/**`, `params/*.ts` | glob; filename grammar → screen tree (static > typed > catch-all ordering fixed here); resolve `[x=matcher]` to a module by identity; assign `ScreenId`s | **types first:** `windows.gen.ts`, per-screen `+screen.ts`, `routes.gen.d.ts` stubs — so screen files typecheck before they are imported |
| **2 · evaluate** | `app.tsx`, `window.tsx`, every screen module | `setCompiling(true)` + compiler list builder; `await import(fileURL)`; Bun's JSX transform expands components against `jsx-runtime.ts`; `<App>`/`<Window>`/`<Region>` return `SceneNode`s; screens splice into their region's mount, wrapped in their layout chain | in-memory `Element` tree per window + the manifest object graph |
| **3 · cascade** | `app.css ++ windows/<w>/window.css` | hand-written parser (`css.ts`), specificity, inheritance, shorthand expansion → 46 fields/node; intern over the **value vector**; emit variants for `:hover`/`:active`/`:focus` and combinations, and for conditional classes | style table + variant table + patch entries |
| **4 · analyze** | tree + style table | text bindings; style patches; tier-4 cell bindings (**de-intern any written slot** — interning is over the value vector, so a shared slot silently restyles unrelated nodes); plane per hole from `STYLE_FIELDS[i][3]`; reveal chains; boundaries + `nodeBoundary` + `bindingBoundary`; effect gates; `layer` per node; animation records; `loadPlan`; `signalCount` + structural `shapeHash` | the binding/patch/boundary/effect tables |
| **5 · emit** | everything | one node table per window containing every screen of every region | `windows/<w>/ui.gen.ts` (factory-form), `regions/<r>/routes.gen.ts`, `nav.gen.ts`, `app.gen.ts`, `windows.gen.ts`, `deeplink.{plist,reg,desktop}.gen` |
| **6 · construct** *(runtime, startup)* | the same `.tsx` modules | second evaluation; harvest signals by ordinal, handlers by node id, refs; abort on `shapeHash` mismatch | `Live { signals, handlers, refs }` |
| **7 · attach** | `Generated` + `Live` | per-binding subscription into the four plane queues; window-scoped disposal owner | wired graph |
| **8 · run** | — | `flush() → upload touched spans + plane mask + changedNodes → engine.tick() → drainEvents()` | frames |

`bun run compile --window main` compiles one window; without it, evaluating `app.tsx` pulls in every window's tree and build time scales with the whole app on a one-window edit.

Style tables stay **per window**. Style indices are per-`Tables` in the engine and every node's style pointer is relative to its own window's table; unifying them touches the protocol, the uploader and `grow()`.

---

## 6. Build order

Ordered by what unblocks the most. Effort marked where it is large.

**M0 — Correct the record.** Fix `MEMORY.md`/`skia-proto-architecture.md` (there *is* a Rust runtime). Add `CLAUDE.md` carrying: compile-time-first, the module-level-export rule *and its scheduled deletion*, the `.value` scalar limitation, the MSVC 14.4x floor, and the two-language boundary. Write the D2 reversal into ROADMAP.md with reasoning.
*Done when:* a fresh agent reading only `CLAUDE.md` correctly scopes an engine change.

**M1 — Plane mask end to end.** Stop discarding `Dirty` in `src/window-host.ts:80-93`. Add `plane` to `schema.ts`, regenerate, read it in `tick()`, gate `tree.compute` on `geometry`, skip `apply_style` when `plane == PAINT`.
*Done when:* toggling `.light` on the demo produces **zero** Taffy `compute` calls (assert via a counter exposed through `describe`), and a unit test proves every `STYLE_FIELDS` entry's plane matches its `affectsLayout` tag.

**M2 — Fix `hidden` in the engine diff.** `Diff` carries changed-hidden node ids; `resync` restyles that subtree instead of calling `apply_all_styles()`.
*Done when:* flipping one `hidden` byte on a 3,000-node tree touches O(subtree) styles, measured, not O(n).

**M3 — Compiler emits `hidden`.** `<Show when={sig}>` materializes both branches with complementary bytes. This is the substrate for Suspense, error boundaries and the entire router.
*Done when:* a `Show` toggle writes 1 byte, re-uploads no node arrays, and reports `Plane.STRUCTURE`.

**M4 — Multi-entry compiler + host.** `<App>` manifest, `windows.gen.ts`, `createUi()` factory emission, host stops hardcoding one `ui.gen.ts` import.
*Done when:* an `app.tsx` with two `<Window>` kinds emits two `ui.gen.ts`, the host runs the `open` one, `openWindow("settings")` throws naming M13, and `{cond && <Window/>}` fails compilation with the stated message.

**M5 — Construction pass.** *Large.* `constructing` recorder, signal ordinals, node-id handler harvesting, `ref` resolution, structural `shapeHash`, the `.value`-at-construction guard, deletion of `resolve-refs.ts`'s signal/handler path.
*Done when:* the todo demo compiles with **no `state.ts`** and all state declared inside components; `const x = count.value` at construction throws the exact message; a deliberately nondeterministic body aborts at startup naming the diverging ordinal; startup cost is measured and published.

**M6 — Effects, properly.** Dep-set clear-and-recollect (intrusive doubly-linked lists, not per-signal `Set`s — `signal.ts:86,159` add subscribers on read and never remove them, so conditional deps accumulate without bound); `peek`/`untrack`; cleanup; gates; re-entrancy counter aborting with the effect's `debug` string.
*Done when:* `effect(() => a.value ? b.value : c.value)` has a dep set of size 2, not 3, after both branches have run; an effect under a closed `Show` does not run and its cleanup fired when the `Show` closed; a self-writing effect aborts instead of spinning the loop.

**M7 — Regions + screens router.** Discovery, `+screen.ts` generation, reveal chains, typed `Screens` constructors, per-region frame stacks, generated `parse`, OS registration files.
*Done when:* `parse(["projects", uuid])` returns a target with no allocation beyond the args object; a sibling navigation writes ≤3 `hidden` bytes; deleting a screen file breaks `titleFor` at compile time; two regions simultaneously display the same screen with different args; the emitted `.plist`/`.reg`/`.desktop` match the screen table byte for byte.

**M8 — `resource`, `source`, Suspense, error boundaries.** Runtime pending propagation bit on `computed`; `bindingBoundary` gating; separate abort path for engine panics.
*Done when:* a synchronous `load` emits zero boundary nodes and zero promise cells, `loading.tsx` beside it is a compile error, and a thrown handler shows the nearest `error.tsx` while every binding in the failed subtree stops evaluating.

**M9 — Engine owns the frame loop, and `tick()` splits.** A0 step 3, plus `engine_layout()` / `engine_paint()` with post-layout callbacks between them and a 2-pass re-layout budget.
*Done when:* a 500 ms busy loop in Bun does not stall window resize, and `onMeasure` reads this frame's bounds and repositions before present — verified by a tooltip that never flashes at the wrong position.

**M10 — Clipping, damage rects, overflow, scrolling, list windowing.** *Large.* `overflow` and `lineClamp` into `STYLE_FIELDS` (the protocol already declares both), `clip_rect` in `paint.rs`, `changedNodes` → damage union, windowed list arenas.
*Done when:* a caret blink repaints one rect instead of the surface; a 50k-row list scrolls at 120 Hz with a fixed `visibleCapacity`; text overflowing a fixed-width box ellipsizes.

**M11 — Overlay layers.** `layer` per node, painter sort, **`hit_test` rewritten** to test layers descending without parent-bounds pruning inside overlay subtrees, cross-layer focus order, Escape-to-dismiss policy replacing `src/window-host.ts:277`.
*Done when:* a dropdown anchored below a 24 px-tall parent, extending 200 px past its bounds, is clickable on every item and dismisses on Escape without clearing unrelated input state.

**M12 — Real text input.** *Large.* Node-scoped caret and selection in the engine input state; the engine reports intended edits, Bun decides the string; Home/End/arrows/Delete/Ctrl-A/C/V.
*Done when:* a controlled `<input>` can reject a keystroke, format as you type, and survive a list reorder with the caret intact.

**M13 — `Engine` → `Host`, N windows.** *Large Rust.* One `sdl3::init()`, shared `EventPump` and `Measurer`, per-slot `Tables`/`LayoutTree`/`Surface`/`InputState`, `Event.window`, `window_create`/`destroy`/`raise`/`set_title`, protocol bump.
*Done when:* two windows are open, each with independent regions and dirty flags; a shared signal written from one repaints both and repaints neither more than once; closing the settings window with `onClose="hide"` and reopening restores its focus and scroll.

**M14 — Native menus and tray.** *Large, three platform code paths* (NSMenu, Win32 HMENU, GTK/AppIndicator). Plausibly the largest unbudgeted item in this document. The manifest table is cheap; the binding is not. Do not ship the table without at least one platform binding.

**M15 — Compiled transitions.** Animation records `(slot, field, from, to, duration, easing)` interpolated in Rust inside the engine loop, between two precomputed variant slots. No JS runs at 120 Hz and no signal propagates per frame.
*Done when:* `transition: background 150ms` on a `:hover` rule animates with zero Bun wakeups during the animation.

**M16 — HMR over the construction pass.** Recompile → new `ui.gen.ts` → re-run construction → match signals by ordinal, carry values where `shapeHash` matches, `uploadAll()`.
*Done when:* editing a colour preserves counter state; editing the signal set resets it loudly with a named diff.

---

## 7. Open risks, ranked

1. **Construction-pass determinism.** The whole component model rests on the build evaluation and the startup evaluation producing identical shapes. A component body branching on a date, a random, an env read, or a subtly different `compiling` mode diverges. `shapeHash` catches it *only if* the hash is structural, and the failure must be a hard abort naming the ordinal. If this proves flaky in practice, the fallback is reinstating module-level exports — a redesign of the authoring surface, not a patch.

2. **Both-branches-materialized versus node count.** `Show`, `Suspense`, error boundaries and every screen of every region all live permanently in one node table. Fine for a handful of screens per region; a 50-screen region with nested conditionals multiplies. Today's demo is 126 nodes / 18 KB; the ratio is unmeasured at scale. If it breaks, the fix is per-screen tables plus an engine table swap through `grow`/re-describe — which has never been driven that way and would change the router's cost model entirely.

3. **Clipping is a prerequisite masquerading as a milestone.** `STYLE_FIELDS` has no `overflow`, `paint.rs` never clips, `hit_test` prunes on parent bounds. Therefore: no scrolling, no ellipsis, no overlay layering, and **modals are unbuildable**. A router ships the concept of a screen, and a screen that exceeds its region spills into nothing. Shipping M7 before M10 produces a demo, not a feature.

4. **De-interning is a silent correctness trap.** Interning is over the value vector, so if the compiler forgets to un-share a slot that a tier-4 binding writes, changing one node's width changes every unrelated node that happened to intern identically. This needs a test in `upload.test.ts` *before* the feature ships.

5. **Plane derivation is only as good as `affectsLayout`.** `borderWidth` is currently tagged paint-only on the reasoning that borders stroke inset — true today, wrong the moment `box-sizing` or `outline` lands. A mis-tagged field produces a stale layout: a wrong-looking frame, not a crash. Same failure class as a wrong byte offset, and it deserves the same rule: derive, never restate.

6. **Effect leaks with FFI-backed resources downstream.** Module-level signals dodge disposal entirely; effects do not. With Skia paints, pictures and shaped paragraphs behind the boundary, a leaked subscription is far more expensive than in the DOM. Three disposal scopes (window / gate / explicit) must land *with* effects, not after — retrofitting onto a closure-captured graph is exactly the pain the prior art warns about.

7. **The multi-window Rust refactor is real work on an explicitly cut item.** ROADMAP risk #9 already warns that two languages raise the contribution bar. The authoring shape is provable without it, which is the mitigation — but if M13 slips indefinitely, `<App>` with multiple `<Window>` kinds is a declared feature that throws.

8. **Native menus and tray are three platform bindings.** The manifest is cheap and looks done. Shipping the table without a binding leaves a feature that compiles and does nothing.

9. **Two JSX grammars in one syntax.** Scene elements and node elements are mutually illegal, enforced by typing `App`'s children as `SceneNode` and `Window`'s as `Element`. That is real conceptual weight, and authors will reasonably expect JSX to be conditional — so the `{cond && <Window/>}` error message is load-bearing documentation, not a nicety.

10. **Generated-artifact staleness.** Four generated files per window plus OS registration files, with `+screen.ts` needing to exist before typecheck. A fresh clone does not typecheck until `bun run compile` has run once. This wants a `bun run gen` step wired into `postinstall` and a watcher that regenerates reliably on add, rename *and* delete — the repo has no watcher, no dev server and no hot reload today.

---

# Appendix A — Scouting

Three agents ran in parallel: one read the actual repository, one researched
reactivity models for compiled/no-VDOM frameworks, one researched file-based
routers and native multi-window app models.

### Scout 1

Two conclusions dominate the prior art.

**Routers.** The industry has converged on: filesystem = *discovery* mechanism; a generated static manifest = the real artifact; generated sibling types = the type-safety mechanism. React Router 8 explicitly retreated from filename magic to an explicit `app/routes.ts` config (`route()/index()/layout()/prefix()`), demoting file conventions to an opt-in plugin (`@react-router/fs-routes`). SvelteKit and React Router both put types in generated sibling files (`$types`, `./+types/team`) so route modules stay plain — no ceremony. TanStack Router's `createFileRoute('/posts/$postId')` ceremony exists *only* because TanStack has no compiler: it needs a runtime object carrying a literal path so `declare module` augmentation can hang types off it. `routeTree.gen.ts` is a manifest + `FileRoutesByFullPath/ByTo/ById/FileRouteTypes` interfaces + `rootRoute._addFileChildren(...)._addFileTypes<...>()` — but matching is still runtime. skia-proto has a compiler, so it can pay none of that tax and go further: emit numeric route IDs and a static match table, not a runtime matcher. What TanStack has that filenames cannot conjure is *validated typed search/params* and loader dependency graphs — that is the part worth stealing.

**Windows.** Every serious native model declares a **closed static set of window/scene kinds** and lets *instances* be dynamic. SwiftUI: `App.body: some Scene` over a fixed scene vocabulary (WindowGroup, Window, Settings, MenuBarExtra, DocumentGroup); `WindowGroup(for: Note.ID.self)` keys instances by a value that must be `Hashable` (dedupe/focus-existing) + `Codable` (state restoration). Tauri: static `app.windows[]` with `label` + `create`. Flutter's 2026 multi-window is still flag-gated (`RegularWindowController` + `runWidget(RegularWindow(...))` — window as widget node + controller). Electron is the negative case: `BrowserWindow` is a purely runtime imperative object, one process per window, IPC-serialized state, nothing statically known.

**The key question.** A per-window *URL router* is the wrong substrate. Natively the source of truth is a typed navigation **stack of route values** (SwiftUI `NavigationPath` + `navigationDestination(for:)`, React Navigation's nested state tree) — no URL anywhere. Expo Router is the experiment that proves the leak: it makes URL primary over React Navigation and users hit exactly the seams (setParams doesn't push history, arbitrary back-stacks are hard, query params corrupt history). Path strings earn their keep only as a **serialization format** for deep links and session restore — and even that is compile-time-friendly, since URL schemes must be registered at *build* time (Info.plist, Windows registry) and cannot change at runtime.

**TanStack Router: what codegen actually produces (and why the ceremony exists)**

A route file exports `export const Route = createFileRoute('/posts/$postId')({ loader, validateSearch, component })`. The bundler plugin regenerates `routeTree.gen.ts` on file add/rename/delete, containing: concrete imports of every route module, route objects with `path`/`id`/`getParentRoute`, four interfaces (`FileRoutesByFullPath`, `FileRoutesByTo`, `FileRoutesById`, `FileRouteTypes`), a `declare module '@tanstack/react-router' { interface FileRoutesByPath { ... } }` augmentation, and `export const routeTree = rootRouteImport._addFileChildren(...)._addFileTypes<FileRouteTypes>()`. It is committed to git because it is runtime code, not a build artifact. Crucially: the generated file is a *manifest*, not a matcher — path matching, param extraction and route resolution all still happen at runtime in the router core.

> *Implication:* The literal path string argument to `createFileRoute` is pure compensation for having no compiler — it is the only way to bind a filesystem fact into the TS type system. skia-proto MUST NOT copy it. With a real compiler the route table becomes a static array indexed by a numeric RouteId, param extraction becomes a generated destructure per route, and matching for the common (static-segment) case collapses to a generated switch or perfect hash. Runtime pattern matching should exist only for routes that actually have dynamic segments.

**React Router 8 retreated from file-based conventions to an explicit config file**

Framework mode now defines routes in `app/routes.ts` with `route(pattern, module, children?)`, `index(module)`, `layout(module, children)` (nesting without a URL segment), and `prefix(str, children)` (URL segment without a parent module). File-based conventions are opt-in: `import { flatRoutes } from '@react-router/fs-routes'; export default [route('/', './home.tsx'), ...(await flatRoutes())]`. Config and file conventions can be mixed. Types are generated per-route into `./+types/<name>` and consumed as `import type { Route } from './+types/team'` giving `Route.LoaderArgs` (typed `params`) and `Route.ComponentProps` (typed `loaderData` + `params`).

> *Implication:* The team with the most routing scar tissue concluded that an explicit, statically-analyzable route table is the primary artifact and the filesystem is one optional producer of it. Design skia-proto the same way: define an internal route-table IR; `windows/main/pages/` is the default front-end that emits it; leave an escape hatch (an explicit route manifest) for generated routes, plugin-contributed screens, and dynamic-at-build-time route sets. This also removes the 'my file layout can't express my nav structure' dead end — which is a much bigger problem for a desktop app than for a website.

**SvelteKit and React Router both put types in a generated SIBLING file, not in the route module**

SvelteKit generates `.svelte-kit/types/**/$types.d.ts` exposed via the `$types` alias; the route module is a plain `+page.svelte` plus an optional `+page.ts` exporting `load`. Typed props come as `PageProps`/`LayoutProps`, load functions as `PageLoad`/`PageServerLoad`. React Router does the same via `.react-router/types` and `./+types/<route>`. Neither requires the route module to call a registration function or restate its own path. SvelteKit additionally has *param matchers*: `src/params/integer.ts` exporting a `match` predicate, used as `[id=integer]` in the directory name — a filename-level, statically-known validator.

> *Implication:* This is the cleanest answer to the user's open question 3 and it is not (a)-vs-(b) binary. Take Next/SvelteKit-style plain modules (zero boilerplate, no path restated) and get TanStack-grade types from generated siblings. The compiler already knows the path, so the developer must never type it twice. Param matchers are directly worth copying: `pages/user/[id=uuid].tsx` lets validation be a compile-time-resolved reference to a known validator rather than a runtime schema call.

**TanStack's genuinely non-derivable value: validated search params + loader dependency graph**

`validateSearch` turns raw search into a typed object (Standard Schema: Zod/Valibot/ArkType); search types are *inherited down the route tree*; search middlewares (`retainSearchParams`, `stripSearchParams`, custom) transform params during link generation; `loaderDeps` declares which search slices a loader depends on; `beforeLoad` builds typed route context that flows to children; loaders receive params+deps+context. Search params are treated as first-class JSON-serializable app state, not strings.

> *Implication:* Filenames can encode path params but never search/query params or loader dependencies — this is the one place where an explicit exported object earns its keep. Recommended shape for skia-proto: default-export the component (convention), plus optional named exports the compiler statically reads — `export const params = {...}`, `export const search = {...}`, `export const loader = ...`, `export const options = {...}` (window/screen metadata). Presence/absence of each export is a COMPILE-TIME fact: routes without a loader should link zero loader machinery; the parent→child loader waterfall that Next/Remix/TanStack resolve at runtime can be emitted as an explicit parallel-fetch plan per route.

**Next.js App Router: the conventions, and where they broke**

Fixed filenames compose the render tree: `layout` (persistent, nests), `template` (remounts per navigation), `page`, `loading` (auto Suspense boundary), `error` (auto error boundary), `global-error`, `not-found`, `forbidden`, `unauthorized`, `default`, `route`. Organizational sugar: route groups `(name)` (no URL segment), dynamic segments `[id]`/`[...all]`/`[[...opt]]`. Then the escape hatches: **parallel routes** `@slot` render multiple independently-navigable panes in one view (each slot keeps its own sub-state, `default.js` supplies the fallback when a slot has no match on hard navigation) and **intercepting routes** `(.)`/`(..)`/`(...)` exist to render a route as a modal over the current context while masking the URL.

> *Implication:* `loading`/`error` as positional files is exactly right for a compiled framework: WHICH subtree a boundary wraps is a static fact, only the pending/failed state is dynamic — so boundaries become compile-time nodes in the scene graph with zero runtime discovery. But parallel + intercepting routes are the smoke: they exist because 'one URL string = one page tree' collapses as soon as you need independently-navigating panes and modal-over-context. A desktop app is ALL panes, sidebars, inspectors and modals. Do not inherit a model whose two ugliest features are patches for the exact case that is your default case.

**Expo Router is the direct experiment on 'URL routing for native' — and it leaks**

`app/` dir; `_layout.tsx` renders a navigator (`<Stack>`, `<Tabs>`, `<Drawer>`); route groups `(tabs)` organize without URL segments; a modal is just a screen with `presentation: 'modal'`; it sits on top of React Navigation. Typed routes generate `expo-env.d.ts`/`.expo/types` with `Href<T>` and a `Route` union, require absolute (not relative) hrefs, and CANNOT type query params from the filesystem (you hand-supply a generic to `useLocalSearchParams<T>()`); still gated behind `experiments.typedRoutes` and described as beta. Reported seams: navigation state is a tree of per-navigator states with independent histories and the URL is only a projection of it; `setParams` does not push history; constructing an arbitrary back-stack is hard; query-param navigation corrupts history.

> *Implication:* This is the single most important negative result for the user's key question. Making the path string the runtime source of truth in a native app forces a lossy projection of a state TREE onto a linear STRING. skia-proto should invert it: the runtime source of truth is a typed navigation stack of route values per window; the path string is a derived, generated serialization used only at the deep-link/restore boundary. Also note typed search params being the exact thing Expo could not derive from the filesystem — confirming the previous finding.

**React Navigation's static configuration API is native-land's own compile-time-first turn**

`createNativeStackNavigator({ initialRouteName, screens: { Home: HomeScreen, Profile: ProfileScreen }, groups: {...} })` wrapped by `createStaticNavigation(RootStack)`. Because the whole screen tree is a static object literal, param types are inferred automatically via `StaticParamList` (no hand-written `RootStackParamList`), and — the key part — the **deep linking config is derived from the static tree**: per-screen `linking: 'path'`, or `enabled: 'auto'` to auto-generate paths from screen names. `groups` handle conditional screens (auth vs unauth) without going dynamic.

> *Implication:* This is the closest existing prior art to what skia-proto should build, and it validates the direction: declare the screen tree statically → derive param types AND the URL scheme from it, rather than the reverse. skia-proto can do at build time (real codegen, exhaustive, zero runtime tree walk) what React Navigation strains to do through TS inference. Copy the direction of derivation: routes/screens are primary, paths are generated. Also copy `groups` — conditional screen sets (signed-in/out) are common and must not force the route table dynamic.

**SwiftUI: a closed static vocabulary of Scenes, with dynamic instances**

`@main struct MyApp: App { var body: some Scene { ... } }` where the scene vocabulary is fixed and OS-meaningful: `WindowGroup` (user-multipliable), `Window(id:)` (single instance — preferences, inspector), `WindowGroup("Note", for: Note.ID.self)` (value-keyed instances; the content closure receives a binding to the value), `DocumentGroup`, `Settings` (OS wires it to the app menu / Cmd-,), `MenuBarExtra`. Programmatic opening via `@Environment(\.openWindow)` → `openWindow(id:)` or `openWindow(value:)`. Lifecycle observed via `@Environment(\.scenePhase)`. `handlesExternalEvents(matching:)` routes external/deep-link events to a particular scene.

> *Implication:* Directly answers open question 1. `<App>` should declare a CLOSED, compile-time-enumerable set of window KINDS; `windows/main/index.tsx` is a window kind, not a window instance. Critically, Settings and MenuBarExtra are separate SCENE KINDS, not 'a window whose route is /settings' — the OS treats them differently (menu placement, activation policy, no dock icon). skia-proto's `<App>` needs the same distinction: Window / WindowGroup / Settings / MenuBarExtra(tray) / Panel are different compiled node types with different native lowering, not one Window type with props.

**SwiftUI's window-instance key: Hashable + Codable buys dedupe AND restoration for free**

The value passed to a value-keyed `WindowGroup` must be `Hashable` and `Codable`. Hashable lets SwiftUI match a presented value to an existing scene — `openWindow(value:)` on an already-open value FOCUSES the existing window instead of creating a duplicate. Codable lets macOS serialize open windows and restore them on next launch (with the known hazard that restored data may be stale or the referenced entity deleted, so the content must tolerate a missing/invalid key).

> *Implication:* Adopt window identity = `(kindId, key)` where `kindId` is a compile-time constant and `key` is a compile-time-typed, structurally-serializable value. This single decision yields: automatic 'focus existing document window' behavior, free session restoration, and a natural deep-link target address. The compiler can verify key types are serializable — a static check SwiftUI can only enforce via protocol conformance. Also budget for the stale-key path: restoration must be able to fail gracefully into an empty/error state per window.

**SwiftUI NavigationStack: navigation by typed VALUE, zero URLs**

`NavigationStack(path: $path)` bound to `NavigationPath` (a type-erased, Codable heterogeneous stack) with `.navigationDestination(for: Item.self) { item in ... }` declaring which view renders which value type. Push = `path.append(value)`; back = `path.removeLast()`; reset = `path.removeLast(path.count)`. The whole path can be JSON-encoded and restored. Deep links arrive via `.onOpenURL { url in ... }` and are manually translated into appended values.

> *Implication:* The reference native navigation model, and it has no path/URL concept in its hot path at all. For skia-proto: `navigate(Routes.userDetail({ id }))` returning a typed route value pushed onto a per-window stack; `useRoute()` returning a discriminated union the compiler can exhaustively switch on. `navigationDestination(for: T.self)` is precisely what file-based discovery generates automatically — that is the strongest argument for keeping file-based routing while dropping URLs: the filesystem generates the value-type→screen mapping table.

**Tauri: static window array in config; runtime creation as the exception**

`tauri.conf.json` → `app.windows[]`, each entry with `label` (unique identity, defaults to `main`), `url`, `title`, `width`/`height`, `visible`, and `create` (default `true` — created at app startup). Setting `create: false` declares a window in config (so its config is still static and typed) while deferring construction to runtime via `WebviewWindowBuilder` / the JS `WebviewWindow` API.

> *Implication:* The `create: false` pattern is worth stealing verbatim: DECLARE every window kind statically (so labels, sizes, constraints, menus and initial content are compile-time data) and separate that from WHEN it is instantiated. skia-proto gets a compile-time-complete window registry — enabling generated typed handles per window kind, static validation of cross-window messages, and compile-time knowledge of which windows can ever exist — while still supporting `openWindow('settings')` at runtime.

**Deep linking on desktop is inherently build-time — this favors compile-time-first**

Tauri's deep-link plugin: on macOS the URL schemes MUST be registered in Info.plist at build time — 'the plugin can't change the schemes at runtime'; macOS apps are single-instance by default so the deep link arrives in the running process. On Windows and Linux the OS spawns a NEW process with the URL as a CLI argument, so a single-instance plugin (with the deep-link feature) is required to forward it to the running instance. Windows requires registry protocol-handler registration; Linux requires a .desktop entry.

> *Implication:* The externally-addressable surface of the app is fixed at build time by the OS itself — the compiler can and should emit the Info.plist/registry/.desktop entries from the route table. Deep-link handling then needs exactly four generated pieces: (1) a `parse(url) -> RouteValue | null` function generated from the static table (no runtime regex router), (2) single-instance forwarding on Windows/Linux, (3) a per-route dispatch POLICY — open new window / focus existing window with matching key / push onto the focused window's stack (SwiftUI's `handlesExternalEvents` + value-dedupe is the prior art), and (4) cold-start ordering, since the link may arrive before any window exists.

**Electron BrowserWindow: everything the compile-time-first principle forbids**

`new BrowserWindow({...})` is a purely imperative runtime object owned by the main process; each window is a separate renderer process with its own JS realm and its own copy of the framework; nothing crosses without explicit IPC channel names and structured-clone serialization; channel names are untyped strings; there is no static knowledge of how many windows exist, what they render, or what messages flow between them; per-window memory cost is a full browser renderer.

> *Implication:* Confirms the two properties skia-proto must have that Electron lacks: (a) all windows in ONE Bun process sharing ONE heap — so cross-window state is a direct reference, not a serialized message, and cross-window 'IPC' disappears as a concept; (b) window kinds and their content statically enumerable, so a generated typed registry replaces stringly-typed channels. Per-window isolation should be a per-window Skia surface + input queue + scene graph, not a per-window runtime.

**Flutter multi-window in 2026: still unstable — window as widget node + controller**

The API is `RegularWindowController(size:, sizeConstraints:, title:)` plus `runWidget(RegularWindow(controller: controller, child: MyApp()))`, so a window is a declarative node in the widget tree paired with an imperative controller. It remains behind the `enable-windowing` flag with an open pre-launch checklist (issue #177586, assigned, ~0/20 complete), with active bugs around platform focus behavior, app-exit semantics when a child window is destroyed, and `WindowingOwner` engine-initialization ordering. Contributions largely from Canonical; multi-window remains on the 2026 roadmap rather than shipped.

> *Implication:* Two lessons. First, the hybrid declarative-node + imperative-controller shape is convergent (SwiftUI Scene, Tauri label, Flutter RegularWindow) — adopt it. Second, calibrate: the genuinely hard parts are not the API but engine/renderer lifecycle per window, focus and activation semantics, and 'what does closing the last window mean'. Decide skia-proto's app-termination policy, per-window Skia surface/GPU-context lifecycle, and focus model EXPLICITLY and early — these are what have kept a well-resourced team in preview for years.

**GPUI/Zed: the most demanding modern native desktop app has no router at all**

Windows are opened via `cx.open_window`; each window owns its own layout engine and Scene; all UI is an Entity implementing `Render`, and GPUI calls `render` on a window's root view each frame, producing an element tree that is laid out and rasterized. Zed's user-facing structure is Workspace → Pane → Item, with per-pane item history providing back/forward. There is no path, no URL, and no route table.

> *Implication:* A strong existence proof that a per-window page router is optional, not foundational, for native desktop. The load-bearing abstractions are window → root view → panes/items with per-container history. skia-proto should treat the file-based router as a CONVENIENCE that generates a screen registry and a default per-window stack — not as the framework's spine. Make sure a window can opt out entirely and just mount a component tree (Settings, a tray popover, a toolbar-only window need no router at all).

**Synthesis: what a compiled framework can make static that none of the prior art does**

Across all five routers, these remain runtime work that is provably compile-time-determinable: path matching and param extraction (regex/segment walking at runtime everywhere, including TanStack despite codegen); which loaders exist and their parent/child ordering (resolved by walking the matched route chain at runtime); boundary placement for loading/error (discovered by walking the rendered tree); code-split chunk selection (runtime dynamic import keyed by matched route); link href construction (runtime string interpolation); and the deep-link URL scheme (hand-written into Info.plist/registry, drifting from the route table).

> *Implication:* The skia-proto route compiler's differentiators, in rough value order: (1) numeric RouteIds + generated match table/switch instead of runtime matching; (2) a generated per-route load PLAN with the parallel/waterfall structure resolved statically; (3) suspense/error boundaries compiled into fixed positions in the scene graph; (4) `Routes.userDetail({id})` typed constructors instead of string interpolation, so a 'link' is a struct not a string; (5) deep-link parser AND the OS scheme registration files both generated from one route table, so they can never drift; (6) exhaustive switch over the route union, so adding a route is a compile ERROR at every dispatch site rather than a runtime 404.

**Implication for the React-like primitives question (open question 4)**

Next's `loading.js`/`error.js` prove that boundary POSITION is a static file-level fact while only the pending/failed status is dynamic. React's `startTransition`/`useTransition` exists to let a VDOM reconciler keep showing the old tree while rendering a new one. Native frameworks achieve the same effect structurally: UIKit/SwiftUI retain the outgoing view controller/scene until the incoming one is ready, and GPUI simply keeps the old root view's Scene until the new one renders.

> *Implication:* Suspense and error boundaries survive the translation to a compiled framework, but as compiled STRUCTURE (fixed nodes in the scene graph with three pre-lowered variants: pending / error / content) rather than as runtime-thrown promises and try/catch reconciliation. `useTransition` should NOT survive as-is: with a retained scene graph you can double-buffer — keep the outgoing screen's scene alive and swap on ready — which is cheaper, is what native does, and needs no reconciler. Route context (TanStack `beforeLoad` → context) is a better fit for a compiled framework than React context, because the provider/consumer chain along a route path is statically known and can be lowered to direct field access instead of a runtime context lookup.

**Open questions**

- Is a window's navigation stack a stack of ROUTE VALUES (SwiftUI NavigationPath: heterogeneous, typed, serializable) or a stack of matched route ids + params? The former composes better and is more type-safe; the latter serializes to a path string more directly. Recommendation is the former, with path strings generated only at the deep-link/restore boundary.
- Should every window get a router by default, or should routing be opt-in per window kind (windows/settings/index.tsx with no pages/ dir just mounts a component)? Zed/GPUI and SwiftUI's Settings scene both argue for opt-in.
- What is the window-instance key type discipline? SwiftUI requires Hashable + Codable. What is skia-proto's compile-time-checkable equivalent, and what happens when a restored key no longer resolves (deleted document)?
- Deep-link dispatch policy: per-route or per-window-kind? Options are open-new-window / focus-existing-window-with-matching-key / push-onto-focused-window's-stack. Is this a compile-time annotation on the route (export const deepLink = {...}) or a runtime handler on <App>?
- How are cross-window concerns modeled now that there is a single shared heap — shared stores by direct reference, or an explicit window-scoped vs app-scoped state distinction enforced by the compiler? (Electron's IPC boundary disappears, but so does its accidental isolation guarantee.)
- Do route groups / parallel panes need first-class support? A desktop app's default case is independently-navigating panes (sidebar + main + inspector), which is exactly where Next's URL model needed the @slot and (.)intercept escape hatches. Decide up front whether nav state is per-window or per-PANE.
- Does the app-termination policy tie to windows (last window closes = quit, Windows-style) or not (macOS-style, app persists with no windows)? Flutter is still fixing exactly this, and it interacts with tray/MenuBarExtra scenes that have no window at all.
- Should search/query params exist at all as a concept, or should all non-path state be typed route-value fields? TanStack's search params derive their value from URL shareability, which mostly evaporates outside a browser.
- Does the route table need to support build-time-dynamic routes (plugin-contributed screens, generated pages)? React Router 8's answer is the explicit routes.ts config plus a virtual-route API; TanStack's is Virtual File Routes. Decide whether skia-proto ships an escape hatch or declares the filesystem the sole source.

---

### Scout 2

Every framework studied — Solid, Svelte 5, Vue Vapor, Flutter, SwiftUI, Compose, Xilem, GPUI — has a retained node tree underneath. So the real question is not "signals vs. slot table," it is **what drives mutations into the retained tree**: re-executing memoized functions (Compose/Flutter/React), or effect callbacks wired once at construction (Solid/Svelte/Vapor/Floem). For a compiled TypeScript framework targeting Skia, the second is strictly better, because it makes "which parts are dynamic" a statically-known set — which is exactly the compile-time-first principle applied to reactivity.

Recommendation: **signal-driven direct mutation of a retained scene graph**, with three separate invalidation planes borrowed from Flutter/Compose (structure / layout / paint), and with each compiled binding effect tagged **at build time** with the lowest plane it can dirty. Compose achieves this today only through developer discipline (`Modifier.offset {}` vs `.offset()`, `drawBehind` vs `background`); your compiler can do it automatically, which is a genuine, defensible advantage over Compose Multiplatform — currently the closest prior art (Compose runtime → LayoutNode tree → Skia via Skiko).

Reject Compose-style recomposition as the primary mechanism. The slot table exists to give positional memoization to a model where function bodies re-run; if you compile JSX, bodies never re-run and the whole apparatus is unnecessary overhead. Its one durable lesson is identity: Compose keys slots by compiler-generated **call-site** integers inside nested groups, not by call order — which is why `remember` survives conditionals where React hooks do not. SwiftUI goes further and encodes structural identity in the static generic type. Both prove a compiler can assign identity statically.

On hooks: in a run-once model the rules-of-hooks problem does not get solved, it **disappears**. `useState` becomes `createSignal`, which is just a closure variable allocated once — callable in branches, loops, anywhere. `useMemo`→`derived`, `useEffect`→`effect` (split pre-layout/post-paint), `useRef`→plain `let`, `useCallback`/`memo`→deleted. Suspense, error boundaries, and context all fit (Solid ships them over an owner tree). Transitions and concurrency do not earn their complexity in a desktop app you frame-schedule yourself.

Highest-leverage decision: make the compiler **deep** (Svelte-style whole-module rewriting) rather than **shallow** (Solid-style JSX-only). Every Solid ergonomic tax — props getters, no destructuring, `<Show>`/`<For>` instead of `&&`/`.map` — is a shallow-compiler artifact. You control the whole toolchain; auto-thunking gives React-shaped authoring with Solid-shaped output.

**"Slot table vs. retained scene graph" is a false dichotomy — every system has both**

Compose: slot table → LayoutNode tree → NodeCoordinator draw. Flutter: Widget (immutable config) → Element (retained, identity = runtimeType + key) → RenderObject (retained, owns layout/paint). SwiftUI: View struct → AttributeGraph → render tree. Xilem: short-lived view tree → Masonry retained widget tree. GPUI: per-frame render() → retained scene graph with dirty rects. Solid/Svelte/Vapor: the retained tree is just the DOM itself. In none of these is the memoization structure a substitute for a retained tree; it sits above one.

> *Implication:* skia-proto will have a retained scene graph regardless. The design choice is only what writes into it. Frame the decision as "re-execute memoized function bodies" vs. "run compiled effect callbacks" — not as "signals vs. retained tree."

**Compose Multiplatform desktop is the closest shipping prior art, and it is beatable on exactly one axis**

CMP desktop = Compose runtime + Skiko (Kotlin bindings to Skia, OpenGL/DirectX/Metal backends). Pipeline: composition produces a LayoutNode tree; MeasureAndLayoutDelegate holds a depth-sorted `relayoutNodes` set so parents are always measured before children; draw goes through LayoutNode.draw() → NodeCoordinator. Recomposition, layout, and draw are three independently invalidatable phases.

> *Implication:* Steal the pipeline shape wholesale (depth-sorted dirty layout set, phase separation, per-window Recomposer→per-window composition root). The axis where you can beat it: Compose's phase separation is opt-in developer discipline; yours can be compiler-derived. That is your differentiating claim, and it is a real one.

**Flutter's three invalidation channels are the correct model for a no-DOM target**

Flutter has markNeedsBuild (structure dirty, element added to a global rebuild list, flushed next frame), markNeedsLayout (propagates up to the nearest *relayout boundary* — a node whose own size cannot change as a result), and markNeedsPaint (propagates to the nearest repaint boundary / layer). Element identity for reuse is decided by `Widget.canUpdate` = same runtimeType AND same key; otherwise unmount + inflate.

> *Implication:* In the browser, layout invalidation is the engine's problem and you get it free. With Skia you own it. Signals tell you *which property* changed; they do not tell you *how far up the tree* that matters. You need explicit relayout/repaint boundary propagation on top of the signal graph. Do not assume fine-grained reactivity alone gives fine-grained layout.

**Compose's "defer state reads to a lower phase" is manual discipline — a compiler can make it automatic**

Android's official perf guidance: "You should be suspicious if you are causing recomposition just to re-layout or redraw a Composable." The fix is lambda modifiers — `Modifier.offset { IntOffset(0, scrollProvider()) }` reads state in the *layout* phase, `Modifier.drawBehind { drawRect(color) }` reads it in the *draw* phase, both skipping recomposition entirely. Getting this wrong is the single most common Compose perf bug.

> *Implication:* Your compiler statically knows which scene-graph property each JSX binding writes. Tag every generated binding effect with its plane at build time: `color`/`opacity`/`background` → paint-dirty only; `width`/`padding`/`flex` → layout-dirty; `{#if}`/`.map()` → structure-dirty; `transform`/`offset` → transform-dirty (often GPU-only, no re-raster). This is Compose's hardest-to-teach optimization, obtained for free and unavoidably.

**Solid, Svelte 5, and Vue Vapor have independently converged on one compiled IR shape**

All three emit: (1) a hoisted static template, cloned per instance; (2) a small set of `insert`/`setText`/`setClass`/`setDynamicProp` primitives; (3) one effect per dynamic binding. Vapor's output literally reads `_renderEffect(() => _setText(n0, _ctx.count))` plus `_delegate`/`_delegateEvents` for events; Svelte's reads `$.template(...)` plus per-binding update closures from `svelte/internal/client`. Vue 3.6 shipped Vapor feature-complete (RC as of mid-2026), matching Solid/Svelte in third-party benchmarks, with 20–50% smaller bundles for Vapor-only components — after years of defending the VDOM.

> *Implication:* This is your codegen target, translated from `document.createElement`/`setAttribute` to `sceneNode.create`/`node.setPaintProp`. Three independent teams landing on the same IR is strong evidence it is the right one. The convergence is also a defense of the whole approach: Vue abandoning its own VDOM is the loudest available signal.

**Svelte 5's push-pull scheduling is the right propagation semantics, not pure push**

$state writes eagerly *mark* dependents dirty (push) but $derived values recompute only when read (pull), and a derived whose new value is referentially equal to its old value stops propagation dead. $effect re-runs are batched into a microtask and run *after* DOM updates have been applied; $effect.pre runs before. Dependency sets are re-collected on every run, so conditional branches produce dynamic dependency sets. Vue 3.6 also rewrote its reactivity core (alien-signals: doubly-linked dependency lists, no per-effect Set allocation).

> *Implication:* Batch to the vsync tick, not the microtask — you own the SDL3 event loop, so the natural flush point is the frame boundary. Adopt push-dirty/pull-value plus equality short-circuit: it is what prevents a single root state write from cascading into unnecessary layout. Adopt alien-signals-style intrusive linked lists; per-signal Set allocation will show up in GC pauses at 120Hz.

**React Compiler cannot remove the VDOM, and the reason is exactly the constraint skia-proto must avoid**

React Compiler does two things: skip cascading re-renders of components, and skip expensive calculations. It memoizes React components and hooks only — not plain functions, and memoization is never shared across components. React.dev is explicit that it requires the Rules of React to hold, and says nothing about removing reconciliation. It reduces *how often* a component body runs; it cannot change *what a run produces*, which is a whole fresh tree that must then be diffed.

> *Implication:* The lesson is about the unit of update, not about compilers. React's unit is "a component's return value," so a diff is structurally required and memoization is only damage control. Choose a unit of "one binding" and both the diff and the memoization disappear. Do not import useCallback/memo/useMemo-for-identity — they are compensations for a problem you will not have.

**Compose's positional memoization keys slots by compiler-generated call site, not by call order — this is why `remember` survives conditionals**

The Compose compiler rewrites every @Composable to take `$composer`, a `$changed` bitmask (two bits per parameter encoding change status), and a `$default` bitmask, then wraps the body in `startRestartGroup(<compiler-generated int key>)`. Groups nest, so a `remember` inside an `if` gets a slot scoped to that branch's group; branches do not leak into each other. Slots live in a gap buffer (O(1) near the cursor; the gap only moves on structural change). `key(id) { }` supplies explicit identity when the same call site runs in a loop — without it, inserting at the head of a list shifts every subsequent item's positional identity and restarts their state and side effects.

> *Implication:* Direct answer to your question: yes, a compiler can make hook identity statically known, and Compose is the existence proof — but note it makes *call-site* static, not *order*, and still needs runtime groups for conditionals and loops. Explicit keys remain necessary for dynamic lists in every system studied. Do not expect to compile keys away.

**A run-once model dissolves rules-of-hooks rather than solving it**

Solid and Svelte execute a component function exactly once; the body creates signals and wires effects, then is never called again. State slots are therefore just closure variables, allocated once. There is no order-dependent slot array, so `createSignal` inside an `if`, inside a loop, or in a helper function is all legal. Svelte reaches a similar place from the other direction by *syntactic* restriction: `$state(...)` is a compiler error anywhere except a variable declaration initializer or a class field, making every state slot statically resolvable by name.

> *Implication:* For skia-proto, `useState` should be `createSignal` semantics: a signal you may create anywhere, but which is created *once*. This is strictly more permissive than React AND strictly more analyzable. The one behavioral trap to guard: state created inside control flow runs once, for whichever branch was live at construction — nothing re-creates it later. Have the compiler reject or hoist state creation inside conditionals whose predicate is reactive.

**Solid's ergonomic taxes are artifacts of a deliberately shallow compiler — yours does not have to pay them**

Solid's compiler transforms JSX only, leaving surrounding JavaScript alone. Consequences: props must stay lazy getters (destructuring kills reactivity), `cond && <X/>` re-creates rather than toggles so you need `<Show>`, `arr.map()` has no reconciler so you need `<For>` (referential keying via mapArray) or `<Index>` (index keying). Svelte's compiler rewrites the entire module and therefore lets `let { a, b } = $props()` and plain `{#if}`/`{#each}` work naturally.

> *Implication:* Highest-leverage decision in this whole report. skia-proto owns the full toolchain, so go deep: auto-thunk every reactive read into a getter call, lower `cond && <X/>` into a structural branch node, lower `.map()` into a keyed reconciler over retained nodes. You get React-shaped authoring ergonomics with Solid-shaped output — which is the pitch neither Solid nor Svelte can make.

**Suspense, error boundaries, and context fit signals; transitions and concurrency do not earn their cost**

Solid ships <Suspense>, useTransition, and startTransition on a pure signal graph with no VDOM — suspension is triggered by *reading* a resource under a boundary (each boundary keeps a Set of pending resources), and context resolves via the owner tree. Svelte 5.36+ added `await` in $derived/markup/top-level script behind `experimental.async`, requiring a boundary with a pending snippet, plus a `fork(...)` API (5.42) for speculative work. But Solid implements transitions by *cloning the reactive graph* and dual-rendering — the most expensive machinery in the codebase.

> *Implication:* Ship: signal (useState), derived/memo, effect split into pre-layout and post-paint (Svelte's $effect.pre/$effect, Solid's createRenderEffect/createEffect), context over the owner tree, error boundary, Suspense boundary + resource. Defer or drop: transitions (graph cloning is a large complexity tax for a desktop app), and all concurrent/time-slicing machinery — you own the frame loop and can simply not block it. Drop entirely: useCallback, memo, useRef (a plain `let`), and dependency arrays.

**Static subtree flattening is a compile-time win uniquely available to you, and only under the signal model**

Any subtree containing zero reactive bindings is fully known at build time. With no DOM you can lower it to a precomputed layout, a baked display list, or even a serialized SkPicture, and skip construction, layout, and per-frame traversal entirely. Solid and Svelte cannot do this — the DOM forces node-by-node construction, so the best they can manage is `template()` cloning.

> *Implication:* This is your strongest technical argument for signals over recomposition, and it is the compile-time-first principle in its purest form. A signal/effect model makes "the set of dynamic bindings" a first-class static artifact. A recomposition model deliberately erases that distinction — every composable is potentially recomposable, so nothing can be proven static. Choosing the slot table forfeits this optimization permanently.

**The bun:ffi boundary inverts the usual batching calculus**

In the DOM, a fine-grained framework's ideal is to mutate the target immediately on signal write. Across FFI, each Skia call is comparatively expensive, and a burst of ten signal writes would mean ten round trips. GPUI (Zed) is instructive here: it rebuilds an element tree each frame yet wins by keeping a retained scene graph with dirty-rect damage below it — a single-character edit re-shapes one line of text and submits one draw call, and Zed renders a 100k-line file in ~0.8ms on M3.

> *Implication:* Signals must mutate a *JS-side* retained node tree (plain structs / TypedArrays), setting dirty flags — never call Skia directly from an effect. A per-vsync flush then walks only damaged subtrees and emits a batched display list across FFI. Keep node data in TypedArrays so the flush can memcpy contiguous ranges rather than marshalling per-node. Add damage-rect tracking; it is cheap and it is what makes text editing and cursor blink free.

**Text shaping, not diffing, will be your actual bottleneck**

Skia paragraph shaping and layout dominate frame cost in every Skia-based UI. Cache keys are naturally (text, style, constraint width). A signal model tells you precisely whether text content changed, style changed, or available width changed — three different cache invalidation levels. A recomposition model tells you only "this composable re-ran."

> *Implication:* Concrete argument for finer granularity that has nothing to do with benchmark micro-optimization. Design the text node so content/style/width are three separate signals feeding a three-level shaped-paragraph cache. Budget real engineering here — it will outweigh reactivity overhead by an order of magnitude.

**Rust prior art argues for signals in TypeScript, not against them**

Xilem diffs a short-lived view tree into Masonry's retained widget tree (Vello/wgpu, Parley, AccessKit) — Raph Levien chose this because signals are ergonomically hostile under the borrow checker with no GC, not because diffing is better. Floem (lapce) is the controlled experiment: same ecosystem, chose leptos-style fine-grained signals with the view tree constructed exactly once, explicitly to avoid a view-generation bottleneck. egui rebuilds everything every frame — genuinely fast for its niche, and it has no identity problem at all, but it loses text/layout caching, animation state, and accessibility, which is why it dominates debug overlays and not application frameworks.

> *Implication:* Do not cite Xilem as evidence against signals; it is evidence about Rust. Floem is the closer analogue and it picked signals + build-once. Also take egui's honest warning: retained + reactive means you own an identity model, a disposal model, and a memory-leak surface that immediate mode simply does not have. Budget for ownership-tree-scoped disposal (Solid's owner graph) from day one, not as a retrofit.

**Hot reload and introspection are the real, under-discussed cost of the run-once signal model**

Flutter and Compose have best-in-class hot reload precisely *because* they re-execute build/composable functions — new code simply runs on the next frame against retained state. In a run-once model the component body has already executed and its closures are captured in live effects, so replacing code means tearing down and re-creating a subtree and losing local state. Similarly, a slot table is a linear, inspectable data structure; a signal graph is a web of closures that tooling must instrument to visualize.

> *Implication:* This is the honest counterweight to everything above and the strongest argument the Compose side has. Mitigate by making the compiler emit stable per-call-site node identities (the SwiftUI/Compose lesson) and a module-level registry mapping identity → live node + signal handles, so HMR can re-run a *single* component's constructor and re-wire its effects while preserving signals whose declaration is unchanged. Design this in from the start; it is extremely painful to retrofit onto a closure-captured graph.

**SwiftUI encodes structural identity in the static type — direct support for compile-time identity assignment**

SwiftUI distinguishes explicit identity (`.id()`) from structural identity, where a view's position is captured in its generic type (`ModifiedContent<TupleView<...>>`). Apple's framing is identity / lifetime / dependencies as three separate concerns, with AttributeGraph — effectively a signal graph — handling fine-grained value propagation beneath the structurally-diffed view tree. SwiftUI is thus a hybrid: structural diffing for shape, signal graph for values.

> *Implication:* Assign every JSX call site a compile-time integer node-identity path. Runtime keys are then needed *only* where structure is dynamic (list items, and route/branch swaps). This also validates the hybrid: use compile-time structural identity for the static skeleton and signals for values, rather than treating the two as competing philosophies.

**<App>/<Window> maps cleanly onto per-window composition roots under either model, but more cheaply under signals**

Compose handles multi-window by instantiating one Recomposer + one Composition per window; Flutter uses one pipeline owner per view. Each window needs its own retained scene graph, its own dirty sets, and its own frame loop driven by that window's vsync. Under a slot-table model, cross-window shared state requires coordinating two recomposers. Under signals, a signal is just a graph node — a shared store read by effects in two different windows works with no extra machinery, since the effects belong to different owner trees but the same source signal.

> *Implication:* Model <App> as the root owner scope and shared-signal namespace; each <Window> as an SDL3 window + independent owner subtree + independent scene graph + independent frame scheduler. Cross-window reactivity comes free. Per-window frame scheduling is important on mixed-refresh-rate multi-monitor setups.

**Router: TanStack-style route objects are the compile-time-first choice; convention-only route components are not**

"Route files are plain components" defers the entire route→component→params→data contract to runtime convention resolution. A route file that exports a typed object literal (path, params/search validators, loader) is *data the compiler can read* — it can be lowered into a static route table, a static param-parser, and generated typed link helpers, with zero runtime route matching for static segments. Loaders also plug directly into the resource/Suspense boundary primitive above, where a bare component gives the framework no declaration point for async work.

> *Implication:* Take direction (b), but hybridize: keep file-based convention for the path→file mapping (zero config, statically enumerable at build time from windows/*/pages/), and require the typed export for the contract. Best of both: convention supplies the tree shape, the exported object supplies the types and the loader. Note this is orthogonal to the reactivity choice but is scored by the same governing principle — and by that principle (b) plainly wins.

**Open questions**

- Should component bodies EVER re-execute? Route changes and hot reload are the two forced cases. If the answer is never, HMR must be designed in from day one (see the hot-reload finding); if the answer is 'per route', you need a defined teardown/re-create boundary that looks a lot like a mini-recomposition scope.
- Do you want transitions/concurrent rendering at all? Solid implements them by cloning the reactive graph and dual-rendering — the single most complex part of its codebase. For a desktop app where you own the frame loop, my read is no, but it is a one-way door if the signal graph is not built to support forking.
- How does animation write to the scene graph? Driving 60–120Hz property changes through the signal graph means per-frame graph propagation. Compose and Flutter both bypass this (draw-phase reads / AnimationController → markNeedsPaint). Recommend a separate animation plane that writes node properties directly and marks paint-dirty — but that means two write paths into the retained tree, which needs a coherent story.
- What is the disposal/ownership model? Solid's owner tree auto-disposes signals and effects when a scope is destroyed. With a retained scene graph plus FFI-backed Skia resources (paints, pictures, textures, shaped paragraphs), leaks are much more expensive than in the DOM. Does node destruction drive owner disposal, or the reverse?
- Where does layout live — in the signal graph or beside it? Treating computed layout values as signals is elegant but risks a signal write per node per frame during a resize. Compose and Flutter both keep layout as an imperative depth-sorted pass outside the reactivity system. Recommend the latter, but it means layout results are NOT reactively readable by user code without an explicit bridge (Compose's onGloballyPositioned).
- How are styles lowered? Your CSS-like styling should compile to static property sets baked into node constructors, with only genuinely dynamic properties becoming bindings. Are pseudo-states (hover/active/focus) compiled into precomputed alternate property sets selected by an integer state, or into reactive bindings? The former is dramatically cheaper and is available to you because there is no cascade to resolve at runtime.
- Devtools story: a signal graph is far less inspectable than a slot table. What is the plan for 'why did this node update?' — dependency-graph recording, or compiler-injected binding names?

---

### Scout 3

The repo at C:\Users\med\workspace\skia-proto is real, builds, and runs — but it is a **single-page, single-window demo compiler**, not a framework skeleton. There is no router, no `<App>`, no `<Window>`, no `windows/` or `pages/` directory, and no file-based anything. Nothing exists for design questions 1–3 to build on; question 4 is heavily constrained by decisions already shipped.

Critically, **the auto-memory is stale**: it says "single Bun process, Skia via bun:ffi + SDL3, no Rust runtime." That was superseded on 2026-07-30. There is now a Rust `cdylib` — `native-src/dziri-engine` (SDL3 built-from-source static, skia-safe 0.87 + textlayout, Taffy 0.9) — that owns window, event pump, layout, paint, text measurement and hit-testing. Bun's entire FFI surface is 21 symbols against `dziri_engine.dll`; Skia and SDL3 are no longer bound from TypeScript at all (`src/ffi/*`, `layout.ts`, `paint.ts`, `text.ts`, `png.ts` were deleted). The project is renamed `dziri` in the docs.

The bulk data path is **shared memory, not FFI**: Rust allocates staged/live/bounds arenas, hands Bun absolute pointers, Bun wraps them with `toArrayBuffer` (no finalizer) and writes tables directly. Field identity and enum encodings are code-generated from `src/protocol/schema.ts` to both sides. One `tick()` per frame; the engine's `commit()` returns a diff so a colour-only patch never reaches Taffy.

What exists and works: a full compile-time CSS cascade (hand-written parser, specificity, inheritance, shorthands, interning), JSX→IR via Bun's `jsxImportSource` pointed at `src/compiler/jsx-runtime.ts` (no Bun plugin — the compiler *imports and evaluates* the .tsx module), 46 style fields, CSS Grid, flex, inline styles, conditional classes compiled to style-table patches, keyed dynamic lists as arenas, signals, per-row handlers, `bindValue` text editing. Verified live: `bun run compile` → 126 nodes / 48 style slots / 32.9 ms; `bun test` → 12 pass.

The governing constraint for question 4: **function components are erased at build time and leave no instances**. `resolve-refs.ts` recovers signals and handlers by *object identity* from module-level exports, and a signal created inside a component is a documented compile error. Hooks, per-instance state, effects, context, Suspense and transitions have no place to live in the current architecture — none of them exist, and three of them are structurally excluded rather than merely unbuilt.

There are no CLAUDE.md or AGENTS.md files. `NOTES.md` (45 KB) and `ROADMAP.md` (41 KB) are the design record and are unusually decision-dense.

**Repo layout — what exists vs. what is absent**

Top level: `NOTES.md`, `ROADMAP.md`, `package.json`, `tsconfig.json`, `app/`, `src/`, `scripts/`, `native/`, `native-src/`, plus leftovers (`SDL3-3.4.12-win32-x64.zip`, `skiasharp.nativeassets.win32.4.150.1.nupkg` (79 MB), `.natives-tmp/`, two demo PNGs).

`src/` is 23 files: `app.ts` (host, 235 L), `compile.ts` (CLI, 138 L), `ir.ts` (380 L), `variants.ts`, `engine-smoke.ts`, `compiler/` (7 files: compile.ts 1042 L, css.ts 687 L, html.ts 250 L, jsx-runtime.ts 498 L, jsx-dev-runtime.ts, variants.ts, variant-compile.ts, resolve-refs.ts, item-path.ts), `engine/` (host.ts 540 L, upload.ts 332 L, upload.test.ts 313 L), `protocol/` (schema.ts 333 L, generated.ts 325 L), `runtime/` (signal.ts 245 L, bindings.ts 126 L, list-runtime.ts 357 L, patches.ts 76 L).

`app/` is exactly 5 files: `app.tsx`, `app.css`, `app.html`, `state.ts`, `ui.gen.ts`. `scripts/` holds one file, `gen-protocol.ts`.

There is **no** `windows/`, no `pages/`, no `routes/`, no `packages/`, no CLI, no `create-dziri`, no template. `package.json` is `private: true` with only npm scripts — no package split, no bin entry. A stray `.verify/` scratch dir (`c2.tsx`/`c2.css`/`c2.gen.ts`) holds a one-off injection test where `onClick` is a string `"(()=>{throw new Error('pwned')})()"`.

> *Implication:* Every one of the four open design questions is greenfield in this repo. Nothing needs to be un-built to introduce an App/Window/router model, but equally nothing exists to extend — the compiler CLI hardcodes a single entry pair (`app/app.tsx` + `app/app.css` → `app/ui.gen.ts`).

**The architecture memory is out of date — there IS a Rust runtime**

MEMORY.md records "single Bun process, Skia via bun:ffi + SDL3, no Rust runtime." `NOTES.md:174` opens a section titled **"Superseded: the runtime is moving to a Rust engine"** and `ROADMAP.md:121` states flatly: **"The engine is Rust: `winit` + `skia-safe` + Taffy, one binary."** (later reversed to SDL3 over winit).

`native-src/dziri-engine/` is a built `cdylib`+`rlib`: 9 Rust source files (~3,500 L) plus 2 integration test files. `dziri_engine.dll` is 7.81 MB, built 2026-07-30. Cargo.toml pins `skia-safe 0.87` (features `textlayout`), `taffy 0.9`, `sdl3 0.18` (`build-from-source-static`, `unsafe_textures`), `panic = "unwind"` in both profiles.

ROADMAP.md:13 defends the choice: *"What the developer writes is TypeScript, HTML and CSS. What the engine is written in is an implementation detail, and choosing Rust for it buys spec-conformant layout, real text shaping, and the removal of a whole category of FFI hazards."*

> *Implication:* Any design proposal must assume a two-language boundary. ROADMAP risk #9 is explicit: "Rust slows iteration" and "two languages raise the contribution bar. Keep the engine's surface narrow and the churn in TypeScript." A router or component model should land entirely on the Bun side; anything requiring an engine change (e.g. multi-window) is a materially larger ask.

**The JSX compiler: no Bun plugin — the compiler imports and evaluates the module**

`windows/main/pages/index.tsx:1` is `/** @jsxImportSource ../../../src/compiler */`. Bun's own JSX transform rewrites `<div/>` to `jsx("div", props)` against `src/compiler/jsx-runtime.ts`, which builds the compiler's `Element` tree directly. There is **no Bun plugin and no AST transform anywhere in the repo**.

`src/compile.ts:63-70` does the work: `const specifier = pathToFileURL(resolve(inputPath)).href; setCompiling(true); mod = await import(specifier)`. Importing the module *is* compiling it. Its default export is the tree.

Output is `app/ui.gen.ts` — a TypeScript **module**, not JSON. Header: `// GENERATED by src/compile.ts from app/app.tsx + app/app.css // Do not edit. No CSS, no selectors, no property names — just indices.` It exports `strings` (string[]), `styles` (46 typed arrays + count), `nodes` (kind/style/text/parent/firstChild/nextSibling/list/hidden), `states`, `interactive`, `textBindings`, `handlers`, `editables`, `stylePatches`, `lists`, `listBindings`, `root` — and it `import`s the app's signals and handler functions by name from `./state.ts`.

NOTES.md:256: *"Why the IR is a JS module, not JSON — single process means there is no deserialize step to write."*

JSX intrinsics are a closed whitelist (`jsx-runtime.ts:491`): `"body" | "div" | "span" | "p" | "label" | "button" | "input"`, "enumerated rather than open-ended so a typo like `<dvi>` is a type error instead of an unstyled node." Only `button` maps to a distinct NodeKind (`compile.ts:234`).

> *Implication:* Because compilation is module evaluation, a router's route files would be *imported and executed* at build time — which fits convention-over-config (option a) naturally and would make TanStack-style route objects (option b) trivially readable too. But it also means anything a route file does at import time happens at build time, and any value not statically resolvable is a compile error, not a runtime fallback.

**Components are erased and have no instances — the hard constraint on React-like primitives**

`jsx-runtime.ts:8`: *"Nothing here ships to the runtime — by the time `ui.gen.ts` exists, components have been erased into nodes and style ids."* `jsx-runtime.ts:422`: *"Function components are expanded here, at build time, and leave no trace."*

NOTES.md:587 states the consequence as a rule: *"Signals and handlers **must be module-level exports**. Unresolvable references are a compile error that states the rule. A signal created inside a component has nowhere to live: components are erased at build time, so there are no instances to hold per-instance state."*

`src/compiler/resolve-refs.ts` recovers names by **object identity**: it imports `app/state.ts` and the entry module, walks the exports, and matches by reference. Its error message (line 68) reads: *"Signals and handlers must be declared as exports (e.g. in app/state.ts) so the…"*

NOTES.md:590 also rules out Svelte-style implicit reactivity: *"Bare `let count = 0` cannot be reactive… Svelte *parses* component source and rewrites assignments; we *evaluate* it and observe the resulting tree, so the declaration is never visible."*

What actually exists in `src/runtime/signal.ts` (245 L): `signal()`, `computed()` (lazy, invalidated synchronously even inside a batch), `batch()`, `isSignal()`, `.subscribe()`, and `.map(render, {key})`. That is the complete state API. There is **no** `effect()` export, no context, no Suspense, no transitions, no async primitive of any kind, no `ref()` (roadmap C3, unbuilt).

> *Implication:* Directly answers question 4. `useState` as authored in React is structurally impossible without either component instances or a TypeScript AST transform — neither exists, and NOTES.md:682 explicitly notes the AST-transform option "is not built." Suspense and effects have no async or scheduling substrate at all. The primitives that *do* fit today are the ones already shipped: module-level signals, computed, batch, keyed `.map`, and conditional classes via `cn`.

**Layout, style and CSS: Taffy in Rust; the CSS parser is build-time only**

**Layout engine**: Taffy 0.9 inside `native-src/dziri-engine/src/layout.rs` (480 L) — `LayoutTree` over the shared tables, producing absolute bounds. The old hand-written TS flexbox is deleted. A separate spike, `native-src/taffy-ffi` (381 L, ships as `native/win32-x64/taffy_ffi.dll`), was the measurement harness that decided the architecture; it is no longer on the live path.

**CSS parser**: `src/compiler/css.ts` (687 L), hand-written, dependency-free, **build-time only**. Selectors supported: type, `.class`, `#id`, descendant combinator, `:hover`/`:active`/`:focus`. Child/sibling combinators are a hard compile error. Properties (from the `expandDeclaration` switch): background(-color), color, border + longhands, border-radius, padding/margin (shorthand + longhands), display, flex-direction, flex-wrap, justify-content, align-items/self, justify-items/self, flex/-grow/-shrink/-basis, gap/row-gap/column-gap, grid-template-columns/rows, grid-column/row, aspect-ratio, position, top/right/bottom/left, width/height, min/max-width/height, font-size, font-weight. Percentages, at-rules and unknown properties are rejected or warned, never silently reinterpreted.

**Style system**: 46 fields in `src/ir.ts` `STYLE_FIELDS`, each tagged `[name, ctor, inherited, affectsLayout]`. Interning is over the *vector* of a style's values across all variants. `UNSET = 255` for u8 enums (engine then leaves Taffy's default), `AUTO = NaN` for lengths, link fields prefilled to `-1`. Inline styles work in both string and object form and beat every selector; a non-static value is a compile error.

**Paint**: `paint.rs` (285 L) draws only `draw_round_rect`, `draw_rect`, and `draw_str`. No clipping, no shadows, no gradients, no images, no SVG. Text is single-line `Font::measure_str`/`draw_str` — **SkParagraph is linked but not called**, which is why the DLL is 7.8 MB rather than the projected ~17 MB.

> *Implication:* Styling is genuinely finished enough to build components on (grid + flex + inline + variants). Painting is not — no clipping means no overflow, no scrolling, no ellipsis, and no overlay layering. Any component design that assumes a scroll container, a dropdown, or truncated text is ahead of the engine.

**The Skia/SDL3 binding surface and the frame loop**

Bun's *entire* FFI surface is 21 symbols, listed in `src/engine/host.ts:40-62`: `dziri_protocol_version`, `dziri_last_error`, `engine_create/destroy/span_count/describe/generation/tick/drain_events/grow/resize/set_input_state/hit_test/bounds/surface_info/read_pixels/encode_png/take_png/font_family/last_frame_ms/panic_for_testing`. `host.ts:5`: *"This is the **whole** FFI surface. Everything else — a style patch, a list relink, a hidden byte, a string — is a direct memory write with no call at all."*

**The loop lives in `src/window-host.ts:239-288`** and is Bun-driven:
```
while (running) {
  if (dirty) { upload(); dirty = false; }
  engine.tick();
  for (const event of engine.drainEvents()) { … }
  await Bun.sleep(8);
}
```
Events handled: `QUIT`, `CLICK` (tries `dispatchItem` for list rows, else `dispatch`), `TEXT_INPUT`, `KEY_DOWN` (only Backspace=8 and Escape=27).

Inside Rust, `engine.rs:263` `tick()` is: `pump_input → commit → resync(diff) → (layout if fresh||diff.any) → draw → present`. The engine owns hit-testing, hover/pressed/focused state, and event-driven repaint via a `needs_paint` flag. SDL3 event pump is `window.rs:136 poll()`.

**A0 step 3 is explicitly unfinished.** `engine.rs:9-17`: *"Today Bun calls `tick()`. The roadmap has the engine owning the frame loop on its own thread… That move is A0's step 3 and is deliberately not made yet."* ROADMAP.md:673 names it the immediate next step. Consequence, stated at `src/window-host.ts:286`: a long computation in Bun stalls resize.

> *Implication:* There is no engine-side frame scheduler yet, so anything needing time (transitions, animations, caret blink, Suspense timeouts) has no host. Also note Bun polls on an 8 ms sleep — the current loop is not event-blocking, so 'idle' still costs a wakeup 125×/sec.

**Reactivity, retained tree and dirty tracking — where each actually lives**

There is **no scene graph and no retained widget tree in TypeScript**. The retained structure is (a) the flat node/style/state/list tables in `ui.gen.ts`, mutated in place, and (b) the Taffy tree inside Rust, rebuilt from those tables.

Dirty tracking is three-layered:
1. Bun: one `let dirty = true` boolean in `src/window-host.ts:78`, set by `subscribeBindings` / `subscribeLists` / `subscribeStylePatches`.
2. The upload boundary: `Uploader` re-uploads nodes/styles/states/lists wholesale (small, contiguous) but **strings incrementally**, keyed on `#uploaded[slot]`, because re-encoding a 2000-row list per keystroke isn't free.
3. Rust: `Tables::commit()` memcmps span-by-span and returns a `Diff { structure, styles, node_styles, text, changed_styles, changed_strings, any }`. `engine.rs:303 resync()` turns that into minimum work — a colour-only patch never reaches Taffy; a changed string marks only that node dirty.

NOTES.md:47: *"Three arenas, not one. `staged` is what Bun writes; `live` is what the engine reads; `bounds` is layout output flowing the other way… that diff is what earns the memory."*

Dynamic lists are arenas, not reconciliation (`src/runtime/list-runtime.ts`, 357 L): items are homogeneous, a reorder is a child-chain permutation plus slot rewrites, no node moves and no id is ever invalidated. Keys are **mandatory** — a type error *and* a compile error — because focus is a node id.

> *Implication:* The dirty/diff machinery is unusually good and already handles the hard part (paint-only vs. relayout). A router built on `hidden` toggling would ride this for free: `hidden` is a real schema field honoured by layout, paint and hit-testing in Rust. Note, though, that the compiler-side conditional-visibility feature (`<When cond>`) is listed in NOTES.md:736 as **still open** — the runtime supports it, the compiler doesn't emit it.

**Windowing today: exactly one window, no App concept, no multi-window path**

`src/window-host.ts:126` creates the only window in the codebase:
```
const engine = Engine.open({ ...capacitiesFor(ui), width: 1040, height: 560,
  title: "dziri — compiled UI", root: ui.root, windowed: screenshotPath === null });
```
Size, title and root are hardcoded in the host file. `EngineConfig` (`engine.rs:81`) carries `width, height, …, windowed: u8, decorated: u8, title, title_len` — the config for *one* window. `Engine` holds `window: Option<Window>` (singular), and `Window::new` calls `sdl3::init()` per instance.

Window chrome is plumbed but undecided — `window.rs:59`: *"Window chrome has to be decided when the window is created — macOS traffic lights, Windows DWM dark title bars and Linux CSD all hang off it, and none can be changed afterwards without recreating the window."* ROADMAP A0 step 6: "plumbed (`decorated` is fixed at window creation), **not decided**."

ROADMAP.md:571 (D2) is a committed cut: *"**Multiple windows, tray and native menus are cut from v1** — single-window apps are the large majority of desktop products, and shipping one window well beats shipping several badly."* It is repeated in the critical-path diagram: "deferred past v1: … multi-window."

> *Implication:* Directly contradicts open question 1's premise. An `<App>` owning multiple `<Window>` components requires either N `Engine` instances (each running `sdl3::init()` — likely a conflict, untested) or an engine refactor to one SDL context with many windows/surfaces. That is real Rust work on an explicitly deferred item. Worth deciding whether `<App>`/`<Window>` is an *authoring* shape adopted now with a single-window implementation, or an actual multi-window commitment that reverses a recorded v1 cut.

**Nothing router-shaped exists, and the compiler is single-entry**

Grepping `src/` for router|route|page|navigate returns **zero** hits other than the word 'page' in benchmark prose. There is no navigation, no history, no params, no search-params, no loaders, no code-splitting, no lazy anything.

The compiler CLI (`src/compile.ts:36-42`) resolves exactly one input pair:
```
function defaultInput() { const tsx = join(ROOT,"app","app.tsx"); return existsSync(tsx) ? tsx : join(ROOT,"app","app.html"); }
const inputPath = positional[0] ?? defaultInput();
const cssPath  = positional[1] ?? join(ROOT,"app","app.css");
```
One tree in, one `ui.gen.ts` out, one flat node table, one `root`. `src/window-host.ts:45` hardcodes `import * as generated from "../app/ui.gen.ts"`.

Also absent, and relevant to a TanStack-style API: there is no async primitive anywhere. Signals are synchronous; `computed` is lazy-sync; `batch` is sync. Loaders returning promises, deferred data, and pending/error states would all be new runtime concepts, and NOTES.md's ledger of "what must stay dynamic" currently lists only six items (state values, list cardinality/order, text advances, hit-testing, window size, one dirty bit).

> *Implication:* Both router candidates are unconstrained by existing code — but they are not equally cheap. Convention-over-config (a) is nearly free: route files are components, and the compiler already gets a tree by importing a module. TanStack-style typed route objects (b) require inventing loaders and therefore async, validation, and pending states — none of which have a substrate, and all of which push work into the runtime, which the governing principle treats as the thing to be justified.

**Design docs: no CLAUDE.md or AGENTS.md; NOTES.md + ROADMAP.md are the record**

There is no CLAUDE.md, no AGENTS.md, no README, no `.claude/` dir in the repo. The two docs are `NOTES.md` (45,349 bytes) and `ROADMAP.md` (40,881 bytes), both last written 2026-07-30.

The governing principle appears verbatim in both. ROADMAP.md:194: *"Every runtime feature is assumed to be compile-time unless it can be proven that it must remain dynamic."* followed by: *"This is a **scope containment** strategy as much as a performance one: it is what prevents slow drift into building a browser. Every change should answer *can this disappear at compile time?* before adding runtime code."*

NOTES.md:10 adds the operational form: *"For every feature, in order: can the compiler **resolve** it? **precompute** it? **emit variants** for it? does the runtime **really need to know** about it?… Anything that lands in the runtime should come with a note saying which question was answered 'no'."*

Other decisions already recorded and worth not re-deriving: scope boundary is layout, not parsing (ROADMAP:201); committed non-goals are "floats, tables, writing modes, fragmentation, multi-column, print" (ROADMAP:213); "Tailwind defines the CSS subset" (ROADMAP:216); the DOM-compatibility layer is dead, with the disagreement between two reviewers recorded rather than resolved (ROADMAP:499); "Refs, not selectors" for imperative handles, with `query()` surviving only for explicitly tagged nodes (ROADMAP:473); and rich text editing is *deliberately not budgeted* (ROADMAP:420).

> *Implication:* Whatever is decided for the component model and router should be written into ROADMAP.md in the same register — these docs are the project's actual memory and they preserve reasoning, not just conclusions. Also: a CLAUDE.md does not exist and arguably should, since the governing principle currently lives only in prose an agent may not read.

**Build pipeline: how source becomes a running app today**

Three steps, all in `package.json` scripts:
1. `bun run engine` → `cd native-src/dziri-engine && cargo build --release` → `target/release/dziri_engine.dll` (7.81 MB). Requires **MSVC 14.4x** — VS 17.6 / MSVC 14.36 fails to *link* with missing `__std_*` STL intrinsics; verified working on MSVC 14.44.35207 / VS 17.14. Windows also needs `advapi32`, `shell32`, `oleaut32`, `version` linked explicitly.
2. `bun run compile` → `bun run src/compile.ts` → `app/ui.gen.ts`.
3. `bun run app` → `bun run src/app.ts`, which `dlopen`s the DLL (`host.ts:64` searches `native-src/dziri-engine/target/release/` then `native/<platform>-<arch>/`), reads the span descriptor, wraps every span as a typed array, uploads, and enters the loop.

`bun run dev` chains 2+3. `bun run shot` renders headless to a PNG. `bun run gen:protocol` regenerates both sides from `src/protocol/schema.ts`.

**Verified live during this scout**: `bun run compile` succeeded — *"126 nodes, 48 style slots (47 baseline), 48 strings / 2 conditional class(es): .light 77 writes, .compact 22 writes +relayout / 18234 bytes of IR, 32.9ms"*. `bun test` → **12 pass, 0 fail, 58 expect() calls, 162 ms** (all in `src/engine/upload.test.ts`).

No bundler, no `bun build --compile` step, no packaging, no hot reload, no dev server, no CLI. Stale artifacts from the retired TS runtime still sit in `native/win32-x64/`: `SDL3.dll`, `libSkiaSharp.dll`, `taffy_ffi.dll`, `probe.json` — NOTES.md:480 confirms *"nothing fetches `libSkiaSharp` or `SDL3.dll` any more, because the engine links its own."*

> *Implication:* The pipeline is a working two-command loop but has no notion of multiple compilation units. Adding a router means the compiler must emit more than one IR module (or one module with multiple roots), and the host must stop hardcoding a single `import` of `ui.gen.ts` — both are contained changes on the Bun side, which is the cheap side.

**Existing authoring surface — what a component model must stay compatible with**

The full authored API today, all exercised in `app/app.tsx` (187 L) and `app/state.ts` (76 L):
- `cn("btn", { light: isLight })` — returns a marked *object*, not a string, "because by the time a string exists the connection to the signal is gone" (`jsx-runtime.ts:236`). Compiles to style-table writes.
- `{signal}` in child position — recognised by identity. `{signal.value}` does **not** work for scalars (NOTES.md:678: a primitive can't be proxied, boxing would break `===`).
- `todos.map(fn, { key: t => t.id })` — `map` is a method on the signal; the callback runs once with a recording proxy (`src/compiler/item-path.ts`), so `t.title` yields a path. `.value.map(…)` also works via a compile-time array proxy; `[...todos.value].map(…)` deliberately takes the static path.
- `onClick={fn}` — module-level exported function; inside a list item it receives `(item, index)`.
- `bindValue={draft}` — routes keystrokes into a string signal while focused; displays its own value when childless.
- `style="…"` / `style={{…}}` — build-time, beats every selector, numbers are px except a UNITLESS set.
- `<Fragment>` / `#fragment`, and `cond && <div/>` (falsy children dropped).

Constraints baked in: a `map` callback must return exactly one element ("item subtrees are a fixed stride in the arena"); props cannot be spread onto a recorder (`{...t}` is a compile error); per-row conditionals must be data, not markup (`app/state.ts` computes `mark` in a `computed` for exactly this reason).

> *Implication:* A component model can be layered on this without breaking it — `<App>`/`<Window>` would just be function components that the JSX runtime expands. The friction is that these are *build-time* components, so `<Window title={someSignal}>` would be a compile error under the same rule that rejects `style={{color: signal}}`. Worth deciding early whether Window/route props are static-only.

**Open questions**

- Is `<App>`/`<Window>` intended as an authoring shape implemented over today's single window, or a real multi-window commitment? The latter reverses ROADMAP D2's explicit v1 cut and requires Rust work (`Engine` holds `window: Option<Window>` and each `Window::new` calls `sdl3::init()` — multiple engines in one process is untested).
- A router implies more than one page tree, but the compiler emits exactly one flat IR module with one `root`. Which model: (a) all routes compiled into one node table with `hidden` toggling the inactive subtrees — cheapest, rides the existing diff machinery, but `<When cond>`/hidden is listed in NOTES.md as an unbuilt compiler feature; or (b) one `ui.gen.ts` per route plus an engine-level table swap — needs `dziri_engine_grow`/re-describe semantics that exist but have never been driven this way?
- TanStack-style loaders require an async primitive. `src/runtime/signal.ts` has none — signal, computed and batch are all synchronous, and NOTES.md's ledger of irreducibly-runtime concerns does not include async. Is adding a promise/pending substrate acceptable under the compile-time-first principle, and what would the ledger entry say?
- Given components are erased at build time and signals must be module-level exports, where does per-route state live? A route with its own state has the same problem the docs describe for components — 'a signal created inside a component has nowhere to live.' Does each route file own module-level signals (works today), or is per-instance state actually needed?
- The engine does not own a frame loop yet (A0 step 3, named as the immediate next step). Route transitions, animated navigation and any Suspense-like pending UI all need a scheduler. Should the router design wait on step 3, or be specified assuming Bun-driven ticks?
- No clipping exists in `paint.rs`, so there is no overflow, no scrolling and no overlay layer. Does the component model need to avoid scroll containers and popovers entirely for now, or does the router/App work depend on A4 landing first?
- Should a CLAUDE.md be added? The governing principle, the module-level-exports rule, the `.value` limitation and the MSVC 14.4x floor are all load-bearing and currently live only in 45 KB of prose an agent may not read.
- The auto-memory file `skia-proto-architecture.md` says 'no Rust runtime', which is now false — should it be corrected before it misleads a future session?


---

# Appendix B — Candidate designs

Four designs produced independently from the same scouting brief. The two router
options were each written as the *strongest possible* version of their idea, then
judged against each other in Appendix C.

### Cell Bindings — a compiled signal graph over a static arena (no VDOM, no runtime node objects, no recomposition)

**Thesis.** Commit to signals, but not to the retained *object* scene graph that every prior-art signal framework pairs them with. In dziri the retained tree is already a set of compile-time-allocated flat typed arrays (`nodes`, `styles`, `strings` in `app/ui.gen.ts`) that are memcpy'd into shared arenas and read by Rust. So a "binding" is not "an effect that mutates a node" — it is a compiled write of one integer or one string into a **statically known cell index**. There are no JS node objects at all, which is strictly stronger than Solid/Svelte/Vapor (who must mutate real DOM nodes) and categorically cheaper than Compose (whose slot table exists only to recover, at runtime, identity a compiler already knows). Reject recomposition outright: it deliberately erases the static/dynamic distinction — every composable is potentially recomposable, so nothing can be proven static — which forfeits the one optimization uniquely available here, namely that a subtree with zero bindings is *constant data* and costs nothing forever. The compiler's job is therefore to produce three artifacts: (1) constant arena data, (2) a finite, named table of dynamic holes, each carrying its dependency set and its **dirty plane** (PAINT / TEXT / LAYOUT / STRUCTURE), and (3) nothing else. Compose achieves plane separation only through developer discipline (`Modifier.drawBehind` vs `.background`); dziri derives it automatically from `STYLE_FIELDS[i].affectsLayout`, which already exists in `src/ir.ts:78`. The one genuinely new runtime mechanism I add is a **construction pass**: components run exactly twice — once at build (to produce the tree) and once at process start (to materialize signal/handler objects, harvested by ordinal) — and never again. That single move deletes NOTES.md's hardest authoring rule ("signals and handlers must be module-level exports") without admitting a VDOM, a scheduler, or per-frame execution.

**API sketch**

// ============================================================================
// 1. THE AUTHORED SURFACE
// ============================================================================
// windows/main/pages/counter.tsx
/** @jsxImportSource ../../../src/compiler */
import { signal, computed, effect, afterLayout, resource, ref, context, cn, bind }
  from "dziri";

// --- custom "hooks" are just build-time factories. No rules-of-hooks. --------
function useDisclosure(initial = false) {
  const open = signal(initial);                 // legal in a branch, a loop, anywhere
  return { open, toggle: () => (open.value = !open.value) };
}

// --- context is a build-time scoping mechanism with ZERO runtime artifact ----
const Theme = context<{ accent: string }>();

function Badge({ text }: { text: string }) {   // erased; leaves 2 nodes, 0 bindings
  return <span className="badge">{text}</span>;
}

export default function Counter() {
  const count   = signal(0);                          // signal ordinal 0
  const doubled = computed(() => count.value * 2);    //               1
  const hot     = computed(() => count.value > 9);    //               2
  const { open, toggle } = useDisclosure();           //               3
  const panel   = ref();                              // -> a node id, resolved at build
  const accent  = Theme.use();                        // resolved at build, emits nothing

  effect(() => console.log("count:", count.value));       // post-commit, auto-tracked
  afterLayout(() => console.log(panel.bounds().height));  // reads the bounds arena

  return (
    <div ref={panel} className={cn("counter", { hot })}>
      <Badge text="live" />
      <p className="readout">{count} clicks · {doubled} doubled</p>

      {/* tier-2 dynamic style: bind() marks the hole, same verb as text */}
      <div className="bar" style={{ width: bind(doubled), background: accent }} />

      <button className="bump" onClick={() => count.value++}>bump</button>
      <button className="more" onClick={toggle}>details</button>

      {/* both branches compile into the arena; one `hidden` byte selects */}
      <Show when={open}>
        <p className="detail">expanded</p>
      </Show>
    </div>
  );
}

// ============================================================================
// 2. ASYNC — resource + Suspense
// ============================================================================
const user = resource(() => fetch(`/api/user/${id.value}`).then(r => r.json()));
// user.state: "pending" | "ready" | "stale" | "error"
// user.value, user.error, user.refetch()

export function Profile() {
  return (
    <Suspense fallback={<Spinner />}>
      <p className="name">{computed(() => user.value?.name ?? "")}</p>
    </Suspense>
  );
  // The compiler walks this subtree, collects every `resource` any binding under
  // it depends on, and emits `{ content: 14, fallback: 27, sources: [0] }`.
  // No thrown promises. No runtime boundary search. The boundary's source set is
  // a COMPILE-TIME fact because the dependency set of every binding already is.
}

// ============================================================================
// 3. LISTS — unchanged, already correct (src/runtime/list-runtime.ts)
// ============================================================================
todos.map(t => (
  <div className="todo" onClick={toggleDone}>
    <span className="mark">{t.mark}</span>
    <span className="title">{t.title}</span>
  </div>
), { key: t => t.id });
// `key` is compiled away into an ItemPath (item-path.ts recorder) — a property
// path, not a runtime function. Items are homogeneous so a reorder is a child-
// chain permutation + slot rewrite. No node ever moves; no id is invalidated.

// ============================================================================
// 4. RULINGS ON EVERY REACT PRIMITIVE
// ============================================================================
// useState          KEEP, REDESIGNED -> signal(). Creatable anywhere (construction
//                   pass gives it an ordinal). Lowers to: a JS object + an entry in
//                   the harvested `s[]` array. Deletes NOTES.md:587's export rule.
// useEffect         KEEP, REDESIGNED -> effect(). Auto-tracked (effects are few),
//                   runs POST-COMMIT after engine.tick(). No dep array — REJECTED,
//                   deps are the signals read.
// useLayoutEffect   KEEP, REDESIGNED -> afterLayout(). Runs after tick() and reads
//                   the bounds arena, which Rust wrote this same frame. A real
//                   layout effect with zero extra passes — the bounds arena
//                   (NOTES.md:47) already flows the other way.
// useMemo           COMPILE-AWAY or -> computed(). Pure-of-constants folds at build
//                   (the compiler evaluates the module). Signal-derived is computed(),
//                   which already exists, is lazy, and short-circuits on Object.is.
// useCallback       REJECT. Its only job is referential stability for a reconciler
//                   comparing props. There is no reconciler and no runtime props.
//                   Handler identity is a compile-time constant: handlers[] is a
//                   fixed table keyed by node id.
// React.memo        REJECT. Nothing re-renders.
// forwardRef        REJECT. A ref is a node id assigned at build; it has no owner.
// useRef (box)      COMPILE-AWAY -> a plain `let` in the component closure.
// useRef (handle)   KEEP, REDESIGNED -> ref(). Lowers to a compile-time INTEGER.
//                   `panel.node === 37`. .bounds() reads the bounds arena, .focus()
//                   calls engine.setInputState. This is ROADMAP C3, unbuilt, cheap,
//                   and is the only sanctioned imperative escape hatch
//                   (ROADMAP:473 "Refs, not selectors").
// useContext        COMPILE-AWAY ENTIRELY. Provider/consumer chain is statically
//                   known because the tree is. A static value inlines into the style
//                   table or string table; a signal value degenerates into an
//                   ordinary binding on that signal. Runtime artifact: none.
// Suspense          KEEP, REDESIGNED -> two compiled sibling subtrees +
//                   complementary `hidden` bytes. See compile_story.
// Error boundary    KEEP, REDESIGNED, and NARROWED. "Render threw" cannot happen at
//                   runtime — that class is now a compile error. Boundaries catch
//                   handler / effect / resource failures only. Lowers to the same
//                   two-subtree + hidden mechanism, plus `nodeBoundary: Int16Array`
//                   (nearest enclosing boundary per interactive node, resolved at
//                   build) so dispatch() finds the boundary with an array index.
// useTransition     REJECT. Solid implements it by CLONING THE REACTIVE GRAPH and
// useDeferredValue  dual-rendering — the most expensive machinery in its codebase.
//                   Its use case is solved structurally: because a Suspense fallback
//                   and its content BOTH exist in the arena, "keep showing stale
//                   content while refetching" is free (state "stale" doesn't flip the
//                   boundary). Debounce is userland; it is not a framework primitive.
// createPortal      KEEP, REDESIGNED -> <Overlay>. Lowers to a compile-time LAYER
//                   INDEX on a node. The node stays in the tree (so context,
//                   handlers, style inheritance all still work); the painter sorts
//                   by (layer, tree order). ~30 lines in paint.rs, needs NO clipping,
//                   so dropdowns/tooltips/dialogs do not have to wait for A4.
// key               KEEP AS IS. Already mandatory — a type error AND a compile error
//                   (jsx-runtime.ts:36). Load-bearing because focus is a node id.
// Fragment          COMPILE-AWAY. Already does (#fragment, spliced in flatten()).
// Custom hooks      KEEP. Plain build-time functions. The construction pass is what
//                   makes them work, and it is why useDisclosure() above is legal.

**Compile story.** ## What is erased

Function components, props, context providers, custom hooks, `cn()` objects, key
functions, and every CSS selector, specificity rule, inheritance chain and property
name. `jsx-runtime.ts:422` already states the rule ("Function components are expanded
here, at build time, and leave no trace") — I am only extending what else obeys it.

## Before / after, concretely

AUTHORED (app/counter.tsx):

    function Badge({ text }: { text: string }) {
      return <span className="badge">{text}</span>;
    }

    export default function Counter() {
      const count   = signal(0);
      const doubled = computed(() => count.value * 2);
      const hot     = computed(() => count.value > 9);
      return (
        <div className={cn("counter", { hot })}>
          <Badge text="live" />
          <p className="readout">{count} clicks · {doubled} doubled</p>
          <button className="bump" onClick={() => count.value++}>bump</button>
        </div>
      );
    }

EMITTED (app/ui.gen.ts) — 6 nodes, 4 style slots, exactly 2 dynamic holes:

    // GENERATED. No CSS, no selectors, no property names, no components.
    export const Plane = { PAINT: 1, TEXT: 2, LAYOUT: 4, STRUCTURE: 8 } as const;
    export const signalCount = 3;
    export const shapeHash = "9f2c41b0";   // guards the construction pass

    /** Tail past index 1 is mutable: text bindings own their slots. */
    export const strings = ["live", "bump", ""];

    export const styles = {                      // interned over the VALUE VECTOR
      count: 4,
      bg:     new Uint32Array ([0, 0, 0, 4280756014]),
      fg:     new Uint32Array ([4293190887, 4288782762, 4293190887, 4294243573]),
      radius: new Float32Array([0, 999, 0, 6]),
      padT:   new Float32Array([12, 2, 0, 8]),
      // …42 more fields, exactly as today
    };

    export const nodes = {                       // CONSTANT. Never written at runtime.
      count: 6,
      kind:        new Uint8Array ([0, 0, 1, 0, 1, 3]),
      style:       new Uint16Array([0, 1, 1, 2, 2, 3]),
      text:        new Int32Array ([-1, -1,  0, -1,  2,  1]),
      parent:      new Int32Array ([-1,  0,  1,  0,  3,  0]),
      firstChild:  new Int32Array ([ 1,  2, -1,  4, -1, -1]),
      nextSibling: new Int32Array ([-1,  3, -1,  5, -1, -1]),
      list:        new Int16Array (6).fill(-1),
      hidden:      new Uint8Array (6),
    };

    /** THE ONLY DYNAMIC THINGS IN THE PROGRAM. */
    export const bindings = [
      { id: 0, plane: Plane.TEXT, node: 4, slot: 2, deps: [0, 1],
        read: (s) => `${s[0].value} clicks · ${s[1].value} doubled`,
        debug: "counter.tsx:12 {count} clicks · {doubled} doubled" },
    ];

    export const patches = [
      { id: 1, plane: Plane.PAINT, deps: [2],
        entries: [{ field: "bg", slots: new Uint16Array([0]),
                    on:  new Float64Array([4281479738]),
                    off: new Float64Array([0]) }],
        debug: "counter.tsx:11 .hot" },
    ];

    export const handlerSites = new Int32Array([5]);  // node ids carrying onClick
    export const root = 0;

Note precisely what happened:

- **`Badge` is gone.** It contributed `nodes[1..2]` and `strings[0] = "live"`. Zero
  bindings, zero records, zero cost forever. This is the static-subtree flattening
  the brief identifies as uniquely available here, and it is available *because* the
  set of dynamic holes is a first-class static artifact.
- **`props.text` is gone.** It was a build-time argument.
- **`read: (s) => ...` is compiler-generated source text**, not something the author
  wrote. The author wrote `{count} clicks · {doubled} doubled`; the compiler already
  has that as five `TextPart`s (jsx-runtime.ts `normalize()` merges the run into one
  node) and emits a string-concat closure over a statically known dep set. Five JSX
  children collapse to one node, one slot, one closure.
- **Signals are named by ORDINAL (`s[0]`), not by import.** This is the change that
  removes the module-level-export rule. `ui.gen.ts` no longer imports `./state.ts`.

## The construction pass — how component-local state survives erasure

`resolve-refs.ts` currently recovers signals and handlers by *object identity* against
module exports, which is why `NOTES.md:587` makes component-local state a compile
error. That restriction is not fundamental; it is an artifact of the recovery
mechanism. A generated `.ts` module can emit data and closures-over-an-array, but it
cannot serialize a closure the author wrote. So recover by **position** instead:

    // src/runtime/construct.ts
    export function construct(entry: () => Node) {
      const s: Signal<unknown>[] = [];
      recordSignals(s);                // signal()/computed()/resource() push here
      const tree = entry();            // components run — for the SECOND and LAST time
      const handlers = new Map<number, Fn>();
      const refs: Ref[] = [];
      walkInEmitOrder(tree, (el, nodeId) => {   // same order the compiler walked
        if (el.onClick) handlers.set(nodeId, el.onClick);
        if (el.ref) el.ref.node = nodeId;
      });
      return { signals: s, handlers, refs };    // the tree is then dropped
    }

Startup becomes:

    import { construct } from "./construct.ts";
    import Counter from "../app/counter.tsx";
    import * as gen from "../app/ui.gen.ts";

    const live = construct(Counter);
    assert(live.signals.length === gen.signalCount, gen.shapeHash);
    attach(gen, live);      // wires deps -> subscriptions; see runtime_story

Components therefore run **exactly twice in their entire lifetime**: once during
`bun run compile`, once at process start before the window opens. Never per frame,
never per navigation, never per state change. Signals get ordinals from creation
order; handlers and refs get their identity from **node id**, which is Compose's
call-site-key lesson computed rather than emitted. A shape hash makes divergence a
loud startup error rather than a silently mis-wired UI.

## Suspense, natively

There is no streaming HTML and no server. What actually suspends on a desktop:
resource loads (file/network via Bun), font loads (advance widths change, so this is
a *layout* suspension), and image decode (no image support in `paint.rs` today —
future). React's mechanism is throw-a-promise / catch-at-the-nearest-boundary, which
is runtime discovery of a static fact. Compile it instead:

    <Suspense fallback={<Spinner/>}>…</Suspense>

emits **both** subtrees into the arena with complementary `hidden` bytes, plus:

    export const boundaries = [
      { kind: 0 /* SUSPENSE */, content: 14, fallback: 27, sources: [0, 4] },
      { kind: 1 /* ERROR    */, content: 40, fallback: 55, sources: [] },
    ];
    /** Nearest enclosing error boundary per interactive node. Compile-time. */
    export const nodeBoundary = new Int16Array([...]);

`sources` is the set of `resource` ordinals that any binding under `content` depends
on — derivable because every binding already carries `deps`. Runtime cost per frame:
`sources.some(i => s[i].state === "pending")`, then two byte writes. The fallback's
layout is precomputed. And the "no fallback flash on refetch" behaviour that React
needs `useTransition` for is free: `refetch()` sets `"stale"`, not `"pending"`, the
boundary does not flip, and a separate binding drives a spinner. That is the
double-buffering the brief says native frameworks do, obtained structurally.

## How CSS-like styling compiles — four tiers

Tiers 1–3 already work; tier 4 is the new ruling.

1. **Static cascade → integers.** Selector matching, specificity, inheritance and
   shorthand expansion all resolve at build into 46 numbers per node, interned over
   the value vector. Verified live: 126 nodes → 48 slots. `nodes.style[i]` is a
   `u16` and is **immutable** — engine.rs relies on that ("`nodes.style` is
   immutable by design, so this is a scan rather than a lookup").
2. **Pseudo-states are precomputed variants.** `:hover/:active/:focus` live in the
   sparse `states` table; the runtime picks one integer. Known flaw worth fixing by
   the same method: it *picks* rather than *merges*, so `:hover:focus` is wrong —
   the compile-time answer is to emit the combination as another variant.
3. **Conditional classes are style-table patches.** `cn("btn", {light: isLight})`
   writes field values into affected slots (`.light` = 77 writes, `.compact` = 22
   writes + relayout). Known flaw NOTES records: a class on a *container* restyles
   descendants (11 of 12 nodes on the sample), so this is not a per-node int swap
   and needs a subtree-invariance pruning pass.
4. **NEW — a genuinely dynamic style value becomes a cell binding.**
   `style={{ width: bind(doubled) }}` emits
   `{ plane: LAYOUT, field: "width", slot: 12, read: s => s[1].value }`.
   Two compiler obligations, both non-negotiable:
   - **De-interning.** A slot that any binding writes must be given a private,
     unshared slot, or writing it silently restyles unrelated nodes. Interning is
     over the value vector, so this is a real bug class, not a hypothetical.
   - **Plane derivation.** `STYLE_FIELDS[i][3]` (`affectsLayout`) decides PAINT vs
     LAYOUT automatically. `background` is PAINT; `width` is LAYOUT and the compiler
     says so in the stats line, because it costs a Taffy pass.

   `style={{ color: someSignal }}` (a bare signal, no `bind()`) stays a **compile
   error**, as it is today — but the message now points at `bind()` as well as at
   conditional classes.

5. **Animation does NOT go through the signal graph.** `transition: background 150ms`
   compiles to an animation record `(slot, field, from, to, duration, easing)` — pure
   data, interpolated in Rust inside the engine's own loop. The endpoints are the two
   precomputed variant slots that already exist. A signal write flips the target; no
   JS runs at 120 Hz and no signal propagates per frame. This is the cleanest instance
   of compile-time-first in the whole design: CSS transitions between two compiled
   variants are essentially free.

## What the compiler must additionally emit (all new, all cheap)

`plane` per binding · `deps` as signal ordinals · `debug` (file:line) per binding ·
`signalCount` + `shapeHash` · `boundaries` + `nodeBoundary` · `layer` per node ·
`animations` · de-interned slot marks.

**Runtime story.** ## What is left at runtime, and why each item must be

The existing ledger (NOTES.md:431) lists six irreducible concerns: current state
values, list cardinality/order, text advance widths, hit-testing, window size, one
dirty bit. This design changes exactly one line of it and adds one:

- **"one dirty bit" → "a four-plane dirty mask + a changed-node list."** Justification:
  a boolean cannot say whether Taffy must run. See the gap below.
- **NEW: "async resolution state."** Justification: a file read completes when the OS
  says so. The *boundary* it belongs to, its *fallback tree* and its *source set* are
  all compile-time; only the pending/ready/error word is dynamic. That is the ledger
  entry the brief asks for: the answer to "does the runtime really need to know?" is
  no for everything except three bytes of status.

Everything else — no reconciler, no VDOM, no slot table, no gap buffer, no owner
tree walk on the hot path, no dependency discovery (bindings are *told* their deps),
no per-frame component execution, no runtime style resolution.

## The load-bearing gap I found in the current code

`STYLE_FIELDS` carries `affectsLayout` per field (`src/ir.ts:78`). `patches.ts`
carries `affectsLayout` per patch and `applyStylePatches` returns a `Dirty` value.
**`src/window-host.ts:90-93` discards that return value and sets `dirty = true`.** Then
`engine.rs:271` runs `if self.fresh || diff.any { self.tree.compute(...) }` — so any
diff at all, including a colour-only theme toggle, triggers a full Taffy relayout.
Worse, `resync()` calls `apply_style()` for every node wearing a changed slot, and
`layout.rs:124` calls Taffy `set_style` unconditionally, which dirties the node.

The engine's own comment says a colour-only patch "reaches paint without Taffy hearing
about it at all." Today that is not true, and it cannot be made true on the Rust side,
because `Tables::commit()` is a memcmp: it can recover **which slots** changed but
never **whether the changed field affects layout**. That information exists only in
the compiler. So the plane must cross the FFI boundary. This is the single strongest
argument for the whole design — phase separation is not an optimization to add later,
it is information Bun is currently computing and throwing away.

## Signal write → screen

    handler runs
      -> signal.value = x
      -> notify(): computed INVALIDATORs still fire SYNCHRONOUSLY (bookkeeping,
         and engine-critical: skipping it double-notifies — signal.ts:62)
      -> binding subscribers do NOT run. They only ENQUEUE.
      -> planes |= binding.plane

    frame boundary (top of the loop; later, the engine's own vsync — A0 step 3)
      -> flush()   STRUCTURE, then LAYOUT, then TEXT, then PAINT
      -> upload only the touched spans into the staged arena
      -> write planes + changedNodes into the control span (no extra FFI call)
      -> engine.tick()

Deferring the flush to the frame boundary rather than to a microtask is the right
call because dziri owns the loop. It also makes `batch()` a convenience rather than a
correctness requirement: today a handler touching two signals asks for three repaints
unless it is wrapped, and `dispatch()` compensates by wrapping every handler
(`bindings.ts:121`). With frame-boundary flushing, one user action costs one frame by
construction.

## The dispatcher (replaces the current whole-document sweep)

`bindings.ts:54` admits the current design is "deliberately coarse: one callback for
the whole document" — any signal change re-evaluates *every* text binding. Correct at
126 nodes, wrong at 10k. Replace with per-binding subscription:

    // src/runtime/scheduler.ts
    const Q = [[], [], [], []];        // PAINT, TEXT, LAYOUT, STRUCTURE
    export let planes = 0;
    export const changedNodes: number[] = [];

    export function attach(gen, live) {
      for (const b of [...gen.bindings, ...gen.patches, ...gen.branches]) {
        for (const d of b.deps) live.signals[d].subscribe(() => enqueue(b));
      }
    }

    function enqueue(b) {
      if (b.queued) return;            // one enqueue per binding per frame
      b.queued = true;
      Q[log2(b.plane)].push(b);
      planes |= b.plane;
    }

    export function flush(ui, live) {
      // STRUCTURE first: growing an arena reallocates node arrays and moves slots.
      for (const b of Q[3]) applyStructure(ui, b, live);   // lists, Show, boundaries
      for (const b of Q[2]) writeCell(ui, b, live);        // layout-affecting styles
      for (const b of Q[1]) {                              // text
        const next = b.read(live.signals);
        if (ui.strings[b.slot] !== next) {
          ui.strings[b.slot] = next;
          changedNodes.push(b.node);
        }
      }
      for (const b of Q[0]) writeCell(ui, b, live);        // paint-only styles
      for (const q of Q) { for (const b of q) b.queued = false; q.length = 0; }
      const mask = planes; planes = 0;
      return mask;
    }

## What the engine then does with the plane mask

Two small, contained Rust changes:

    // engine.rs tick()
    let diff  = self.tables.commit();
    let plane = self.tables.plane_mask();          // NEW: read from the control span
    self.resync(&diff, plane)?;

    let geometry = plane & (LAYOUT | TEXT | STRUCTURE) != 0;
    if self.fresh || (diff.any && geometry) {      // was: if self.fresh || diff.any
        self.tree.compute(...)?;
        self.needs_paint = true;
    } else if diff.any {
        self.needs_paint = true;                   // paint-only: Taffy never hears
    }

    // resync(): skip apply_style entirely when plane == PAINT — the values Taffy
    // reads did not change, only the ones the painter reads.

Result per plane:

| Plane     | Bun writes                  | Taffy                          | Skia |
|-----------|-----------------------------|--------------------------------|------|
| PAINT     | style cells                 | **untouched**                  | repaint damage |
| TEXT      | `strings[slot]`             | `mark_dirty(node)` — that node only (already implemented, engine.rs:339) | repaint damage |
| LAYOUT    | style cells                 | `apply_style` on nodes wearing the changed slot (already implemented) | repaint damage |
| STRUCTURE | child chain / `hidden` byte | `rebuild` or restyle           | full repaint |

## Damage tracking and partial repaint

`draw()` currently does `canvas.clear(Color::BLACK)` and repaints everything whenever
`needs_paint`, and `paint.rs` has no clipping at all — only `draw_round_rect`,
`draw_rect`, `draw_str`. **So today the PAINT plane saves Taffy but saves Skia
nothing.** Being honest about that matters: half the payoff needs new Rust.

The design: Bun already knows exactly which nodes changed (the binding says so), so
it writes `changedNodes` into a span. Rust unions each node's bounds — old and new,
both available in the bounds arena — plus the bounds of every node wearing a changed
style slot, into one damage rect. Then:

    canvas.save();
    canvas.clip_rect(damage, ClipOp::Intersect, false);
    canvas.clear(...);                    // only inside the damage rect
    self.painter.paint(...);              // skip nodes whose bounds miss the rect
    canvas.restore();

A caret blink or a hover highlight then costs one small rect instead of a full
surface. This is also the natural place to land the first `clipRect` call, which A4
(overflow/scrolling) needs anyway — so damage tracking and clipping are one piece of
work, not two.

## Structural updates without a VDOM

Three mechanisms, in ascending cost, and there is no fourth:

1. **`hidden` byte** — `<Show>`, Suspense boundaries, error boundaries, route
   branches. Both subtrees exist in the arena permanently; one byte selects. This is
   "emit variants" applied to structure. **Caveat found in the code:** flipping
   `hidden` currently sets `diff.node_styles`, and `resync` responds with
   `apply_all_styles()` — an O(n) restyle of the whole tree for a one-byte change.
   Fix: have the diff carry changed-hidden node ids so only that subtree restyles.
2. **Keyed arena relink** — `.map()`. Already built and already right
   (`list-runtime.ts`): homogeneous item subtrees, a reorder is a child-chain
   permutation, no node moves, no id is invalidated, and slots keep their key
   precisely so focus survives a reorder. Growth appends a *fresh larger arena* past
   the end rather than growing in place, so no existing id is renumbered.
3. **Arena regrowth + full re-upload** — rare, capacity doubles, and it is the only
   path that reallocates.

Deliberately absent: node creation, node destruction, node movement, subtree diffing.
The boundary where a runtime-reconciled *island* would earn its place is recursive
structures (trees), which need an arena per node, i.e. an allocator — NOTES.md
already names this and it is correctly out of scope.

## Devtools and HMR — the honest counterweight

The brief is right that a run-once signal model loses Compose's and Flutter's best-in-
class hot reload, and that a closure graph is less inspectable than a slot table. Two
mitigations, both cheap here and both hard to retrofit:

- **Devtools:** every binding carries `debug: "counter.tsx:12 {count} clicks"` and a
  plane. "Why did this repaint?" answers with a finite, named, compile-time-enumerated
  table — strictly better introspection than either Solid (anonymous closures) or
  Compose (positional slots with no source mapping).
- **HMR:** recompile → new `ui.gen.ts` → re-run the construction pass → match signals
  by ordinal, carry values over where `shapeHash` matches, re-upload all tables. Full
  re-upload is acceptable because the IR is 18 KB and `uploadAll()` already exists.
  State survives when the signal set is unchanged; it resets loudly when it is not.

## Ownership and disposal

Module-level signals dodge this today. Effects do not: an effect holds a closure and a
subscription. Because components never unmount (there is no unmounting — `hidden`
does not destroy), the only disposal boundary that exists is a **window**. So: every
signal, effect and resource belongs to the window whose construction pass created it,
and closing a window disposes that scope. There is no per-component owner tree,
because there are no component instances to own anything. This is a much smaller
problem than Solid's, and it is a direct consequence of choosing erasure.

**Tradeoffs**

- Components run exactly twice — once at build, once at startup — which buys component-local state and custom hooks, but costs a full Element-tree construction at process start (transient, dropped immediately) and requires the two evaluations to agree. A shape hash makes divergence a loud startup error rather than silent mis-wiring.
- Both branches of every conditional live in the arena permanently. `<Show>`, `<Suspense>` and error boundaries all trade node count for a one-byte structural update. Excellent for a spinner or an expanded panel; nested conditionals multiply node count, so the compiler must report the materialized/live node ratio in its stats line and warn past a threshold.
- Suspense boundaries have a compile-time source set, so a resource cannot be created conditionally at runtime and attach itself to an enclosing boundary. Every resource a boundary can wait on must be reachable from a binding under it at build time. This is the price of deleting React's throw-a-promise machinery.
- No transitions and no cross-fade page changes come for free. Keeping stale content during a refetch is structural and free; genuinely animating between two different trees requires an explicit animation record with both trees materialized.
- Signals can only be created during the construction pass. There is no lazily-created state after startup — except list items, where per-row state must be *data in the array* (the existing `view` computed in app/state.ts already demonstrates the pattern, and it is the right one).
- Per-binding subscription replaces the current one-callback-for-the-whole-document sweep. That is correct at scale but adds a Set entry per (signal, binding) pair; at high binding counts this wants alien-signals-style intrusive linked lists rather than a Set per signal, which is a later swap, not a redesign.
- Deferring binding flush to the frame boundary changes `batch()` from a correctness requirement to a convenience, and changes the observable timing of `bindings.ts`/`patches.ts`. Computed invalidation must stay synchronous (signal.ts:62 documents exactly why), so the two paths diverge and that split has to be maintained deliberately.
- The plane mask must cross the FFI boundary as data. That is a protocol change — a new field in `src/protocol/schema.ts`, regenerated to both sides — so it touches the one interface the project deliberately keeps narrow.
- A dynamic style value forces its slot to be de-interned, which costs style-table slots and partially erodes the 126-nodes→48-slots compression. Tier-4 bindings should be rare by design and the compiler should say how many exist.

**Risks**

- Construction-pass determinism is the central bet. If a component body branches on anything non-deterministic (a date, a random, an env read), signal ordinals diverge between the build run and the startup run and the UI mis-wires. Mitigated by the shape hash, but the failure mode must be a hard startup abort with the diverging ordinal named — never a warning.
- De-interning is a silent correctness trap. If the compiler forgets to un-share a slot that a tier-4 binding writes, changing one node's width changes every unrelated node that happened to intern to the same value vector. This needs a test in `src/engine/upload.test.ts` before the feature ships, not after.
- Damage rects need `clip_rect` in paint.rs, bounds intersection, and old-vs-new bounds retention. It overlaps A4 (overflow/scrolling), which does not exist. Until it lands, the PAINT plane saves Taffy but not Skia, so the headline claim is half-realized. Do not present it as done.
- Flipping `hidden` currently sets `diff.node_styles`, and `resync` answers with `apply_all_styles()` — an O(n) restyle of the entire tree for a one-byte change. Since `<Show>`, Suspense and error boundaries all ride on `hidden`, the cheapest conceptual operation in the design is currently the most expensive one in the engine. Fix the diff to carry changed-hidden node ids before building anything on top of it.
- Effects introduce disposal and leak surface that module-level signals currently avoid entirely. With FFI-backed Skia resources downstream, a leaked subscription is more expensive than in the DOM. Window-scoped disposal is the whole answer and must be designed in now, not retrofitted onto a closure-captured graph.
- The plane derivation is only as good as `STYLE_FIELDS[i][3]`. `borderWidth` is currently marked paint-only on the reasoning that borders stroke inset — true today, wrong the moment box-sizing or outline lands. A mis-tagged field produces a stale layout, which is a wrong-looking frame rather than a crash: the same failure class as a wrong byte offset, and it deserves the same treatment (derive, never restate).
- Deleting the module-level-export rule removes a constraint that `resolve-refs.ts` currently enforces with a good error message. If the construction pass ships half-built, authors get a worse experience than today. It should land as one change with its own tests, not incrementally.
- Both-branches-materialized interacts badly with the router if routes compile into one node table with `hidden` toggling — N routes means N materialized page trees in the arena at all times. That is a fine default for a handful of routes and untenable for fifty; the reactivity model and the router model have to agree on this number before either is fixed.
- `<Overlay>` as a paint layer index assumes the painter can sort by (layer, tree order) without clipping. That is true for dropdowns and tooltips over an unclipped surface, and stops being true the moment a scroll container exists — at which point layers and clipping have to be reconciled in one pass rather than two.

---

### Option B — the route object as a build-time manifest (TanStack shape, zero TanStack runtime)

**Thesis.** TanStack Router's ceremony exists because TanStack has no compiler: `createFileRoute('/posts/$postId')` restates the path so a `declare module` augmentation can hang types off a *runtime* object, and `validateSearch: z.object(...)` ships Zod into the bundle because nothing else can read the schema. dziri's compiler literally `import()`s and evaluates the .tsx module (`src/compile.ts:63-70`, `setCompiling(true)`), so it does not read the route object as source — it holds the object. That inverts the economics completely: the route export becomes a **build-time manifest literal** whose fields are consumed by the compiler and then deleted. No path argument (the filesystem already said it), no `getParentRoute` (the directory tree said it), no schema library (the compiler lowers `p.uuid()` into six lines of straight-line decoder and emits nothing else). What survives is a handful of typed arrays, a generated `parse()` switch, a per-window navigation stack, and — the one genuinely new thing — a promise cell for routes whose loader is actually async. And that last point is the argument that makes Option B *more* compile-time-first than Option A, not less: a plain route component cannot tell the compiler whether it needs async, so every route pays for the substrate; a route object declaring `loader` lets the compiler prove that a route reading SQLite is synchronous and emit **no pending subtree, no promise cell, no boundary node at all** for it. Ceremony that lets the compiler delete machinery is ceremony that pays for itself.

**API sketch**

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE WINDOW KIND  —  windows/main/index.tsx
//    A window *kind*, compile-time enumerable. `pages/` next to it opts this
//    window into a router; a window with no pages/ just mounts its default.
// ═══════════════════════════════════════════════════════════════════════════
/** @jsxImportSource dziri/compiler */
import { createWindow } from "dziri/app";
import { Sidebar } from "./chrome/sidebar.tsx";

export const Window = createWindow({
  title: "dziri — projects",
  size: { width: 1040, height: 560, minWidth: 720 },
  // Fixed at creation, per window.rs:59 — traffic lights / DWM / CSD all hang
  // off it and none can change afterwards. So it is compile-time by nature.
  chrome: "native",
  router: "pages",
});

/** The window shell. `outlet` is a build-time marker node, not a runtime slot. */
export default function Shell({ outlet }: { outlet: JSX.Element }) {
  return (
    <body>
      <div className="app">
        <Sidebar />
        {outlet}
      </div>
    </body>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// 2. A ROUTE  —  windows/main/pages/projects/$projectId/index.tsx
//    Note what is NOT here: no path string, no parent reference, no zod.
// ═══════════════════════════════════════════════════════════════════════════
/** @jsxImportSource dziri/compiler */
import { createFileRoute, p, s } from "dziri/router";
import { db } from "../../../../state/db.ts";

export const Route = createFileRoute({
  params: { projectId: p.uuid() },

  search: {
    tab:  s.enum(["files", "runs", "settings"]).default("files"),
    page: s.int({ min: 1 }).default(1),
    q:    s.text().optional(),
  },

  static: {
    title: "Project",
    keepAlive: 3,              // cache 3 (projectId) instantiations
    preload: "sibling",        // preload one-hop routes on activation
    deepLink: "focus-or-open", // dispatch policy, compiled into the URL table
  },

  loaderDeps: ["projectId"],   // compile-time key set -> fixed-arity cache key

  // SYNCHRONOUS. The compiler sees a non-async function whose return type is
  // not a Promise, and therefore emits no pending subtree and no promise cell
  // for this route. `pending` here would be a compile error.
  loader: ({ params }) => db.project(params.projectId),

  error: Failed,
});

export default function ProjectPage() {
  return (
    <div className="page">
      {/* Route.data is a recorder at build time (same machinery as item-path.ts),
          so this compiles to a text binding with path ["name"] against the
          route's data cell. No new runtime concept — this is exactly what
          listBindings already do for `{t.title}`. */}
      <div className="page-title">{Route.data.name}</div>
      <div className="meta">{Route.data.fileCount} files · {Route.search.tab}</div>

      <div className="list">
        {/* The compiler synthesises computed(() => Route.data.value.files) and
            registers it as the list source, so this is an ordinary arena. */}
        {Route.data.files.map(
          (f) => <FileRow name={f.name} size={f.size} onClick={openFile} />,
          { key: (f) => f.id },
        )}
      </div>
    </div>
  );
}

function Failed() {
  return <div className="error">{Route.error.message}</div>;
}


// ═══════════════════════════════════════════════════════════════════════════
// 3. AN ASYNC ROUTE  —  windows/main/pages/projects/$projectId/runs.tsx
//    This one genuinely needs the substrate, and only this one links it.
// ═══════════════════════════════════════════════════════════════════════════
export const Route = createFileRoute({
  params: { projectId: p.uuid() },
  loaderDeps: ["projectId"],
  loader: async ({ params, signal }) => api.runs(params.projectId, signal),
  pending: RunsSkeleton,   // compiled into a sibling subtree under the boundary
  error:   RunsFailed,     // ditto
  static:  { keepAlive: 1, preload: "intent" },
});

export default function RunsPage() {
  return <div className="runs">{Route.data.rows.map(/* … */)}</div>;
}


// ═══════════════════════════════════════════════════════════════════════════
// 4. THE AUTHORED API  —  dziri/router (types only; all of it is erased)
// ═══════════════════════════════════════════════════════════════════════════
declare const CODEC: unique symbol;
export type Codec<T> = { readonly [CODEC]: T; kind: string; opts: unknown };

/** Closed, compiler-known vocabulary. Each one lowers to inline code. */
export declare const p: {
  int(o?: { min?: number; max?: number }): Codec<number>;
  uuid(): Codec<string>;
  slug(): Codec<string>;
  text(): Codec<string>;
  enum<const E extends readonly string[]>(e: E): Codec<E[number]>;
  /** Escape hatch. Keeps a function reference at runtime — the compiler
      reports it as "answered no", in the register NOTES.md uses. */
  custom<T>(decode: (raw: string) => T | null, encode: (v: T) => string): Codec<T>;
};
export declare const s: typeof p & {
  /* search adds .optional() / .default(v), both folded at build time */
};

type Infer<Spec> = { [K in keyof Spec]: Spec[K] extends Codec<infer T> ? T : never };

export declare function createFileRoute<
  const P extends Record<string, Codec<unknown>> = {},
  const S extends Record<string, Codec<unknown>> = {},
  const D extends readonly (keyof P | keyof S)[] = [],
  T = void,
>(def: {
  params?: P;
  search?: S;
  static?: StaticData;
  loaderDeps?: D;
  loader?: (ctx: { params: Infer<P>; search: Infer<S>; signal: AbortSignal }) => T;
  pending?: Component;   // compile error unless T is a Promise
  error?: Component;
}): {
  data:   ReadonlySignal<Awaited<T>>;
  params: ReadonlySignal<Infer<P>>;
  search: ReadonlySignal<Infer<S>>;
  error:  ReadonlySignal<Error | null>;
  invalidate(): void;
};


// ═══════════════════════════════════════════════════════════════════════════
// 5. NAVIGATION  —  windows/main/state/nav.ts (module-level exports, as required
//    by resolve-refs.ts — handlers must be nameable by identity)
// ═══════════════════════════════════════════════════════════════════════════
import { nav } from "dziri/router";
import { Routes, RouteId } from "../routes.gen.ts";

/** Per-row handler: receives (item, index), exactly like toggleDone today. */
export function openProject(project: { id: string }) {
  nav.push(Routes.project({ params: { projectId: project.id } }));
}

export function showRuns() {
  nav.push(Routes.projectRuns({ params: nav.params(RouteId.project) }));
}

/** Search-only navigation writes one u8; it never re-enters the loader,
    because `tab` is not in this route's loaderDeps. The compiler knows that. */
export function selectTab(tab: "files" | "runs" | "settings") {
  nav.setSearch({ tab });
}

export const back = nav.back;

/** Exhaustive over the generated union: adding a page/ file breaks this
    at compile time rather than 404-ing at runtime. */
export function titleFor(id: RouteId): string {
  switch (id) {
    case RouteId.index:       return "Home";
    case RouteId.projects:    return "Projects";
    case RouteId.project:     return "Project";
    case RouteId.projectRuns: return "Runs";
    case RouteId.settings:    return "Settings";
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// 6. THE GENERATED ARTIFACT  —  windows/main/routes.gen.ts
//    Same register as app/ui.gen.ts: no path parsing, no schema objects.
// ═══════════════════════════════════════════════════════════════════════════
// GENERATED by dziri/compile from windows/main/pages/**
// Do not edit. No path strings, no schemas, no matcher — just indices.
//
// 5 routes · 3 with params · 3 with loaders (1 async) · 1 boundary
// 412 nodes across all routes, 61 style slots (shared chrome interned once)

import { Route as R1 } from "./pages/projects/index.tsx";
import { Route as R2 } from "./pages/projects/$projectId/index.tsx";
import { Route as R3 } from "./pages/projects/$projectId/runs.tsx";
import { Route as R4 } from "./pages/settings/index.tsx";
import { nodes } from "./ui.gen.ts";

export const enum RouteId { index = 0, projects = 1, project = 2, projectRuns = 3, settings = 4 }

/** routeId -> parent, or -1. Tree order; children contiguous. */
export const parent = new Int32Array([-1, 0, 1, 2, 0]);

/** The single node whose `hidden` byte gates each route's whole subtree.
 *  Activation is one byte write per route on the divergent path. */
export const mount = new Int32Array([12, 47, 96, 231, 355]);

/** Boundary node per route, or -1. Only async routes have one. Under it sit
 *  three sibling subtrees — content / pending / error — exactly one unhidden. */
export const boundary        = new Int32Array([-1, -1, -1, 231, -1]);
export const boundaryContent = new Int32Array([-1, -1, -1, 232, -1]);
export const boundaryPending = new Int32Array([-1, -1, -1, 289, -1]);
export const boundaryError   = new Int32Array([-1, -1, -1, 301, -1]);

/** bit0 hasLoader · bit1 loaderIsAsync · bit2 hasError · bit3 preloadEager */
export const flags = new Uint8Array([0b0000, 0b0001, 0b0101, 0b0111, 0b0000]);

/** keepAlive per route: the cache is a fixed-size ring, not a Map. */
export const keepAlive = new Int32Array([0, 1, 3, 1, 0]);

/** Loader chain per route, flattened at build time. No runtime tree walk.
 *  Inner arrays are parallel groups; groups run in order. */
export const loadPlan: readonly (readonly (readonly RouteId[])[])[] = [
  [],
  [[RouteId.projects]],
  [[RouteId.projects], [RouteId.project]],
  [[RouteId.projects], [RouteId.project], [RouteId.projectRuns]],
  [],
];

/** One-hop reachability, for `preload`. Generated from the tree; CSR arrays. */
export const reachable = {
  offsets: new Int32Array([0, 2, 4, 6, 7, 7]),
  ids:     new Int32Array([1, 4, 2, 0, 3, 1, 2]),
};

/** Interned static segments. Deep-link matching is integer compares. */
const SEG = { projects: 0, runs: 1, settings: 2 } as const;

// --- decoders: straight-line, generated, no schema object exists ------------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function d_projectId(raw: string): string | null { return UUID.test(raw) ? raw : null; }
function d_tab(raw: string | undefined): 0 | 1 | 2 {
  return raw === "runs" ? 1 : raw === "settings" ? 2 : 0;   // default folded in
}
function d_page(raw: string | undefined): number {
  const n = raw === undefined ? 1 : Number(raw) | 0;
  return n >= 1 ? n : 1;                                     // min folded in
}

/**
 * Deep-link entry. Only reached from the OS — never from in-app navigation,
 * which carries typed route values and parses nothing.
 */
export function parse(url: string): RouteValue | null {
  const seg = intern(path(url));
  switch (seg.length) {
    case 0: return { id: RouteId.index, params: EMPTY, search: EMPTY };
    case 1:
      if (seg[0] === SEG.projects) return { id: RouteId.projects, params: EMPTY, search: EMPTY };
      if (seg[0] === SEG.settings) return { id: RouteId.settings, params: EMPTY, search: EMPTY };
      return null;
    case 2: {
      if (seg[0] !== SEG.projects) return null;
      const projectId = d_projectId(raw(seg[1]));
      if (projectId === null) return null;
      const q = query(url);
      return { id: RouteId.project,
               params: { projectId },
               search: { tab: d_tab(q.tab), page: d_page(q.page), q: q.q } };
    }
    case 3: {
      if (seg[0] !== SEG.projects || seg[2] !== SEG.runs) return null;
      const projectId = d_projectId(raw(seg[1]));
      return projectId === null ? null
           : { id: RouteId.projectRuns, params: { projectId }, search: EMPTY };
    }
  }
  return null;
}

/** Typed constructors. A link is a struct, not an interpolated string. */
export const Routes = {
  index:       () => ({ id: RouteId.index, params: EMPTY, search: EMPTY }) as const,
  projects:    () => ({ id: RouteId.projects, params: EMPTY, search: EMPTY }) as const,
  project:     (a: { params: { projectId: string };
                     search?: { tab?: "files"|"runs"|"settings"; page?: number; q?: string } }) =>
                 ({ id: RouteId.project, params: a.params, search: a.search ?? EMPTY }) as const,
  projectRuns: (a: { params: { projectId: string } }) =>
                 ({ id: RouteId.projectRuns, params: a.params, search: EMPTY }) as const,
  settings:    () => ({ id: RouteId.settings, params: EMPTY, search: EMPTY }) as const,
};

/** The data cells, wired to the route objects the modules exported. */
export const cells = [null, R1, R2, R3, R4] as const;

// --- generated OS registration (cannot drift from the table above) ----------
// windows/main/deeplink.plist.gen   · CFBundleURLSchemes
// windows/main/deeplink.reg.gen     · HKCU\Software\Classes\dziri\shell\open


// ═══════════════════════════════════════════════════════════════════════════
// 7. ACTIVATION  —  the entire structural cost of a navigation
// ═══════════════════════════════════════════════════════════════════════════
function activate(from: RouteValue, to: RouteValue): void {
  // `hidden` excludes the node AND its subtree from layout, paint and input
  // (ir.ts:239), so one byte per route on the divergent path is the whole job.
  for (let r = from.id; r !== -1 && !onPath(to.id, r);   r = parent[r]) nodes.hidden[mount[r]] = 1;
  for (let r = to.id;   r !== -1 && !onPath(from.id, r); r = parent[r]) nodes.hidden[mount[r]] = 0;
  dirty = true;   // the engine's commit() reports `structure` and relinks
}

**Compile story.** **How the compiler gets the object.** No AST work, no plugin, no regex over source. `src/compile.ts:63-70` already does `setCompiling(true); await import(fileURL)`. The route compiler enumerates `windows/*/pages/**`, imports each module, and reads two exports: `default` (the component tree, expanded by the existing jsx-runtime, components erased per jsx-runtime.ts:422) and `Route` (the literal object). `createFileRoute` is an identity function with a brand — it never runs at runtime because the module never ships. This is the single largest structural advantage over TanStack, whose plugin must parse source and whose `createFileRoute` is a real runtime constructor.

**What is fully erased, field by field.**
- *Path pattern* — from the directory tree; `$projectId` becomes a dynamic slot, every other segment is interned to an integer. TanStack's literal path argument does not exist here at all; restating it would be the exact "declare the same fact twice" the compiler exists to prevent.
- *Parent/child nesting* — from directory nesting into `parent: Int32Array`. `getParentRoute` deleted.
- *`component` / `pending` / `error`* — expanded to nodes by the existing jsx-runtime and merged into the window's single node table. They become node-id ranges plus one `hidden` byte each.
- *`params` / `search` codecs* — `p.uuid()` returns a branded descriptor; the compiler switches on `kind` and emits inline code. `s.enum([...])` becomes a `u8` encoding plus a generated `d_tab`. `.default("files")` and `.min(1)` are folded into the decoder's constants. **No schema object, no Standard Schema adapter, no Zod is linked.** `p.custom(fn)` is the escape hatch and the compile log names it: `route projects/$id: p.custom retained — 1 function reference (answered "no" to: can the compiler resolve it?)`.
- *`static`* — promoted into columns: `keepAlive: Int32Array`, `preload` and `deepLink` into `flags` bits, `title` into the existing string table.
- *`loaderDeps`* — becomes a fixed-arity cache key. Because the key set is known, the cache is a per-route ring of `keepAlive[r]` slots with a parallel key array, not a `Map<string, unknown>` over a stringified key. Same move `listBindings` made: a compile-time key path instead of a runtime lookup.
- *Loader ordering* — the parent chain is walked once at build time into `loadPlan`, with parallel groups already identified (loaders whose `loaderDeps` are satisfied by an ancestor's params run concurrently). Next, Remix and TanStack all resolve this by walking matched routes at runtime.
- *Preload graph* — `reachable` as CSR arrays. A runtime "which routes can I reach from here" walk becomes two integer reads.
- *Deep-link URL scheme* — `parse()` is a generated `switch` on segment count then integer compares, with a straight-line decoder only for routes that actually have dynamic segments. The Info.plist / registry / .desktop entries are emitted from the same table, so OS registration cannot drift from the router. TanStack does not attempt this.

**Static tables produced.** Per window: `parent`, `mount`, `boundary{,Content,Pending,Error}`, `flags`, `keepAlive`, `loadPlan`, `reachable.{offsets,ids}`, the interned segment map, the generated `parse()`, the generated `Routes` constructors, and a `RouteId` const enum. Plus one merged `ui.gen.ts` per window containing every route's nodes — style interning runs over the vector of values across *all* routes, so shared chrome (sidebar, buttons, cards) costs one style slot however many routes use it, a deduplication a per-route table could not get.

**Boundaries are compiled structure, not thrown promises.** For an async route the compiler emits three sibling subtrees under one boundary node — content, pending, error. Exactly one has `hidden = 0`. Nothing is thrown, there is no reconciler to unwind into, and Suspense as a runtime concept never exists. For a **synchronous** loader the compiler emits only the content subtree: `pending` is a compile error, no boundary node is allocated, no promise cell is allocated, and no async code path is reachable for that route. That is the whole justification for Option B's ceremony — a bare route component cannot carry this fact, so under Option A every route pays for the async substrate whether or not it can ever pend.

**Type inference without `declare module`.** TanStack needs module augmentation because its types must attach to a third-party runtime library. Here the generated `routes.gen.ts` *is* the API surface: it imports the route modules' `Route` consts and derives params/search/loader-data types by ordinary inference (`const` type parameters plus the `Codec<T>` mapped type). Typed params, typed search, typed loader data and typed navigation all fall out of `Infer<P>` with no augmentation, no `FileRoutesByPath`, and no committed-to-git runtime manifest.

**Compiler changes required, honestly.** `src/compile.ts` must go multi-entry (it hardcodes one `app/app.tsx` + `app/app.css` pair, and `src/window-host.ts:45` hardcodes one `ui.gen.ts` import). `resolve-refs.ts`'s `buildRefIndex` must index exactly one level into branded `Route` objects so `Route.data`, `Route.search` and an inline `loader` are nameable by identity — which removes the "must be a top-level export" ceremony *inside route files only*, because `Route` itself is the top-level export. `<When cond>` / `hidden` emission must land (NOTES.md:736 already calls it "a small compiler addition"). And `Route.data` must return the `item-path.ts` recorder while `compiling`, the same trick `readValue` already plays for arrays.

**Runtime story.** **The whole runtime residue, largest first.**

1. **The per-window navigation stack.** `id: Int32Array(64)`, a parallel array of decoded param/search objects, and a depth integer. Which route is active is data — a user clicked — so this is a new ledger entry: *"Active route + nav stack — dynamic. It is the definition of navigation. The route set, the tree, the matching and the decoders are all static; only the cursor is not."* Depth is bounded so a push allocates only the params object. I deliberately do **not** intern params into typed arrays: a nav stack is 64 entries touched a few times a second, and applying the principle there buys nothing.

2. **Activation.** One `hidden` byte per route on the divergent path — typically 1 to 3 writes for a sibling navigation — plus `dirty = true`. `hidden` is already uploaded (`upload.ts:183`) and already honoured by Taffy layout, Skia paint and hit-testing on the Rust side (`ir.ts:239`). The engine's `commit()` memcmps and reports `structure`, so the relink is minimum work, and a search-only navigation that flips no `hidden` byte reports nothing structural at all. **No node is created, moved or destroyed by navigation, ever.**

3. **Loader invocation, async routes only.** A promise cell per async route: `{ status: 0|1|2, value, error, generation, abort }`. This is the genuinely new substrate and the second ledger entry: *"Loader completion time — dynamic, because it is I/O. No escape hatch. But whether a route has one is static, so a window whose routes are all synchronous links none of this."* On resolve it writes `Route.data`'s signal, flips the boundary's three `hidden` bytes, and the existing `subscribeBindings` path repaints. A superseded navigation calls `abort` and bumps `generation`, so a late resolve is dropped by an integer compare.

4. **The loader cache.** Per route, a ring of `keepAlive[r]` slots with a fixed-arity key array (arity = `loaderDeps.length`, known at build time). Lookup is `keepAlive[r]` integer compares — no hashing, no string key, no `Map`. `Route.invalidate()` bumps a `Uint32Array(routeCount)` generation counter.

5. **Preloading.** On activation, read `reachable.offsets[r]..offsets[r+1]` and fire the loader of every id whose `flags` has the preload bit. On desktop the web's "hover a link, prefetch over the wire" heuristic is weak, so `preload: "eager"` for local-data routes is usually right and costs a SQLite read; `"intent"` fires on focus or keyboard target rather than pointer hover, which matters because keyboard navigation is a first-class desktop path.

6. **`parse()` — reached only from the OS.** In-app navigation carries typed route values and touches no string. `parse()` runs on cold-start deep link and on session restore. On Windows and Linux the OS spawns a new process with the URL as argv, so single-instance forwarding is required; on macOS the link arrives in the running process. `deepLink: "focus-or-open"` is compiled into `flags`, so dispatch policy is a bit test, not a handler.

**What "loading" means here, stated plainly.** The web's assumption — every route boundary is a network round-trip — is wrong for desktop. Most route data is SQLite, a file read, or an in-memory store: microseconds, synchronous. So the default is inverted: **a route is synchronous unless its loader is declared `async`**, and the compiler enforces the consequence (`pending` on a sync route is a compile error). The async path exists for the routes that genuinely fetch, and it exists as three pre-lowered sibling subtrees rather than as a scheduler.

**What deliberately does not survive.** No path matcher. No schema validator. No route-tree walk. No `beforeLoad` context chain resolved at runtime — a route's context is a static field-access path, since the provider chain along a route path is known at build time. No `useTransition` and no double-render: keeping the outgoing screen visible while the incoming one loads is just *not clearing the outgoing route's `hidden` byte yet*, so a retained scene graph gets for free what a reconciler needs concurrent rendering to fake.

**Two ledger entries added, total**, to a table (`NOTES.md:431`) that currently has six. That is the honest price of Option B.

**Tradeoffs**

- Route ceremony is real, but it is the *only* thing that lets the compiler prove a route is synchronous. Under Option A every route carries the async substrate because a bare component declares nothing; under Option B a window of local-data routes links zero promise cells, zero pending subtrees and zero boundary nodes. The ceremony buys deletion, which is the only kind of ceremony this project should accept.
- One node table per window with all routes materialized and `hidden` toggled, rather than a table per route. Cost: node count grows linearly with route count (a rich page is 126 nodes today, so ~20 routes is ~2,500 nodes ≈ 47 KB of tables). Benefit: navigation is 1-3 byte writes instead of a table swap and full re-upload; style slots intern once across all routes so shared chrome is free; the existing commit() diff handles it with no new engine code. Escape hatch: `static: { lazy: true }` emits a separate table swapped through the already-proven ensureCapacity / grow / uploadAll path.
- A closed codec vocabulary (p.int, p.uuid, p.slug, p.text, p.enum, p.custom) instead of Standard Schema / Zod. Less expressive than TanStack's validateSearch, and a route wanting a rich schema must use p.custom and pay the runtime cost. In exchange the common cases lower to six lines of generated code and nothing is linked. This is the same trade src/compiler/css.ts already made: a hand-written parser over a chosen subset, with unsupported input a hard compile error rather than a silent reinterpretation.
- No path string in the route object and no getParentRoute. TanStack needs both; the filesystem plus a compiler make both redundant. The cost is that a route whose URL diverges from its file location needs `static: { path: ".." }` as an override — and, following React Router 8's retreat from filename magic, an explicit windows/main/routes.ts manifest is supported as an alternate front-end onto the same internal route-table IR, for generated or plugin-contributed screens.
- Loader data lives in a compiler-allocated cell reachable as Route.data, not in component-local state. This is forced: components are erased and resolve-refs.ts names things by object identity from module exports. The consequence is that a route's data cell is a singleton per (route x window kind), which is correct for v1's single-window cut (ROADMAP D2) and breaks the day a window kind gets multiple simultaneous instances. Stating the limit now is cheaper than discovering it later.
- Boundaries as three pre-lowered sibling subtrees rather than Suspense. No throwing, no unwinding, no reconciler, and keeping the outgoing screen up during a load is just deferring one byte write. The cost is that pending and error subtrees occupy nodes permanently, and arbitrary user-thrown suspension is unsupported — only the declared loader can pend.
- Search params are kept, but as typed decoded values in the stack frame rather than as a URL projection. Their justification outside a browser is weaker (shareability mostly evaporates), so they earn their place only as (a) the natural home for view state that should survive back/forward and (b) the thing loaderDeps selects over — `tab` not being in loaderDeps is what makes a tab switch provably skip the loader, and that proof is compile-time.

**Risks**

- Adds async to a codebase that has none. src/runtime/signal.ts is entirely synchronous — signal, computed, batch — and NOTES.md's ledger has no async entry. The promise cell, abort/generation handling and boundary state machine are new runtime code, and if written without the discipline of patches.ts they become the seam through which a scheduler grows.
- Route modules are *evaluated* by the compiler, so any import-time side effect in a route file runs at build time — a route opening a DB connection at module scope will do so inside `bun run compile`. Needs an explicit guard and a documented rule; setCompiling is the precedent, and loaders must be referenced, never invoked, during compilation.
- The compiler is single-entry today (src/compile.ts:36-42 hardcodes app/app.tsx + app/app.css -> app/ui.gen.ts) and src/window-host.ts:45 hardcodes `import * as generated from "../app/ui.gen.ts"`. Both must become multi-entry before any of this exists. Contained work on the cheap Bun side, but a hard prerequisite.
- `hidden` emission is not built. NOTES.md:736 lists `<When cond>` driving `hidden` as still open — the runtime and the engine honour it, the compiler does not emit it. The entire activation mechanism depends on this landing first, and nothing validates it today.
- No clipping exists in paint.rs, therefore no overflow, no scrolling and no ellipsis. A router ships the concept of a page, and a page whose content exceeds the window will simply spill. A4 (scrolling) is arguably a hard prerequisite for the router to be honest rather than a demo.
- The engine does not own its frame loop (A0 step 3, named as the immediate next step; Bun polls on `await Bun.sleep(8)`). With no scheduler there is no host for route transition animation, cross-fades, or a timed pending delay — the 'don't flash the skeleton for a 30 ms load' heuristic every real router needs is unbuildable until step 3 lands.
- resolve-refs.ts must learn to index one level into branded Route objects. Done carelessly this reopens arbitrary reachable-object naming and erodes the rule whose error message (resolve-refs.ts:68) is one of the project's clearest constraints. It must be exactly one level, exactly on the brand, with the same explicit error text.
- Two generated artifacts per window (routes.gen.ts and ui.gen.ts) plus generated OS registration files. More codegen is more that can go stale; unlike TanStack's committed routeTree.gen.ts these are build outputs, which is better, but the dev loop must regenerate reliably on file add, rename and delete.
- Loader data bound via the item-path.ts recorder means `{Route.data.name}` compiles to a path read. If the loader's return shape and the recorded paths diverge — a renamed field — the failure is a wrong-looking frame at runtime rather than a type error, unless the compiler cross-checks recorded paths against the loader's inferred return type. That check must be built with the feature, not after.
- Per-window nav stacks are specified but v1 has exactly one window: Engine holds `window: Option<Window>` and each Window::new calls sdl3::init(). Multi-window is an explicit ROADMAP D2 cut. Ship the machinery against one window and be honest that N-window is untested Rust work, not a TypeScript flag.

---

### Compiled Switch Router — routes are components, navigation is an integer

**Thesis.** A route is a .tsx file that default-exports a component. Nothing else: no route object, no createFileRoute, no path literal restated in code, no runtime matcher. src/compile.ts reads windows/<name>/pages/ at build time, imports every page module (importing IS compiling here — src/compile.ts:63-70), lets the existing JSX runtime erase the components into nodes (jsx-runtime.ts:422), and bakes every route subtree into that window's ONE flat node table with nodes.hidden preset. Navigation then costs one write to a Signal<number> plus at most `depth` bytes flipped in nodes.hidden[] — a field that already exists (src/ir.ts:240, schema.ts:72) and is already honoured by Taffy layout, paint and hit-testing in Rust. NOTES.md:736 already calls "<When cond> driving hidden" a small compiler addition; a router IS that addition applied to subtrees the compiler enumerated from disk. TanStack's createFileRoute('/posts/$postId') ceremony exists only because TanStack has no compiler and must smuggle a path literal into the type system via declare module; skia-proto has a compiler, so that tax buys nothing. Params arrive as generated module-level signals passed as props — the only shape resolve-refs.ts can name, since buildRefIndex matches top-level exports by object identity. Loaders do not exist because the signal graph already IS a dependency-resolving loader graph: a resource() reading a param signal refetches when that param changes; loaderDeps would be a second, worse computed.

**API sketch**

/* ===== 1. FILE CONVENTIONS (complete) =====

app.tsx                     the <App>: enumerates window kinds
windows/main/
  index.tsx                 window shell: <Window ...><Outlet/></Window>
  window.css                cascade root for this window
  state.ts                  module-level signals (existing convention)
  pages/                    presence of this dir = this window has a router
    layout.tsx              persistent wrapper, nests, receives `children`
    index.tsx               "/"
    loading.tsx             shown while any resource in sibling data.ts pends
    error.tsx               shown when any resource in sibling data.ts errors
    not-found.tsx           fallback for unmatched deep links in this scope
    settings/index.tsx      "/settings"
    settings/appearance.tsx "/settings/appearance"  (file === folder/index)
    users/
      layout.tsx            wraps every /users/* route
      index.tsx             "/users"
      [id:number]/
        index.tsx           "/users/:id"   — typed dynamic segment
        data.ts             resources for this route (the loader that isn't)
        loading.tsx
        error.tsx
      [...rest].tsx         catch-all segment
    (dev)/inspector.tsx     "(group)" organises, contributes no segment
    _RowChrome.tsx          leading "_" = not a route, colocated component
  $routes.gen.ts            GENERATED: nav fns, param signals, deep-link parse
  pages/**/$route.ts        GENERATED sibling: typed props + param re-exports
  ui.gen.ts                 GENERATED: one node table for the whole window

Segment forms: [id] string · [id:number] · [id:uuid] (resolves to
params/uuid.ts exporting `parse`) · [...rest]. Precedence static > typed >
catch-all is resolved AT COMPILE TIME into switch ordering; nothing ranks
at runtime. */

// ===== 2. AUTHORED CODE =====

// ---- app.tsx
/** @jsxImportSource ./src/compiler */
import Main from "./windows/main/index.tsx";
export default <App><Main /></App>;

// ---- windows/main/index.tsx
/** @jsxImportSource ../../src/compiler */
import { Window, Outlet, Link } from "../../src/compiler/router.ts";
import { toIndex, toUsers, toSettings, atUsers } from "./$routes.gen.ts";
import { cn } from "../../src/compiler/jsx-runtime.ts";

export default function MainWindow() {
  return (
    <Window title="dziri" width={1040} height={560} decorated>
      <div className="tabs">
        <Link to={toIndex} className="tab">Home</Link>
        <Link to={toUsers} className={cn("tab", { active: atUsers })} />
        <Link to={toSettings} className="tab">Settings</Link>
      </div>
      <Outlet />
    </Window>
  );
}

// ---- pages/users/layout.tsx   (a layout is just a component)
import type { Props } from "../../../../src/compiler/jsx-runtime.ts";
export default function UsersLayout({ children }: Props) {
  return (
    <div className="split">
      <div className="sidebar">{/* ...list of users... */}</div>
      <div className="detail">{children}</div>
    </div>
  );
}

// ---- pages/users/[id:number]/index.tsx   (params are props, and signals)
import type { RouteProps } from "./$route.ts";
import { userName, userEmail } from "./data.ts";

export default function UserPage({ id }: RouteProps) {
  return (
    <div className="page">
      <div className="h1">User #{id}</div>   {/* id is ReadonlySignal<number> */}
      <div className="row">{userName}</div>
      <div className="row">{userEmail}</div>
    </div>
  );
}

// ---- pages/users/[id:number]/data.ts   (no `loader` export; just modules)
import { computed } from "../../../../../src/runtime/signal.ts";
import { resource } from "../../../../../src/runtime/resource.ts";
import { id } from "./$route.ts";

export const user = resource(() => fetchUser(id.value)); // tracks id, refetches
export const userName  = computed(() => user.value?.name ?? "");
export const userEmail = computed(() => user.value?.email ?? "");

// ---- per-row navigation: an ordinary module-level handler (works today)
// windows/main/state.ts
import { toUser } from "./$routes.gen.ts";
export const openUser = (u: User) => toUser({ id: u.id });
// ...then in a list:  <div className="row" onClick={openUser}>{u.name}</div>


// ===== 3. GENERATED: windows/main/$routes.gen.ts =====
// GENERATED by src/compile.ts from windows/main/pages/**. Do not edit.
import { signal, computed, batch } from "../../src/runtime/signal.ts";
import { go, back, forward } from "../../src/runtime/router.ts";

export const enum R { index=0, settings=1, settingsAppearance=2, users=3,
                      usersDetail=4, inspector=5, notFound=6 }

/** The whole of navigation state: one integer + the param slots. */
export const route = signal<number>(R.index);

/** Param signals. Module-level exports so resolve-refs.ts can name them. */
export const usersDetail_id = signal<number>(0);

/** Typed navigation. One top-level export per route: no route objects. */
export const toIndex    = () => go(route, R.index, []);
export const toSettings = () => go(route, R.settings, []);
export const toSettingsAppearance = () => go(route, R.settingsAppearance, []);
export const toUsers    = () => go(route, R.users, []);
export const toUser     = (p: { id: number }) =>
  batch(() => { usersDetail_id.value = p.id; go(route, R.usersDetail, [p.id]); });

/** Active-route predicates: feed cn() and cost the same as any toggle. */
export const atUsers = computed(() => route.value === R.users
                                   || route.value === R.usersDetail);

/** Typed path strings — only for logs, deep links and session restore. */
export type Path = "/" | "/settings" | "/settings/appearance"
                 | "/users" | `/users/${number}` | "/inspector";

/** Deep-link entry. A generated switch over pre-split segments. */
export function navigateTo(path: string): boolean {
  const s = path.split("/");
  switch (s.length) {
    case 2: switch (s[1]) {
      case "":          toIndex(); return true;
      case "settings":  toSettings(); return true;
      case "users":     toUsers(); return true;
      case "inspector": go(route, R.inspector, []); return true;
      default: return false;
    }
    case 3:
      if (s[1] === "settings" && s[2] === "appearance") { toSettingsAppearance(); return true; }
      if (s[1] === "users") {
        const id = Number(s[2]);
        if (Number.isInteger(id)) { toUser({ id }); return true; }
      }
      return false;
    default: return false;
  }
}
export { back, forward };


// ===== 4. GENERATED: pages/users/[id:number]/$route.ts =====
import type { ReadonlySignal } from "../../../../../src/runtime/signal.ts";
export { usersDetail_id as id } from "../../../$routes.gen.ts";
export type RouteProps = { id: ReadonlySignal<number> };


// ===== 5. GENERATED: windows/main/ui.gen.ts (new section only) =====
// ...strings / styles / nodes / states / lists exactly as today...
import { route } from "./$routes.gen.ts";
import { userPending, userError } from "./pages/users/[id:number]/data.ts";

/**
 * Routes. `node` is the subtree root each route occupies in the ONE node
 * table; `chain` is the leaf->root reveal set (layouts included).
 */
export const routes = {
  count: 7,
  node:       new Int32Array([  4, 31, 47, 66,  92, 140, 158]),
  parent:     new Int32Array([ -1, -1, -1, -1,   3,  -1,  -1]),
  kind:       new Uint8Array([  1,  1,  1,  1,   1,   1,   4]), // 0 LAYOUT 1 PAGE 2 LOADING 3 ERROR 4 NOT_FOUND
  chainStart: new Uint16Array([ 0,  1,  2,  3,   5,   7,   8]),
  chainLen:   new Uint8Array([  1,  1,  1,  2,   2,   1,   1]),
};

/** Flattened reveal chains: node ids to un-hide, leaf first. */
export const routeChain = new Int32Array([4, 31, 47, 66, 3, 92, 3, 140, 158]);

/** Per-route pending/error subtrees, -1 when the route has no such file. */
export const routeStatus = {
  loading: new Int32Array([ 24, -1, -1, -1, 118, -1, -1]),
  error:   new Int32Array([ -1, -1, -1, -1, 129, -1, -1]),
};

/** Which signals gate those subtrees. Built from each data.ts's exports. */
export const routeResources = [
  { route: 4, pending: userPending, error: userError },
];

export const routeSignal = route;
export const root = 0;


// ===== 6. NEW RUNTIME: src/runtime/router.ts (the whole thing) =====
import { Dirty } from "./bindings.ts";
import type { CompiledUi } from "../ir.ts";
import type { Signal } from "./signal.ts";

const HISTORY = 64, MAX_PARAMS = 4;
const hRoute  = new Uint16Array(HISTORY);
const hParams = new Float64Array(HISTORY * MAX_PARAMS);
let hLen = 0, hCursor = -1;

export function go(route: Signal<number>, id: number, params: number[]): void {
  hCursor = (hCursor + 1) % HISTORY;
  hRoute[hCursor] = id;
  for (let i = 0; i < params.length; i++) hParams[hCursor * MAX_PARAMS + i] = params[i]!;
  hLen = Math.min(hLen + 1, HISTORY);
  route.value = id;            // one signal write; batch() folds it with params
}

/** Applies the active route to the node table. O(depth) byte writes. */
let shown: Int32Array | null = null;
export function applyRoute(ui: CompiledUi, id: number): Dirty {
  if (shown) for (const n of shown) ui.nodes.hidden[n] = 1;
  const s = routes.chainStart[id]!;
  shown = routeChain.subarray(s, s + routes.chainLen[id]!);
  for (const n of shown) ui.nodes.hidden[n] = 0;
  return Dirty.LAYOUT;
}
// A layout shared by the old and new route is hidden then re-shown inside one
// tick; Rust's Tables::commit() memcmps and reports no change for it at all.
// back()/forward() move hCursor and replay that frame's route + param values.
// Fixed stride, preallocated: navigation allocates nothing, ever.

**Compile story.** Pipeline, extending today's single-entry src/compile.ts (which hardcodes app/app.tsx + app/app.css -> app/ui.gen.ts):

(1) SCAN. Glob windows/*/pages/**/*.tsx. Filenames alone yield the route tree: folder===file (about.tsx === about/index.tsx), (group) contributes no segment, leading _ excluded, [id:number] declares a typed param, [...rest] a catch-all, and layout/loading/error/not-found are reserved names. Ordering static > typed > catch-all is fixed here, not at runtime.

(2) EMIT TYPES FIRST. Write windows/<n>/$routes.gen.ts (param signals, nav functions, R enum, Path union, navigateTo switch) and one $route.ts sibling per dynamic route directory. These exist before the .tsx files are imported, so route components typecheck against them. This is the SvelteKit .svelte-kit/types and React-Router .react-router/types pattern; it is why no route file ever restates its own path.

(3) EVALUATE. Import windows/<n>/index.tsx exactly as today. <App>, <Window>, <Outlet>, <Link> and every layout and page are ordinary function components, so Bun's JSX transform + jsx-runtime.ts expand them at build time. <Outlet/> returns a marker node; the compiler splices in, in manifest order, one container per route, each wrapping that route's page subtree nested inside its layout chain. <Link to={toSettings}> lowers to a plain element with onClick=toSettings — no new node kind, and resolve-refs.ts names it today. <Window> props are read off the element and become EngineConfig; the element itself lowers to the existing body node. Then the existing steps run unchanged: cascade, style interning, variant compilation for conditional classes, resolveRefs, emit.

ERASED: every page component, every layout component, <Outlet>, <Link>, <Window>, <App>, the directory structure, the segment syntax, path strings for in-app navigation, precedence rules, and the notion of "matching". None of it reaches ui.gen.ts.

EMITTED: one ui.gen.ts per window, same shape as today plus `routes` {node, parent, kind, chainStart, chainLen}, `routeChain` (flattened Int32Array of reveal chains, leaf first), `routeStatus` {loading, error} node ids, and `routeResources` linking each route to the pending/error computeds harvested from its data.ts by walking that module's exports for a resource() brand — the same identity technique resolve-refs.ts already uses, and the reason data.ts is a filename convention rather than an exported config object. Plus $routes.gen.ts and the $route.ts type siblings.

STATIC TABLES PRODUCED, stated plainly: the node table now holds every page of the window; `hidden` is preset to 1 for every route subtree except the initial one; every style id on every page was interned by the existing cascade at compile time, so navigation never resolves a selector; loading and error boundary POSITIONS are fixed node ids rather than tree-walked discoveries; and the deep-link parser is a generated switch on pre-split segments — the only place a path string is ever touched, and that string comes from the OS, not from the app.

**Runtime story.** Six things remain dynamic, and each answers "no" to NOTES.md:10's question "does the runtime really need to know?":

1. ROUTE ID. One Signal<number>. Which route is active depends on user input, so it cannot be known at compile time. It is an integer, never a string.

2. PARAM VALUES. One signal per declared param. A param is by definition a value the user supplies. They must be module-level signals because buildRefIndex (resolve-refs.ts:28) indexes top-level exports by object identity — the generated $routes.gen.ts is exactly the right module for them to live in, which incidentally settles the brief's open question about where per-route state can live.

3. THE HIDDEN BYTES. On a route change: write 1 to the outgoing chain's node ids, 0 to the incoming chain's. At most `depth` bytes each way — typically 2 to 4. Returns Dirty.LAYOUT because hidden excludes a subtree from Taffy. The engine's Tables::commit() memcmp then does the rest: a layout shared by both routes is toggled off and on within the same tick and produces no diff at all.

4. HISTORY CURSOR. A fixed-stride ring buffer (Uint16Array of route ids + Float64Array of param values, 64 frames). Which frames exist is data, so it is runtime — but it allocates nothing and it holds typed frames, never URLs. On whether a native app should have history: yes, because desktop mice have back/forward buttons and detail-drill flows expect it, but it is a typed frame stack per window, capped, and windows without a pages/ dir have none.

5. RESOURCE STATE. pending/data/error, three signals per resource. Async is irreducibly dynamic. Note this needs NO new scheduling substrate: promise.then(v => sig.value = v) sets a signal, the existing subscription sets dirty = true in src/window-host.ts:78, and the next tick uploads. resource() is roughly 40 lines over the existing signal graph, and it is the entire answer to "where does async go with no loader export" — the dependency graph is the loader graph.

6. DEEP-LINK PARSE. A generated switch over path.split("/"), run at most once per external URL delivery or session restore. This is not runtime parsing of markup or CSS — no grammar, no cascade, no tree construction. It is the OS handing the process a string at a boundary whose scheme must be registered at build time anyway, and the parser itself is compiler-emitted code, not an interpreter.

WINDOWS: each windows/<n>/ compiles to its own ui.gen.ts with its own node table, style table, root, route signal and history ring, so each window owns a fully independent navigation stack by construction — there is no shared router to partition. Shared state is a shared module in one Bun heap, so cross-window reactivity needs no IPC and no serialization. A window with no pages/ directory gets no route signal, no history and no router code at all.

Total new runtime code: src/runtime/router.ts (~70 lines) and src/runtime/resource.ts (~40 lines). No matcher, no history API, no path interpolation, no route ranking, no code-splitting loader, no reconciler.

**Tradeoffs**

- EVERY PAGE IS RESIDENT. All routes of a window live in one node table, so memory scales with total UI, not visible UI. Today's demo is 126 nodes / 18234 bytes of IR; a 20-page app at ~150 nodes/page is ~3000 nodes, roughly 90 KB of typed arrays plus strings. In exchange: navigation allocates nothing, builds no layout tree, resolves no cascade, and back/forward is instant with scroll, focus and per-page state preserved for free. There is no code-splitting problem because there is no code to split — what Next and TanStack split is parse-and-eval cost, which does not exist here.
- COMPILE TIME SCALES LINEARLY WITH PAGES. 126 nodes currently compiles in 32.9 ms. Every page is imported, cascaded and interned on every build. A 20-page app plausibly lands in the high hundreds of milliseconds — fine for `bun run compile`, painful without a watch mode, and the repo has no watcher, no dev server and no hot reload today.
- GENERATED SIBLINGS MUST EXIST BEFORE TYPECHECK. $routes.gen.ts and the $route.ts files are written in step 2 of the build, so a freshly cloned repo does not typecheck until `bun run compile` has run once. Same cost SvelteKit and React Router pay; it is a real DX tax and wants a `bun run routes` step wired into postinstall.
- PARAMS ARE SIGNALS, NEVER PLAIN VALUES. `{id}` in markup works; `style={{ width: id }}` is a compile error, and so is `if (id > 3)` inside a page component. This is exactly the rule that already governs `style={{ color: signal }}` (jsx-runtime.ts:177), so it is consistent — but a route component cannot branch on its own param at build time. Param-conditional UI must be a conditional class or a computed, precisely as app/state.ts already does for the todo `mark`.
- NO PER-ROUTE INSTANCE STATE. A page's state lives in a module beside it and is therefore a singleton; two windows showing /users/7 share it. This is not a router limitation, it is the documented consequence of components being erased (NOTES.md:587). Option A inherits it rather than pretending to fix it. Route params are singletons too.
- NO ROUTE TRANSITIONS OR ANIMATION. paint.rs has no clipping, so no scrolling and no overflow; the engine does not own a frame loop yet (A0 step 3). A navigation is an instantaneous swap. Cross-fades, slides and pending-state choreography all wait on those two landing.
- THE ESCAPE HATCH IS MISSING BY DESIGN. There is no explicit route manifest, so build-time-dynamic routes (plugin screens, generated pages) have nowhere to come from. React Router 8 retreated to app/routes.ts precisely because filenames could not express every nav structure. Option A bets a desktop app's page set is known to its author, and accepts that adding the hatch later means adding a config file after all.
- WHY SIMPLICITY WINS ANYWAY: the four things a route object buys — a path literal for the type system, loaders, loaderDeps, and typed search params — are respectively unnecessary (the compiler knows the path), already present (the signal graph resolves dependencies), a duplicate of computed, and a browser artifact with no shareable-URL value on the desktop. Option A's total surface is one signal, one byte array write, and a filename grammar.

**Risks**

- The `hidden` compiler feature it depends on does not exist yet. NOTES.md:736 lists `<When cond>` driving hidden as still open — the runtime and the Rust side honour it, the compiler never emits it. That work is a prerequisite, not a detail, and the router's whole cost argument rests on it being as small as the note claims.
- src/compile.ts is single-entry (defaultInput() hardcodes app/app.tsx) and src/app.ts hardcodes `import * as generated from "../app/ui.gen.ts"`. A router means the compiler emits more than one module and the host stops hardcoding one import. Contained to the Bun side, but it is the first time the pipeline has had more than one compilation unit.
- resolve-refs.ts:28 walks only TOP-LEVEL exports and matches by identity. Nav functions must therefore be individual `export const toX = ...`, not `nav.toX` — which this design honours, but it means `<Link to={nav.usersDetail}>` would fail to resolve. Either keep the flat exports permanently or extend buildRefIndex one level into exported objects.
- Harvesting resources from data.ts by walking exports for a resource() brand works, but silently misses a resource that is not exported, and the failure mode is a loading.tsx that never appears. Needs the same compile-error-that-states-the-rule treatment the module-level-signal rule already gets.
- `<App>` containing more than one `<Window>` reverses ROADMAP D2's explicit v1 cut, and Engine holds `window: Option<Window>` with sdl3::init() called per Window::new. The router is per-window-scope and works unchanged with exactly one window; the compiler should emit N route tables but the host should hard-error on N>1 with a pointer to D2, rather than the design implying multi-window is available.
- Every navigation returns Dirty.LAYOUT, so each one is a full Taffy relayout of the window. Probably cheap, but unmeasured — and it is the one per-navigation cost that grows with total resident node count rather than visible node count, which is exactly the tradeoff the resident-pages decision makes.
- A generated navigateTo switch interprets an OS-supplied path string at runtime. Defensible (compiler-emitted code, no grammar, boundary-only) but it deserves an explicit entry in NOTES.md's ledger of what must stay dynamic rather than being smuggled in as obviously fine.
- The auto-memory file skia-proto-architecture.md still says 'no Rust runtime', which is false as of 2026-07-30. Any router work planned off that memory will mis-scope the engine side.

---

### Scenes: App is a compile-time manifest, Window is a compiled template instantiated at runtime

**Thesis.** App is a compile-time manifest written in JSX — not a component, not a config object. JSX because the toolchain already has exactly one mechanism for reading authored declarations: src/compile.ts:63-70 imports the .tsx module and treats the resulting object graph as the IR, and src/compiler/resolve-refs.ts recovers handlers and signals by object identity. Both mechanisms work unchanged one level up, on window declarations, with zero new concepts — a dziri.config.ts would be a second declaration language with its own schema, its own validator, and no access to identity-based ref resolution. App is NOT a component because it produces no nodes, has no instance, and does not exist at runtime: after `bun run compile` there is only app.gen.ts (plain data plus import() thunks) and one ui.gen.ts per window. Window is likewise a declaration of a window KIND, not an instance. The governing split, taken from SwiftUI's Scene vocabulary and Tauri's `create: false`: the set of window kinds is closed and statically enumerable; the set of live window instances is dynamic, because open and close are user actions. So `{cond && <Window/>}` is a compile error while `openWindow("settings")` is ordinary runtime behaviour. That is compile-time-first applied to windowing — capacities, style tables, string arenas, menu tables and the WindowId union are all sized and named at build time precisely because the kind set cannot change. Layout follows: app.tsx is the manifest, windows/<id>/window.tsx is a kind, and the directory name IS the id, recovered by object identity rather than restated in a prop.

**API sketch**

// ===========================================================================
// FINAL LAYOUT. Every name below is meaningful to the compiler.
// ===========================================================================
//   my-app/
//     app.tsx              REQUIRED. default-exports <App>. The manifest.
//     app.css              optional. Prepended to EVERY window's stylesheet.
//     app.gen.ts           GENERATED. Manifest data. Imported only by the host.
//     windows.gen.ts       GENERATED. `WindowId` union + typed open/close/focus.
//                          Imports runtime only, never app state -> no cycles.
//     state/               convention: app-scoped signal modules.
//       theme.ts
//     components/          convention: shared build-time components.
//     windows/
//       main/              <- the directory name IS the window id.
//         window.tsx       REQUIRED per window. default-exports <Window>.
//         window.css       optional. Appended after app.css for this window.
//         state.ts         optional. Window-scoped signals/handlers.
//         pages/           optional. Router root (router design owns contents).
//         ui.gen.ts        GENERATED. This window's IR module.
//       settings/
//         window.tsx
//         window.css
//
// Reserved suffix: *.gen.ts is always generated, never hand-edited.
// No index.tsx anywhere: `index` would have to mean both "the window
// declaration" and "the window's root component". window.tsx says which.

// ---------------------------------------------------------------------------
// app.tsx  — the whole app's shape, in one readable file
// ---------------------------------------------------------------------------
/** @jsxImportSource dziri */
import { App, Menu, MenuItem, Separator, Tray } from "dziri/scene";
import main from "./windows/main/window.tsx";
import settings from "./windows/settings/window.tsx";
import { onLaunch, onQuit, onOpenUrl } from "./state/lifecycle.ts";
import { newDoc, save, canSave, toggleSidebar, sidebarShown, quit } from "./state/commands.ts";

export default (
  <App
    quitOn="lastWindowClosed"     // | "explicit"  (macOS shape)
    singleInstance                // named mutex / lockfile; argv forwarded
    urlScheme="myapp"             // emitted into Info.plist / registry / .desktop
    onLaunch={onLaunch}
    onQuit={onQuit}
    onOpenUrl={onOpenUrl}
  >
    {/* Window kinds. Order matters only for `open` defaulting. */}
    {main}
    {settings}

    <Menu>
      <MenuItem label="New" accel="Cmd+N" onSelect={newDoc} />
      <MenuItem label="Save" accel="Cmd+S" onSelect={save} enabled={canSave} />
      <Separator />
      <MenuItem label="Sidebar" onSelect={toggleSidebar} checked={sidebarShown} />
      <MenuItem label="Settings…" accel="Cmd+," onSelect={() => openWindow("settings")} role="settings" />
      <MenuItem label="Quit" accel="Cmd+Q" onSelect={quit} role="quit" />
    </Menu>

    <Tray tooltip="MyApp">
      <MenuItem label="Show" onSelect={showMain} />
      <MenuItem label="Quit" onSelect={quit} role="quit" />
    </Tray>
  </App>
);

// COMPILE ERRORS, all of them stated as rules:
//   <App>{isPro && <Window/>}</App>
//     -> "a window kind cannot be conditional: the manifest is sized at build
//        time. Declare it and gate `openWindow` instead."
//   <App><div/></App>          -> type error: App's children are SceneNode.
//   <Window><Window/></Window> -> type error: Window's children are Element.
//   <App>{main}{main}</App>    -> "windows/main declared twice".

// ---------------------------------------------------------------------------
// windows/main/window.tsx — a window KIND
// ---------------------------------------------------------------------------
/** @jsxImportSource dziri */
import { Window } from "dziri/scene";
import { Router } from "dziri/router";          // router design owns this
import { title } from "./state.ts";

export default (
  <Window
    title="MyApp"            // static string, or a signal (see runtime story)
    width={1040} height={560}
    minWidth={640} minHeight={400}
    chrome="native"          // | "none"  -> engine `decorated`; fixed at create
    open                     // instantiated at launch. default: first window only
    onClose="quit"           // | "hide" | "destroy"
  >
    <body>
      <Router />             {/* or plain markup; at most one Router per window */}
    </body>
  </Window>
);

// windows/settings/window.tsx
export default (
  <Window title="Settings" width={520} height={420} chrome="native"
          open={false} onClose="hide">
    <body><SettingsForm /></body>
  </Window>
);

// ---------------------------------------------------------------------------
// State across windows: one heap, one signal, zero IPC.
// ---------------------------------------------------------------------------
// state/theme.ts  — app-scoped
import { signal } from "dziri/runtime";
export const isLight = signal(false);
export function toggleTheme() { isLight.value = !isLight.value; }

// Both windows' generated modules emit
//     import { isLight } from "../../state/theme.ts";
// resolve-refs matched the SAME object, so it is the SAME module instance and
// the SAME signal. Each window subscribes independently and owns its own dirty
// flag. A write marks both dirty; a non-subscribing window does zero work.
// There is no channel name, no serialization, no structured clone. This is the
// concrete thing Electron cannot do.

// ---------------------------------------------------------------------------
// windows.gen.ts (GENERATED) — types only + typed wrappers. No app imports.
// ---------------------------------------------------------------------------
import { openWindow as _open, closeWindow as _close, focusWindow as _focus } from "dziri/runtime";
export type WindowId = "main" | "settings";
export const openWindow  = _open  as (id: WindowId) => Promise<void>;
export const closeWindow = _close as (id: WindowId) => void;
export const focusWindow = _focus as (id: WindowId) => void;
// openWindow("setings") is a compile error. Deleting windows/settings/ breaks
// every call site rather than 404-ing at runtime.

// ---------------------------------------------------------------------------
// app.gen.ts (GENERATED) — shape only
// ---------------------------------------------------------------------------
import { onLaunch, onQuit, onOpenUrl } from "./state/lifecycle.ts";
import { newDoc, save, canSave, sidebarShown /* … */ } from "./state/commands.ts";

export const APP = { quitOn: 0 /*lastWindowClosed*/, singleInstance: 1,
                     urlScheme: "myapp", onLaunch, onQuit, onOpenUrl } as const;

export const WINDOWS = [
  { id: "main", title: "MyApp", width: 1040, height: 560,
    minWidth: 640, minHeight: 400, decorated: 1, open: 1, onClose: 2 /*quit*/,
    load: () => import("./windows/main/ui.gen.ts") },
  { id: "settings", title: "Settings", width: 520, height: 420,
    minWidth: 0, minHeight: 0, decorated: 1, open: 0, onClose: 0 /*hide*/,
    load: () => import("./windows/settings/ui.gen.ts") },
] as const;

// Flat menu table: parent index, label string id, accel, command, state signal.
export const MENU = {
  parent:  new Int16Array([-1, -1, -1, -1, -1, -1]),
  label:   new Int32Array([0, 1, -1, 2, 3, 4]),   // into MENU_STRINGS
  accel:   new Int32Array([5, 6, -1, -1, 7, 8]),
  role:    new Uint8Array([0, 0, 1 /*separator*/, 0, 2 /*settings*/, 3 /*quit*/]),
  command: [newDoc, save, null, toggleSidebar, null, quit],
  enabled: [null, canSave, null, null, null, null],   // signal | null
  checked: [null, null, null, sidebarShown, null, null],
};

// ---------------------------------------------------------------------------
// ui.gen.ts emitter change (REQUIRED by window lifecycle)
// ---------------------------------------------------------------------------
// Today app/ui.gen.ts exports module-level mutable `const`s:
//     export const strings = ["dziri", …];   // text bindings overwrite in place
//     export const nodes = { … };            // lists relink in place
// Bun's module cache makes those process-global, so destroy-then-reopen would
// resume the previous session's mutated arena. Emit a factory instead:
export function createUi(): CompiledUi { /* fresh typed arrays each call */ }
// One call site changes in src/app.ts. Cost: one allocation per window instance.

// ---------------------------------------------------------------------------
// The host loop, N windows (src/app.ts)
// ---------------------------------------------------------------------------
const host = Host.open({ singleInstance: APP.singleInstance === 1 });
for (const w of WINDOWS) if (w.open) await instantiate(w);
APP.onLaunch?.();

while (host.liveCount > 0 || APP.quitOn === EXPLICIT) {
  for (const w of host.live) if (w.dirty) { w.upload(); w.dirty = false; }
  host.tick();                                  // ticks every live window
  for (const e of host.drainEvents()) {
    const w = host.live[e.window];               // NEW: events carry a window
    switch (e.kind) {
      case EventKind.CLOSE_REQUESTED: applyClosePolicy(w); break;
      case EventKind.MENU_COMMAND:    MENU.command[e.a]?.(); break;
      case EventKind.CLICK: if (!dispatchItem(w.ui, w.listBindings, e.node))
                              dispatch(w.ui, e.node); break;
      /* TEXT_INPUT, KEY_DOWN: unchanged, routed to w */
    }
  }
  await Bun.sleep(8);
}
APP.onQuit?.();

// ---------------------------------------------------------------------------
// Scene runtime types (src/compiler/scene.ts) — how the two grammars stay apart
// ---------------------------------------------------------------------------
const SCENE = Symbol.for("dziri.scene");
export type SceneNode =
  | { [SCENE]: "window"; props: WindowProps; root: Element }
  | { [SCENE]: "menu"; items: MenuItemNode[] }
  | { [SCENE]: "tray"; tooltip: string; items: MenuItemNode[] };

export function Window(props: WindowProps & { children: Element }): SceneNode {
  return { [SCENE]: "window", props, root: toDocument(props.children) };
}
export function App(props: AppProps & { children: SceneNode | SceneNode[] }): AppNode {
  // NOTE: does NOT reuse jsx-runtime's flatten(). flatten drops `false`, which
  // would silently swallow {cond && <Window/>}. Scene children reject booleans.
  for (const c of [props.children].flat()) {
    if (typeof c === "boolean" || c == null)
      throw new SceneError("a window kind cannot be conditional …");
  }
  return { kind: "app", props, scenes: [props.children].flat() };
}
// jsx-runtime.ts: `jsx()` already calls function components. Window/App are
// function components that return SceneNodes instead of Elements. The only
// change is toDocument()'s caller in compile.ts branching on the marker.

**Compile story.** `bun run compile` grows one pass in front of the existing pipeline; everything after `compileTree` is untouched.

1. DISCOVERY (identity, not globs-as-truth). Glob `windows/*/window.tsx`, import each, take the default export. Build `Map<SceneNode, {id, dir}>` where `id` is the directory name. This is the same trick `resolve-refs.ts` uses for signals, applied one level up — which is why `<Window>` needs no `id` prop and the id can never drift from the filesystem.

2. MANIFEST. Import `app.tsx`. Its default export must be an `AppNode` (marker symbol); otherwise fall back to today's single-tree path, so `app/app.tsx` keeps compiling unchanged. Every `<Window>` child is looked up in the map by identity. Not found -> error naming the expected path. Declared twice -> error. Present in the glob but absent from `<App>` -> warning (dead window). Boolean/null child -> error (the conditional-window rule).

3. PER WINDOW, N times, the existing pipeline verbatim: css = `app.css` text ++ `windows/<id>/window.css` text, concatenated in that order so window-local wins at equal specificity (the cascade's own rule, no new precedence concept). Then `compileTree(win.root, css)` -> `findToggles` -> `compileVariants` -> `resolveRefs(result, buildRefIndex(sources))` where sources = `state/*.ts`, `windows/<id>/state.ts`, the window module, the app module. Emit `windows/<id>/ui.gen.ts` via `emit()`, changed only to wrap its exports in `createUi()`.

4. ERASURE. `<App>`, `<Window>`, `<Menu>`, `<MenuItem>`, `<Tray>` are erased exactly as function components are today (`jsx-runtime.ts:422`). Nothing named App or Window survives. Window props are folded into manifest rows; `chrome="native"` becomes `decorated: 1`; `onClose="hide"` becomes an integer; `quitOn` becomes an integer the host loop's exit condition reads.

5. STATIC TABLES PRODUCED.
   Per window (unchanged in shape): `strings`, `styles` (46 interned fields), `nodes` (kind/style/text/parent/firstChild/nextSibling/list/hidden), `states`, `interactive`, `textBindings`, `handlers`, `editables`, `stylePatches`, `lists`, `listBindings`, `root`.
   New, app-level, in `app.gen.ts`: `WINDOWS` (id, title, w, h, min w/h, decorated, open, onClose, and a `load` thunk that is a literal `import()` specifier — a compile-time-resolved code split with no runtime resolver); `MENU` as a flat parent/label/accel/role/command/enabled/checked table with commands and state signals resolved by identity into named imports; `TRAY` likewise; `APP` (quitOn, singleInstance, urlScheme, lifecycle handlers by name).
   New, `windows.gen.ts`: the `WindowId` string-literal union plus typed wrappers. Deliberately imports only the runtime, never app state, so it can never form a cycle with the state modules that call `openWindow`.

6. SIDE ARTIFACTS FROM THE SAME TABLE. `urlScheme` plus the window/route set generate the OS registration files (Info.plist `CFBundleURLTypes`, the Windows registry protocol handler, the Linux `.desktop` entry). The brief notes these must be registered at build time and cannot change at runtime — so generating them from the manifest is both free and the only way they cannot drift.

7. DEV ERGONOMICS. `bun run compile --window main` compiles one window; otherwise evaluating `app.tsx` pulls in every window's tree and build time scales with the whole app even for a one-window edit loop.

Style tables are per window, not shared. Interning across windows would save memory but style indices are per-`Tables` in the engine and every index in the node table is relative to its own window's table. Per-window keeps `Uploader` and `capacitiesFor` working unchanged.

**Runtime story.** What survives is a window registry and a loop. Nothing resolves a name, matches a pattern, or parses anything.

MUST BE DYNAMIC, with the reason each earns its place in NOTES.md's ledger:

1. WHICH INSTANCES ARE LIVE. Open and close are user actions. The kind set is static; the live set is not. This is the single new ledger entry, and it is the whole justification for `<App>` being a manifest rather than a renderer.
2. WINDOW SIZE AND FOCUS. OS-driven, already in the ledger, now per window.
3. EVENT -> WINDOW ROUTING. One SDL event pump serves N windows, so `Event` gains `window: u32` and the host indexes `live[e.window]`. Node ids are per-window, which is why tables stay per-window: merging them would make node identity cross windows and break focus, handler dispatch and the list arena's slot identity.
4. PER-WINDOW DIRTY BIT. Today one `let dirty`; now one per live window, so a signal write repaints only the windows that read it.
5. MENU ENABLED/CHECKED. The only dynamic part of a menu. A small `menuState` byte table, subscribed like `stylePatches` and pushed on change. Labels, structure, accelerators and roles are all static.

LIFECYCLE, concretely.

CREATE — `openWindow(id)`: look up the manifest row; `await row.load()` (first open only; the module is Bun-cached thereafter); `createUi()` for fresh tables; run `applyTextBindings` / `updateLists` / `applyStylePatches` once so the engine is sized for the tree that actually exists (exactly what `src/window-host.ts:118-123` does today); `host.createWindow(config)` -> slot index; `new Uploader(slot, ui)`; `uploadAll()`; register the three subscriptions against this window's dirty flag. Singleton kinds are idempotent: already open -> focus instead. This is SwiftUI's `openWindow(value:)` dedupe, obtained for free because a kind has one instance.

FOCUS — `focusWindow(id)` needs one new symbol, `dziri_window_raise`.

CLOSE — the policy is a compiled integer on the window, so the branch is not a runtime policy object:
- `"hide"`: SDL window hidden, slot and tables retained. Scroll, focus, list slots and the string arena survive; reopening is a raise. Right default for Settings and inspectors.
- `"destroy"`: dispose subscriptions, destroy the SDL window, free the slot's `Tables`/`LayoutTree`/`Surface`, drop the `CompiledUi`. Node ids for that window cease to exist. Reopening calls `createUi()` again — which is exactly why the emitter must produce a factory, since re-importing the Bun-cached module would otherwise hand back the previous session's mutated arrays.
- `"quit"`: runs the app-quit path.
CRITICAL INVARIANT: closing a window never touches app state. Module-level signals live in `state/`, not in the window, so they outlive every instance. Close only decides whether the NODE TABLE survives. That separation is what makes `destroy` safe and is only possible because components are erased and state cannot hide inside them.

QUIT — `quitOn` is a compiled integer; `"lastWindowClosed"` makes the loop condition `host.liveCount > 0`, `"explicit"` keeps it running with no windows (tray-only apps). `onLaunch`/`onQuit`/`onOpenUrl` are module-level exported functions called by the host at fixed points. There is deliberately no `useEffect`: app lifecycle is a small, enumerable set of host moments, so it is props on `<App>` resolved by identity — not a general effect system with a scheduler that does not exist.

SINGLE INSTANCE + DEEP LINKS — a compiled boolean. When set, the host takes a named mutex (Windows) or lockfile+socket (macOS/Linux); a second launch forwards its argv and exits. macOS delivers the URL in-process; Windows and Linux spawn a new process, which is precisely why single-instance forwarding is a prerequisite for `urlScheme` rather than a separate feature.

ENGINE WORK REQUIRED, named honestly. Today `Engine` holds `window: Option<Window>` and `Window::new` calls `sdl3::init()` and takes the process's one `EventPump` (window.rs:54,76) — two `Engine`s in one process is untested and the event pump alone would fail. The refactor: `Engine` becomes `Host { sdl, video, event_pump, measurer, painter, windows: Vec<WindowSlot> }`, each slot owning its own `Tables`, `LayoutTree`, `Surface`, `InputState` and `root`. `Measurer` becomes shared, which is a pure win (one font cache for N windows). Every existing per-engine symbol gains a slot index; add `dziri_window_create`, `dziri_window_destroy`, `dziri_window_raise`, `dziri_window_set_title`; `Event` gains `window`; bump `PROTOCOL_VERSION` and regenerate both sides. Roughly 21 -> 25 symbols. Until that lands: the compiler, the manifest and the typed `openWindow` all work, and opening a second kind throws a runtime error naming the roadmap item — so the authoring shape is provable before the Rust cost is paid.

ONE HONEST CONSEQUENCE OF STATIC TITLES: `title` is fixed at `Window::new` today and there is no set-title symbol. A signal-valued title (`title={docName}`) therefore requires `dziri_window_set_title` and a per-window title binding. Until then a signal title is a compile error under the same rule that rejects `style={{color: signal}}`.

**Tradeoffs**

- Reverses a recorded decision. ROADMAP.md D2 explicitly cuts multiple windows, tray and native menus from v1 ("single-window apps are the large majority of desktop products, and shipping one window well beats shipping several badly"). This design adopts the authoring shape now and schedules the engine work; that reversal must be written into ROADMAP.md with its reasoning, since the docs preserve why, not just what.
- app.tsx is explicit rather than globbed. Cost: one required file listing every window. Benefit: a single readable place for menu, tray, lifecycle and quit policy; deleting a window is a type error at every call site; no ambiguity about ordering or which window launches. React Router 8's retreat from filename magic to an explicit app/routes.ts is the strongest prior art, and the filesystem still supplies the id.
- JSX for the manifest over a plain config object. A config object would be statically analyzable without evaluation (cheaper, safer for tooling). JSX was chosen because the compiler already IS an evaluator and resolve-refs already recovers references by identity — a config object would need a second declaration language and could not name a handler by identity. The cost is that authors will reasonably expect JSX to be conditional, so the error message for {cond && <Window/>} is load-bearing documentation.
- Two JSX grammars in one syntax. Scene elements (App/Window/Menu/Tray) and node elements (div/span/button) are mutually illegal, enforced by typing App's children as SceneNode and Window's children as Element. This is real conceptual weight; the alternative — a separate file format for the manifest — is worse, and JSX.ElementType is already a closed whitelist so the enforcement mechanism exists.
- Singleton window kinds only in v1. <WindowGroup> (SwiftUI's value-keyed, multi-instance document windows) is designed but deferred, because N instances of one kind means instantiating one compiled node table N times — the list-arena problem at window scale, with its own capacity and identity story. Singleton kinds cover main + settings + about + inspector, which is most desktop products. Document-based apps must wait.
- Per-window style tables duplicate interning. Two windows sharing a design system intern the same vectors twice. Sharing would save memory but style indices are per-Tables in the engine and every node's style pointer is relative to its own window's table; unifying them touches the protocol, the uploader and grow(). Memory cost is unmeasured and should be measured before it is optimized.
- Window scoping is convention, not isolation. state/ is app-scoped and windows/<id>/state.ts is window-scoped by naming only — one heap means nothing prevents window A from binding window B's state module. Emitted as a warning rather than an error, because with singleton kinds and module-level signals nothing actually breaks. The upside is the whole point: cross-window state is a direct object reference with no IPC, no channel names and no serialization.
- Static import for the launch window, import() thunks for the rest. Deferred windows cost a microtask on first open but keep their typed arrays out of the startup heap. The specifier is a literal, so this is a compile-time-resolved code split with no runtime module resolver — but it does make openWindow async, which propagates into every call site's signature.
- The ui.gen.ts emitter must change from module-level consts to a createUi() factory. Required for correct destroy-and-reopen, since Bun's module cache would otherwise hand back the previous instance's mutated string arena and relinked list nodes. Small change, one call site, but it is a hard prerequisite rather than a nice-to-have.

**Risks**

- The Rust refactor is the real cost and it is not small: Engine -> Host with N window slots, one sdl3::init(), one shared EventPump, per-slot Tables/LayoutTree/Surface/InputState, events tagged with a window index, ~4 new FFI symbols and a protocol version bump. ROADMAP risk #9 already warns that Rust slows iteration and two languages raise the contribution bar.
- paint.rs has no clipping (only draw_round_rect, draw_rect, draw_str), so there is no overflow, no scrolling, no ellipsis and no overlay layering. A settings window is fine; any window with a scroll region, a dropdown or a truncated label is ahead of the engine. This design must not be sold with a document window until A4 lands.
- The engine does not own a frame loop (A0 step 3, named as the immediate next step). With N windows on Bun's 8ms poll, a long computation in Bun stalls every window's resize, not just one. Multi-window makes the existing stall more visible and arguably should wait on step 3.
- Native menus and tray are three separate platform code paths (NSMenu, Win32 HMENU, GTK/AppIndicator) and are plausibly the largest unbudgeted item here. The manifest shape is cheap; the implementation is not. Shipping the table without the native binding leaves a declared feature that does nothing.
- The router's page tree and this window model share one unbuilt compiler feature. All routes for a window compile into that window's single node table with inactive subtrees toggled via `hidden` — hidden is honoured by layout, paint and hit-testing in Rust, but NOTES.md lists `<When cond>` driving it as still open on the compiler side. If the router instead chooses one ui.gen.ts per route plus a table swap, this window model needs a set-root symbol that does not exist.
- Evaluating app.tsx imports every window's whole tree, so build time scales with the full app even for a one-window edit loop. --window <id> mitigates it but adds a mode where the emitted manifest is incomplete, which is exactly the kind of partial artifact that causes confusing stale-generated-file bugs.
- Signal-valued window titles are a compile error until dziri_window_set_title exists, because title is fixed at Window::new. Document-shaped apps expect the title to track the document, so this will read as an arbitrary limitation to anyone who has not read window.rs.
- MEMORY.md still records "no Rust runtime", which is false as of 2026-07-30. Any future session designing against this will be reasoning about the deleted TypeScript FFI architecture. Correct it before it misleads, and consider adding a CLAUDE.md — the compile-time-first principle, the module-level-exports rule and the MSVC 14.4x floor currently live only in 86 KB of prose an agent may not read.


---

# Appendix C — Router verdicts

Three independent judges, each given a different lens: compile-time purity,
developer experience and type safety, and native-app fit.

### Verdict 1 — chose `hybrid`

Verdict: **hybrid, ~80% Option A**. A is the baseline; B contributes exactly three things — a search-param codec vocabulary, an optional static-metadata export, and its generated-artifact shape (loadPlan / reachable / flags / interned parse + OS registration codegen). Everything else in B is either duplicated declaration or a type lie.

**Ceremony test (the one the brief names).** A 3-page utility app under A is three .tsx files with a default export. Under B it is three files each carrying `export const Route = createFileRoute({})` — a wrapper whose every field is empty. B never offers an opt-out; its whole design assumes the object exists. A wins this outright and it is the single most important axis for adoption.

**B's central justification does not hold.** B's thesis is: "a plain route component cannot tell the compiler whether it needs async, so under A every route pays for the substrate." That is false against A as actually specified. A harvests `data.ts` exports by `resource()` brand — the identical identity technique `resolve-refs.ts` already uses (verified: `buildRefIndex` at resolve-refs.ts:28 walks `Object.entries(source.exports)` and matches by reference). A's own generated artifact shows `routeStatus.loading/error` as `-1` for routes with no resources, and `routeResources` containing only the routes that have them. Presence/absence of a `data.ts` file and of a brand in its exports is exactly as statically visible as a `loader` field on an object literal. B's ceremony therefore buys nothing it claims to buy. That collapses the "ceremony that lets the compiler delete machinery" argument, which is the only argument that could justify B's tax.

**B duplicates the fact it says it refuses to duplicate.** B's headline is that it drops TanStack's path literal because the filesystem already said it. But it then writes `params: { projectId: p.uuid() }` next to a directory literally named `$projectId`. That is the same fact declared twice, and it is the *param* fact — the more refactor-hostile of the two, because renaming the directory now requires editing the object too. A encodes it once, in the filename (`[id:number]`, or SvelteKit-style `[id=uuid]` resolving to `params/uuid.ts`). On the "single source of truth" axis B loses to A on its own stated criterion.

**B's api_sketch does not typecheck.** It declares `data: ReadonlySignal<Awaited<T>>` and then authors `{Route.data.name}` and `{Route.data.files.map(...)}`. `ReadonlySignal<Project>` has no `.name`. Making that work requires `Route.data` to be *typed as the unwrapped shape* while *being a signal at runtime* — a compile-time recorder masquerading as its own value. Combined with `Awaited<T>` being non-nullable while genuinely undefined during pending, B ships two type lies at the most-used authoring site in the framework. That is fatal to B's claim of superior type safety. A's `{signal}` in child position with an honest `ReadonlySignal<T>` annotation is the convention that already ships (`app/app.tsx` types `Stat`'s `value` as `string | ReadonlySignal<number>`), and A's `user.value?.name ?? ""` is honestly optional.

**`loaderDeps` is a hand-maintained duplicate of what the signal graph already tracks.** `computed`/`resource` discover their dependency set by execution. Writing `loaderDeps: ["projectId"]` restates it, is type-checked for *membership* but not for *correctness*, and drifts silently into a stale cache when a loader gains a dependency and the array is not updated. This is the second-worst refactoring hazard in either design.

**Typed navigation is near parity, and A's call sites are cleaner.** Both generate a `RouteId`/`R` const enum, so both support the exhaustive-switch discipline (adding a page becomes a compile error at every dispatch site). A: `toUser({ id })` and `<Link to={toSettings}>`. B: `nav.push(Routes.project({ params: { projectId } }))` and no `<Link>` at all — every link needs a hand-written module-level handler, because B routes navigation through user code. For a nav bar that is 5 extra exports in a 3-page app. A's flat-export requirement is imposed by `resolve-refs.ts` (top-level only, matched by identity), which A honors and B sidesteps only by making the author write the wrapper.

**Where A is genuinely weaker, and must be fixed by grafting from B.** (1) A's params are flat mangled module globals (`usersDetail_id = signal<number>(0)`) seeded to a garbage default whose type claims validity it does not have; that namespace does not scale to 50 routes. Replace with B's grouped per-route record signal, generated into `$route.ts`. (2) A has no search params at all — the one thing a filename provably cannot encode, and the natural home for view state that should survive back/forward. Take B's closed codec vocabulary (`s.enum`, `s.int({min})`, `.default()`, `p.custom` as the named escape hatch that the compile log reports) verbatim, as an *optional* `export const search = {...}`. (3) A's silent failure — an unexported resource yields a `loading.tsx` that never appears — must become a compile error in the same register as the existing module-level-exports message.

**Scaling.** At 20-50 routes, A's per-file cost stays at "a component"; B's stays at "a component plus an object". A's generated flat namespace gets long names (`toSettingsAppearance`) but stays typed and rename-safe. B's `Routes.*` namespacing is marginally tidier but is bought with per-file ceremony paid by every route including the trivial ones. The large-app arguments B makes (parallel loader plans, preload reachability, keepAlive rings) are all *compiler output* — they cost the author nothing and can be derived from A's `data.ts` convention plus an optional `meta` export. There is no scaling advantage in B that requires B's authoring shape.

**Shared skepticism, applies to both.** Both rest on `hidden` emission, which NOTES.md:736 lists as unbuilt. Both require multi-entry compile (`src/compile.ts:36-42` and `src/window-host.ts:45` both hardcode one unit). And neither is honest until `paint.rs` gains clipping: a router ships the concept of a *page*, and a page whose content exceeds the window will silently spill. Shipping either router before A4 produces a demo, not a feature.

| Option | Severity | Flaw |
|---|---|---|
| B | **fatal** | The api_sketch does not typecheck: `createFileRoute` returns `data: ReadonlySignal<Awaited<T>>` but the route component authors `{Route.data.name}` and `{Route.data.files.map(...)}`. A `ReadonlySignal<Project>` has no `.name`. Making this work requires a value typed as its unwrapped shape while being a signal at runtime — a deliberate type lie at the single most-used authoring site. This is fatal to B's claim of superior type safety. |
| B | **fatal** | The core justification for the ceremony — 'only a route object lets the compiler prove a route is synchronous, so under A every route pays for the async substrate' — is false. A's `data.ts` convention plus `resource()` brand-walking is exactly as statically visible (same identity technique as resolve-refs.ts:28), and A's own generated `routeStatus` emits -1 for routes without resources. Remove this claim and B has no argument for its boilerplate. |
| B | **serious** | `params: { projectId: p.uuid() }` restates a fact the directory name `$projectId` already declares — the exact duplication B's thesis says it exists to eliminate. Renaming a param now requires editing two places. A encodes it once, in the filename segment. |
| B | **serious** | `createFileRoute({})` is mandatory on every route file, including pages with no params, no search, and no loader. A 3-page utility app pays pure noise on every file, which is the explicit failure mode the brief names. |
| B | **serious** | `loaderDeps: ['projectId']` is a hand-maintained duplicate of the dependency set `computed`/`resource` already discovers by execution. It is type-checked for membership but not correctness; adding a dependency to a loader without updating the array yields a silently stale cache. |
| B | **serious** | `Route.data` is typed `ReadonlySignal<Awaited<T>>` — non-nullable — yet is undefined for the entire pending window of every async route. The type claims a value that provably does not exist. |
| B | **minor** | No `<Link>` primitive. Every navigation target requires a hand-authored module-level handler in a nav.ts, because B pushes all navigation through user code. A five-item sidebar costs five extra exports. |
| A | **serious** | Route params are flat, name-mangled, module-level global signals (`usersDetail_id = signal<number>(0)`) seeded with a garbage default. The type says `number` but the value is meaningless before navigation, the namespace is flat across all routes, and it does not scale past a few dozen routes. |
| A | **serious** | No search/query params of any kind. View state that should survive back/forward (selected tab, sort order, filter) has no typed home, and filenames provably cannot express it. This is the one genuine capability gap versus B. |
| A | **serious** | Resources are harvested by walking `data.ts` exports for a brand, so a resource that is merely not exported disappears silently and the failure mode is a `loading.tsx` that never appears — a wrong-looking frame rather than an error. A flags this but does not fix it. |
| A | **minor** | A page component cannot branch on its own param: `id` is a signal, so `if (id > 3)` and `style={{width: id}}` are compile errors under the existing static-inline-style rule (jsx-runtime.ts:177). Consistent with the framework, but surprising to anyone expecting props. |
| A | **minor** | Every navigation returns Dirty.LAYOUT, forcing a full Taffy relayout over a node table containing every page of the window. The per-navigation cost therefore scales with total resident nodes, not visible nodes — unmeasured, and it is exactly the tradeoff the resident-pages decision makes. |
| A | **minor** | No escape hatch for build-time-dynamic routes (plugin screens, generated pages). React Router 8 retreated to an explicit routes.ts for precisely this. A bets the page set is always known to the author. |
| B | **minor** | Two generated artifacts per window (routes.gen.ts + ui.gen.ts) plus generated OS registration files, and `resolve-refs.ts` must learn to index one level into branded `Route` objects — eroding the top-level-export rule whose error message is one of the project's clearest constraints. |
| A | **serious** | Shared with B: depends on `hidden`/`<When cond>` compiler emission, which NOTES.md:736 lists as unbuilt; requires making `src/compile.ts` and `src/app.ts` multi-entry; and is dishonest until paint.rs gains clipping, since a 'page' that overflows the window will silently spill with no scroll. |

**Salvage from the losing option.** Graft exactly these five things from B onto A, and nothing else.

1. **The search-param codec vocabulary, as an optional named export.** `export const search = { tab: s.enum(["files","runs","settings"]).default("files"), page: s.int({min:1}).default(1), q: s.text().optional() }`. This is the one fact a filename provably cannot carry. Keep B's design verbatim: a closed vocabulary (`int`, `uuid`, `slug`, `text`, `enum`, plus `custom` as the named escape hatch the compile log reports as "answered no"), each lowering to six lines of straight-line decoder with `.default()`/`.min()` folded into constants, and nothing linked at runtime. Absent export = zero machinery. Do NOT accept B's `params:` field — the filename owns params.

2. **Grouped, typed param signals — B's shape, A's source of truth.** Replace A's flat `usersDetail_id = signal<number>(0)` with a per-route record signal generated into `$route.ts` (`export const params: ReadonlySignal<{ id: number }>`), plus optional per-param re-exports for ergonomics. Types still come from the filename segment, not from a route object.

3. **Optional `export const meta = { title, keepAlive, preload, deepLink }`** promoted by the compiler into columns (`flags` bitfield, `keepAlive: Int32Array`, `title` into the string table). Optional per file, so a 3-page app never writes it.

4. **B's entire generated-artifact shape** — these are compiler outputs and cost the author nothing: `loadPlan` (parent loader chain flattened at build time with parallel groups already identified), `reachable` as CSR offset/id arrays for preload, `flags` bitfield, interned static segments so deep-link matching is integer compares, and — the best idea in either document — **generating the Info.plist / registry / .desktop URL-scheme registration from the same route table**, so OS registration cannot drift from the router.

5. **Boundaries as three pre-lowered sibling subtrees** (content / pending / error, exactly one unhidden) rather than A's vaguer `routeStatus`, together with B's rule that a synchronous route emits **no boundary node and no promise cell at all**, and that declaring a pending UI on a synchronous route is a compile error. Key it off `data.ts`'s resource brands rather than a `loader` field. B's related insight is worth writing into ROADMAP.md verbatim: with a retained scene graph, "keep the outgoing screen up while the new one loads" is just *deferring one `hidden` byte write* — which is what `useTransition` fakes with concurrent rendering, obtained for free.

Also worth keeping from B as documentation, not code: the inverted default — **a route is synchronous unless proven otherwise**, because desktop route data is SQLite or a file read, not a network round-trip. The web's assumption that every boundary is a fetch is the wrong default here, and stating it explicitly prevents the router from growing a scheduler.

From B's risk list, one item both designs must adopt: route modules are *evaluated* by the compiler, so an import-time side effect in a route file (opening a DB handle at module scope) runs inside `bun run compile`. This needs an explicit documented rule and a guard, with `setCompiling` as the precedent.

---

### Verdict 2 — chose `hybrid`

Start with what the two options actually disagree about, because it is much less than either claims. The runtime activation mechanism is IDENTICAL: one node table per window with every route resident, one integer signal for the active route, and one `hidden` byte flipped per route on the divergent path. A calls it `routeChain`/`applyRoute`, B calls it `mount`/`activate`. Both converged on the same answer, and it is the right one — `hidden` is already honoured by Taffy layout, Skia paint and hit-testing, so navigation costs 1-3 byte writes and the engine's `commit()` memcmp does the rest. Neither option matches a path string on the in-app navigation path. Neither ships a runtime matcher, a route ranker, or a code-split resolver. On the headline question — "which leaves less dynamic machinery" — the skeletons tie.

The disagreement is entirely about the DECLARATION SURFACE, and that is where the strict lens actually bites.

WHERE A OVERCLAIMS. A's thesis is that "loaders do not exist because the signal graph already IS a dependency-resolving loader graph." This is A's central argument and it is self-refuting: A then ships `src/runtime/resource.ts` ("roughly 40 lines"), a `routeResources` table, and pending/error subtrees. A has async. It just has async whose dependency set is discovered at RUNTIME by signal subscription — `resource(() => fetchUser(id.value))` learns it depends on `id` by executing and observing a read. B's `loaderDeps: ["projectId"]` is that same fact, declared and consumed at build time, lowered into a fixed-arity cache key and a flattened `loadPlan` with parallel groups already identified. Measured by NOTES.md:10's own ladder — "can the compiler resolve it? precompute it?" — B resolves a fact that A defers to the runtime. That is a genuine compile-time-first loss for A, and it is compounded by A harvesting resources from `data.ts` by walking exports for a brand, which A itself admits "silently misses a resource that is not exported, and the failure mode is a loading.tsx that never appears." Implicit discovery by evaluation is strictly weaker than a declared field the compiler reads and deletes.

A has a second, sharper defect that neither doc flags. A's param signals are module-level mutable singletons in `$routes.gen.ts`, and `toUser({id})` navigates by SIDE EFFECT — it writes `usersDetail_id.value` then sets `route.value`. Consequence: a route value cannot be constructed without navigating to it. Deep-link parse-then-decide is therefore impossible (you must mutate global param state to even represent the target), and the history ring cannot replay a frame without clobbering the live params. Worse, A's history ring stores params in a `Float64Array`, so `[id]` and `[id:uuid]` string params — which A's own filename grammar declares — cannot go in it at all. A's back/forward is broken by construction for any non-numeric param. B's route-value struct `{id, params, search}` is strictly correct here and is the only shape that makes deep-link dispatch policy and history replay coherent.

WHERE B OVERCLAIMS, AND WHERE IT SMUGGLES. B's entire justification for the ceremony is: "a plain route component cannot tell the compiler whether it needs async, so under Option A every route pays for the substrate; under B a synchronous route emits no promise cell, no pending subtree, no boundary node." This is false. Under A, a route with no `data.ts` calling `resource()` has `routeStatus.loading = -1`, `routeStatus.error = -1`, and no entry in `routeResources`. A gets the same elision by absence that B gets by declaration. B's load-bearing argument for its own ceremony does not hold. The declaration is still better — because absence-based inference is fragile and B's version is a checked contract — but that is a robustness argument, not a compile-time-first one, and B sells it as the latter.

Then B smuggles. Search params are the clearest banned-adjacent surface in either document: `parse()` calls `query(url)` and then reads `q.tab`, `q.page`, `q.q` by string key, running a query-string parser and string-keyed property access at runtime. B's own tradeoffs concede "their justification outside a browser is weaker (shareability mostly evaporates)." A feature whose author admits its value evaporates, which costs a runtime string parser plus a `s.*` codec vocabulary plus generated decoders, fails the governing principle outright. B compounds this by advertising deep-link matching as "integer compares" while the emitted code calls `intern(path(url))` (a runtime string→int table lookup, i.e. string comparison), then `raw(seg[1])` to convert back to a string, then runs a UUID **regex**. The integer-compare claim is marketing. B also layers `preload`/`reachable` CSR walking, a `keepAlive` ring cache with generation counters, and abort/generation bookkeeping — all real runtime machinery A simply does not pay for, and none of it required by the design question.

B has one more hole worth naming: `{Route.data.name}` compiles via the `item-path.ts` recorder to a path read. B admits that if the loader's return shape and the recorded path diverge, the failure is "a wrong-looking frame at runtime rather than a type error." That is the only place either option introduces a SILENT runtime failure, and it is the exact failure class this project's compile-error-that-states-the-rule discipline exists to prevent.

THE HONEST TALLY. On absolute volume of runtime machinery, A wins: no search params, no preload graph, no loader cache, no abort handling. On ratio of declared facts resolved at build time, B wins: loader deps, loader ordering/parallelism, boundary wiring and dispatch policy are all read and deleted rather than discovered by execution. Neither is a violation-free design and neither's skeleton is in dispute. So the verdict must be hybrid, and it is not "best of both" hand-waving — it is A's skeleton with B's declaration of exactly the facts filenames and evaluation cannot supply, and with B's feature creep amputated.

THE CONCRETE HYBRID.

Take from A, unchanged: (1) route file default-exports a plain component — NO path literal, NO `createFileRoute` wrapping the component; the filename is the sole source of path truth and restating it is the one thing a compiler makes indefensible. (2) The filename segment grammar, including typed segments `[id:number]`, `[id:uuid]` resolving to a `params/<name>.ts` module exporting `parse`. This is better than B's closed `p.*` vocabulary: the validator is a compile-time-resolved MODULE REFERENCE, so it is extensible without a `p.custom` escape hatch and it is named by the same identity mechanism `resolve-refs.ts` already uses. (3) Reserved positional filenames `layout.tsx`/`loading.tsx`/`error.tsx`/`not-found.tsx`. Boundary POSITION is a filename fact; this deletes B's `pending:`/`error:` object fields entirely, since a field restating what a sibling file already said is the same sin as restating the path. (4) `(group)` and `_prefix` conventions. (5) Integer route signal, `routeChain` hidden toggling, resident node table, per-window scoping. (6) Nav functions as FLAT top-level exports — verified necessary, since `buildRefIndex` indexes only `Object.entries(source.exports)`, so `<Link to={nav.toX}>` would fail to resolve.

Take from B: (1) An optional `export const route = { ... }`, carrying ONLY facts neither the filename nor evaluation can supply: `loader`, `loaderDeps`, `static: {...}` metadata, and `deepLink` dispatch policy. `params` codecs move to the filename per above; `pending`/`error` move to sibling files per above. This is a much thinner object than B proposed and it replaces A's fragile brand-walking of `data.ts` with a checked contract. (2) The rule "a non-async loader emits no promise cell, no boundary node, and `loading.tsx` beside it is a compile error." Keep the rule, reject B's framing that A cannot have it. (3) `loadPlan` — the parent chain flattened at build time into ordered parallel groups. This is B's single strongest real contribution and the one place it is genuinely more compile-time-first than A. (4) Typed route VALUE constructors returning inert structs `{id, params}`. This replaces A's side-effecting `toUser()` and is what makes history replay and deep-link dispatch actually work. Navigation becomes `nav.push(Routes.user({id}))`; params are read from the stack frame, not from global signals. (5) Generated OS registration files (Info.plist / registry / .desktop) emitted from the same route table, so they cannot drift. (6) An explicit `windows/<w>/routes.ts` manifest as an alternate front-end onto the same internal route-table IR. A's refusal to ship an escape hatch bets against React Router 8's documented retreat from filename magic; that bet is not worth taking for free.

Delete from both: B's search params, the `s.*` vocabulary, `preload`/`reachable`, and the `keepAlive` ring cache — all v2 at best, and search params probably never. A's `Float64Array` history ring and its `resource()`-brand harvesting of `data.ts`.

PREREQUISITES, EQUAL FOR BOTH AND VERIFIED. Compiler emission of `hidden` does not exist (`src/compiler/compile.ts:733,906` allocate zeros; only `src/runtime/list-runtime.ts:120,141` write it) — the entire activation mechanism of both options rests on unbuilt work that NOTES.md:736 still lists as open. The compiler is single-entry (`src/compile.ts:36-42`) and `src/window-host.ts:45` hardcodes one `ui.gen.ts` import. `src/runtime/signal.ts` has no async whatsoever. And `resolve-refs.ts` must learn to index exactly one level into the branded `route` object — one level, on the brand, with the same explicit error text, or the module-level-exports rule erodes into arbitrary reachable-object naming.

ON THE DEEP-LINK PARSER, PLAINLY. Both options run a generated switch over a path string at runtime. That is acceptable, and I will not call it a violation: it is compiler-emitted code, not an interpreter; there is no grammar, no cascade, no tree construction; the string comes from the OS at a boundary whose URL scheme must be registered at BUILD time and cannot change at runtime; and in-app navigation never touches it. But it must be written into NOTES.md's ledger as a seventh entry rather than smuggled in as obviously fine. B's query-string parsing does NOT get the same pass, because nothing forces a query string to exist outside a browser — that one is a violation, and dropping search params removes it.

| Option | Severity | Flaw |
|---|---|---|
| B | **fatal** | Search params require runtime query-string parsing plus string-keyed property access (`query(url)` then `q.tab`, `q.page`, `q.q`) — the clearest banned runtime string manipulation in either document. B's own tradeoffs concede their justification 'mostly evaporates' outside a browser. A feature the author admits has no value, paid for with a runtime string parser and a whole `s.*` codec vocabulary, fails the governing principle outright. |
| B | **serious** | The central argument for the entire ceremony is false. B claims 'under Option A every route pays for the async substrate because a bare component declares nothing.' Under A, a route with no `data.ts` calling `resource()` gets `routeStatus.loading = -1`, `routeStatus.error = -1` and no `routeResources` entry — the same elision, by absence rather than declaration. The route object is still worth having, but not for the reason B gives, and the doc's thesis paragraph rests on it. |
| A | **fatal** | Param signals are module-level mutable singletons and `toUser({id})` navigates by side effect — it writes `usersDetail_id.value` then `route.value`. A route value therefore cannot be CONSTRUCTED without navigating to it. Deep-link parse-then-decide is impossible (representing the target requires mutating live param state), and the history ring cannot replay a frame without clobbering the current route's params. |
| A | **serious** | The history ring stores params in `Float64Array(HISTORY * MAX_PARAMS)`, so string params cannot be stored at all — yet A's own filename grammar declares `[id]` (string), `[id:uuid]` and `[...rest]`. Back/forward is broken by construction for every non-numeric route in A's own example set. |
| A | **serious** | Loader dependency tracking is runtime, not compile time. `resource(() => fetchUser(id.value))` discovers that it depends on `id` by executing and observing a signal read. B's `loaderDeps` declares the same fact at build time and lowers it to a fixed-arity cache key plus a flattened parallel `loadPlan`. Measured by NOTES.md:10's own ladder, A defers to the runtime a fact the compiler could resolve — and A's thesis explicitly claims the opposite. |
| A | **serious** | Resources are harvested by walking `data.ts` exports for a `resource()` brand. A admits this 'silently misses a resource that is not exported, and the failure mode is a loading.tsx that never appears.' Discovery-by-evaluation with a silent failure mode is exactly what the project's compile-error-that-states-the-rule discipline exists to prevent. |
| B | **serious** | `{Route.data.name}` compiles via the item-path recorder to a path read; B admits that if the loader's return shape and the recorded path diverge the failure is 'a wrong-looking frame at runtime rather than a type error.' This is the only silent runtime failure introduced by either option. |
| B | **minor** | `parse()` is advertised as 'integer compares' but the emitted code calls `intern(path(url))` — a runtime string-to-integer table lookup, i.e. string comparison — then `raw(seg[1])` to convert back to a string, then runs a UUID regex. The integer-compare claim does not describe the code shown. |
| B | **minor** | Preload (`reachable` CSR + `"intent"` firing), the `keepAlive` ring cache, and abort/generation bookkeeping are all real runtime machinery not required by the design question, and not paid for by A. Feature creep measured against a principle whose stated purpose is scope containment. |
| A | **minor** | 'The escape hatch is missing by design' — no explicit route manifest, so build-time-dynamic routes (plugin screens, generated pages) have nowhere to come from. React Router 8's documented retreat from filename magic to `app/routes.ts` is direct evidence against this bet, and the hatch costs nothing to leave open. |
| A | **serious** | Depends on compiler emission of `hidden`, which is verified nonexistent: `src/compiler/compile.ts:733` and `:906` allocate `new Uint8Array(n)` (all zeros) and the only writes are `src/runtime/list-runtime.ts:120,141`. NOTES.md:736 still lists it as open. Equal prerequisite for B. |
| B | **serious** | Same unbuilt `hidden` emission dependency as A — the entire `activate()` mechanism rests on it. Additionally requires `resolve-refs.ts` to index one level into branded objects, which if done carelessly reopens arbitrary reachable-object naming and erodes the rule whose error text (resolve-refs.ts:68) is one of the project's clearest constraints. |

**Salvage from the losing option.** B's route-object framing loses — the filename already knows the path, the sibling files already know the boundaries, so most of B's object fields restate facts the compiler holds. But five things in B are strictly better than A's equivalents and must be grafted onto A's skeleton.

1. THE ROUTE VALUE AS AN INERT STRUCT. `Routes.project({params: {projectId}})` returns `{id, params}` and touches nothing. This is the single most important salvage: it fixes A's fatal side-effecting `toUser()`, makes the navigation stack storable and replayable, makes deep-link parse-then-decide possible, and removes A's broken `Float64Array` param ring. Adopt B's per-window stack of route-value structs wholesale; the params object allocation per push is trivially affordable at a few navigations per second and A's attempt to intern it was premature.

2. `loaderDeps` AND THE FLATTENED `loadPlan`. B's strongest genuinely compile-time-first contribution and the one place it beats A on the project's own terms. Declaring the dep set makes the loader cache key fixed-arity (integer compares over a small ring, no `Map`, no stringified key), makes the parent chain's parallel groups resolvable at build time instead of by a runtime tree walk, and makes 'this navigation provably skips the loader' a compile-time proof rather than a runtime observation. A's signal-tracked `resource()` cannot produce any of those three facts.

3. AN EXPLICIT, THIN `export const route = {...}` REPLACING BRAND-WALKING. Keep only `loader`, `loaderDeps`, `static`, `deepLink`. Drop `params` (filename), drop `pending`/`error` (sibling files), drop `search` entirely. This converts A's silently-fails-if-not-exported harvest into a checked contract without restating anything the compiler already knows.

4. THE SYNC-LOADER ELISION AS AN ENFORCED RULE. 'A non-async loader emits no promise cell and no boundary node; `loading.tsx` beside it is a compile error.' Keep the rule, discard B's false claim that only a route object can produce it — but B is right that an enforced rule beats an inferred one, because the enforced version tells the author why their skeleton never appears.

5. GENERATED OS REGISTRATION AND THE MANIFEST ESCAPE HATCH. Emit Info.plist `CFBundleURLTypes`, the Windows registry protocol handler and the Linux `.desktop` entry from the same route table so they cannot drift — nobody should hand-maintain three files that encode a fact the compiler holds. And ship the explicit `windows/<w>/routes.ts` manifest as an alternate front-end onto the same internal route-table IR; A's refusal bets against React Router 8's documented retreat for no gain.

Explicitly NOT salvaged from B: search params and the `s.*` vocabulary (runtime query-string parsing, admitted worthless outside a browser), `preload`/`reachable`, and the `keepAlive` cache. All are product features masquerading as compile-time wins; each adds runtime machinery A does not pay for, and none is required to answer the design question.

Also worth carrying forward from A, since B's version is worse: typed segments as filename-resolved validator MODULES (`[id:uuid]` → `params/uuid.ts` exporting `parse`) rather than B's closed `p.*` vocabulary plus a `p.custom` escape hatch. The module form is extensible, is named by the identity mechanism `resolve-refs.ts` already implements, and needs no escape hatch at all.

---

### Verdict 3 — chose `hybrid`

## The premise is wrong before either option is

Both options accept, unexamined, that a window has ONE active location, that the directory ancestor chain IS the layout chain, and that there is ONE `<Outlet/>`. That is the web's model, and it is the wrong shape for desktop.

Look at what desktop apps actually are. Zed: Workspace -> N Panes -> Items, with per-pane back/forward. VS Code: sidebar + N editor groups + panel, four independent nav regions on screen simultaneously. Mail: folder sidebar + message list + reading pane. Finder: sidebar + per-tab directory stack. The dominant native shape is **N concurrently visible, independently navigating regions** — not one active leaf. The web reaches this only through Next's `@slot` parallel routes and `(.)`intercepting routes, which the routerArt brief correctly identifies as "patches for the exact case that is your default case."

Option A has `export const route = signal<number>(R.index)` — one integer per window. Option B has one nav stack per window. Neither can express sidebar-selection-plus-main-content-plus-inspector without inventing Next's escape hatches later. That is a design flaw, not an unbuilt feature.

The good news: the *mechanism* both propose generalizes for free. Compiling every screen into one node table and toggling `hidden` works identically for N disjoint node ranges. What does not generalize is the *addressing model*. So the fix is not to abandon file-based discovery — it is to make the unit of navigation a named **region**, not a window.

## The decisive question

Can two visible regions show the same screen with different arguments? Editor tabs, chat threads, Finder tabs, two open documents — this is the archetypal desktop pattern.

**Option A: structurally no.** `export const usersDetail_id = signal<number>(0)` is one process-global signal. It has to be, because `resolve-refs.ts:28` indexes only flat top-level exports by identity, and A leans on that hard. A admits it in tradeoffs ("route params are singletons too") but does not weigh it as disqualifying. It is disqualifying. A can build a tab bar where tabs are *different* screens; it cannot build a tab bar where tabs are the same screen over different records — which is what tabs almost always are.

**Option B: closer, then breaks.** B's route values carry params in the stack frame, which is the SwiftUI `NavigationPath` shape and correct. Then B reintroduces the exact flaw one layer down: "a route's data cell is a singleton per (route x window kind)." So `Route.params` is per-frame but `Route.data` is per-route. B never describes how the compiled binding `{Route.data.name}` re-points at the right cache slot when you navigate back to a cached frame with different `loaderDeps`. Either the data cell is per-frame after all (and the compiled text binding needs an indirection B does not spec), or back-navigation shows stale data. This is a hole, not a nitpick.

So B's core data structure is the one that generalizes; A's cost model and defaults are the ones that fit.

## Where each cargo-cults the web

**B, clearly: search params.** B builds `s.enum(["files","runs","settings"])`, `s.int({min:1})`, `q: s.text().optional()` — a whole codec vocabulary for query strings. Outside a browser, query strings have exactly one value: shareability. That evaporates on the desktop. B half-concedes this and keeps them anyway, defended by `loaderDeps`: `tab` not being in `loaderDeps` is what proves a tab switch skips the loader. That is circular — search params exist so `loaderDeps` has something to select over, and `loaderDeps` exists to manage search params. Natively, "which tab is selected" is a signal. Delete both and the proof is trivial: a signal that no `computed` depends on triggers no recompute, which the existing graph already gives you.

**B, secondarily: async-first framing.** `pending`, boundary subtrees, `preload: "intent"`, abort/generation, `keepAlive` rings — this is web-latency compensation. And it is unbuildable well right now: the engine does not own its frame loop (A0 step 3), so there is no host for the "don't flash the skeleton for a 30ms load" delay every real router needs. B will flash skeletons. B's *inverted default* (synchronous unless declared `async`) is genuinely right and is its best idea; the machinery around it is oversized.

**A, subtly: hierarchy-as-navigation.** A inherits `layout.tsx` nesting, `loading.tsx`/`error.tsx` positional files, route groups — the whole Next vocabulary — without asking whether a desktop screen tree is hierarchical at all. Mostly it is not; it is a flat set of screens plus a few independent region selections. A's `data.ts` brand-harvesting is also a silent-failure machine: a resource you forget to export produces a `loading.tsx` that never appears.

**A, correctly resists** loaders, async, path strings in the hot path, and code splitting. Those are the right refusals and A deserves credit for them.

## What actually blocks both

`STYLE_FIELDS` (`src/ir.ts:78-135`) has no `overflow` and no `lineClamp`, and `paint.rs` never clips. So: no scrolling, no overflow, no ellipsis, no overlay layer, no z-ordering. A router ships the concept of a page; a page that exceeds the window spills into nothing, and a **modal is unbuildable** — no clipping, no layering. For a navigation model whose native primitives are panes and modals, A4 is a hard prerequisite, not a listed risk. Both options relegate it to the risks array. It should gate the work.

Second: `<When cond>` driving `hidden` is unbuilt (NOTES.md:736 — verified). Both designs' entire activation mechanism rests on it. It is a prerequisite for either.

Third, a claim to deflate: A's "navigation costs O(depth) byte writes." The `hidden` writes are O(depth), but the write returns `Dirty.LAYOUT` and Rust's `resync` then relayouts the whole window tree, which now holds every screen. Navigation cost scales with total *resident* nodes, not visible ones. A flags this honestly in risks; the thesis oversells it.

## Verdict: hybrid, and concretely

**From A, kept verbatim:** (1) the activation mechanism — all screens of a window in ONE node table, navigation writes `hidden` on the divergent path, `Dirty.LAYOUT`, ride `commit()`'s existing memcmp diff. Reject B's `lazy: true` table-swap hatch for v1 (grow/re-describe has never been driven that way). (2) Screens are plain components that declare nothing — no `createFileRoute`, no restated path, no `params:` block (the filename said it), no `search:` block at all. (3) No loaders as a routing concept; data is `computed`/`resource` in a sibling module and the signal graph is the dependency graph. (4) Generated `parse()` switch, path strings touched only at the OS boundary. (5) `atX` computeds feeding `cn()` for active-tab styling.

**From B, kept:** (6) **typed route values instead of a global int** — `Routes.project({ id })` returns a struct, and args ride the stack frame. This is the single most important correction to A. (7) Typed constructors plus an exhaustive `ScreenId` const enum, so adding or deleting a screen is a compile error at every dispatch site rather than a runtime miss. (8) OS registration files (Info.plist / registry / .desktop) generated from the same table so they cannot drift. (9) Exactly ONE optional declarative export per screen — `export const screen = { deepLink: "focus-or-open", keepAlive: 2 }` — static metadata folded into flag bits. Not params, not search, not loader.

**From neither — the correction both need:** (10) **The navigation unit is a region, not a window.** A window shell declares named regions: `<Region name="sidebar"/> <Region name="main"/> <Region name="inspector"/>`. Each region owns its own screen selection, its own stack, its own history. `pages/` maps to the default region; additional regions get their own directories. This is N copies of A's activation mechanism over disjoint node ranges of one table — nearly free — and it is what makes tabs, split panes, master-detail and sidebars expressible without ever inventing `@slot`. It also *reduces* pressure to reverse ROADMAP D2, since a split region replaces a second window for most desktop cases. (11) **Args live in the frame; compiled bindings read through it.** `{args.id}` lowers to a read of `frame[region].args.id`, not a module-global signal. Derived data is `computed` over `args`, cached by (screen, args) using B's `keepAlive` ring keyed off the frame. This single change fixes A's singleton params AND B's singleton `Route.data` with one mechanism.

The honest cost: (11) needs `resolve-refs` to name a per-frame arg path, which is new — but it is strictly narrower than B's "index one level into branded Route objects," and it does not erode the module-level-export rule for signals and handlers, which stays exactly as `resolve-refs.ts:68` states it.

| Option | Severity | Flaw |
|---|---|---|
| both | **fatal** | Both assume ONE active location per window, one <Outlet/>, and directory-nesting-as-layout-nesting. Desktop apps are N concurrently visible, independently navigating regions (Zed's Workspace/Pane/Item, VS Code's sidebar + editor groups + panel, mail's folder/list/reading-pane). This is the premise that forced Next.js to invent @slot parallel routes and (.)intercepting routes — the two ugliest features in the web router canon — and it is skia-proto's DEFAULT case, not its edge case. Neither option can express sidebar + main + inspector with independent histories. |
| A | **fatal** | Route params are process-global module-level signals (`export const usersDetail_id = signal<number>(0)`), forced by resolve-refs.ts:28 indexing only flat top-level exports by identity. Two visible regions, or two tabs, showing the SAME screen with DIFFERENT records is structurally impossible. Editor tabs, chat threads, open documents and Finder tabs are the archetypal desktop patterns and A cannot build any of them. A lists this in tradeoffs but does not treat it as disqualifying. |
| B | **serious** | `Route.data` is specified as a singleton cell per (route x window kind) while `Route.params` rides the stack frame — the exact flaw B criticizes A for, reintroduced one layer down. B never describes how the compiled binding `{Route.data.name}` re-points at the correct keepAlive cache slot when navigating BACK to a cached frame with different loaderDeps. Either the cell is per-frame after all (needing an indirection B does not spec), or back-navigation renders stale data. |
| B | **serious** | Search params plus a whole codec vocabulary (s.enum/s.int/s.text, .optional(), .default()) are web residue. Query strings earn their keep in a browser solely through URL shareability, which evaporates on the desktop. B's defense is circular: search params exist so loaderDeps has something to select over, and loaderDeps exists to prove a search-only change skips the loader. Delete both and the proof is free — a signal no computed depends on already triggers no recompute in the existing graph. |
| B | **serious** | Async-first framing (pending subtrees, boundary nodes, preload:"intent", abort/generation counters, keepAlive rings) builds scheduler-shaped machinery onto an engine that does not own its frame loop (A0 step 3 unbuilt; Bun polls on `await Bun.sleep(8)`). Without a scheduler there is no host for the pending-delay heuristic every real router needs, so B will flash skeletons on sub-frame loads. B's inverted DEFAULT (synchronous unless declared async) is correct and is its best idea; the apparatus around it is oversized for desktop data latency. |
| both | **serious** | STYLE_FIELDS (src/ir.ts:78-135) ends at fontWeight — no `overflow`, no `lineClamp` — despite the protocol declaring both (src/protocol/schema.ts:137-138), and paint.rs contains no clip call. So there is no scrolling, no overflow, no ellipsis, no overlay layer and no z-ordering. A page that exceeds its window spills into nothing, and MODALS ARE UNBUILDABLE. For a navigation model whose native primitives are panes and modals, A4 is a hard prerequisite, not the risk-list item both options file it as. |
| both | **serious** | The entire activation mechanism in both designs rests on `<When cond>` driving `hidden`, which NOTES.md:736 lists as still open on the compiler side. Verified: `hidden` is real and honored by layout.rs:362 and paint.rs:132/261, but nothing in the compiler emits it. This is a prerequisite for either option, not a detail. |
| A | **minor** | Resources are harvested by walking a sibling data.ts's exports for a resource() brand. A resource that is not exported is silently missed, and the failure mode is a loading.tsx that never appears — a silent wrong frame rather than the compile-error-that-states-the-rule treatment the module-level-signal rule already gets. |
| A | **minor** | The thesis claims navigation costs O(depth) byte writes. The hidden writes are O(depth), but the write returns Dirty.LAYOUT and Rust's resync relayouts the whole window tree — which now contains every screen. Per-navigation cost therefore scales with total RESIDENT nodes, not visible ones. A concedes this in risks; the headline oversells it. |
| B | **minor** | Route ceremony is defended as "ceremony that lets the compiler delete machinery," but that argument only holds for `loader`/`pending`. `params:` restates what the filename already declared, `search:` is web residue, and `static:` could be a plain sibling export. Only about a quarter of the declared surface earns its keep. |
| B | **minor** | `{Route.data.files.map(fn, {key})}` through the item-path recorder is unproven. item-path.ts's recorder throws on ownKeys, returns nested recorders on every get, and deliberately omits a `has` trap so isSignal's brand check fails against it — the signal `.map` path and the array-proxy path are different mechanisms. B hand-waves "the compiler synthesises computed(() => Route.data.value.files)" without showing the recorder survives that. |

**Salvage from the losing option.** Beyond what the hybrid already folds in, three ideas are worth grafting regardless of which spine wins.

From B: (1) The INVERTED ASYNC DEFAULT is B's single best idea and survives even after the loader apparatus is cut — a screen is synchronous unless its data function is declared `async`, and declaring a pending subtree on a synchronous screen is a compile error. Desktop data is SQLite, a file read, or an in-memory store; the web's assumption that every navigation is a round trip is the thing to reject, and making it a compile-time fact means a window of local-data screens links zero promise cells and allocates zero boundary nodes. (2) The GENERATED OS REGISTRATION (Info.plist CFBundleURLTypes, the Windows registry protocol handler, the .desktop entry) emitted from the same table as the deep-link parser. Free, and the only way the externally addressable surface cannot drift from the screen set. TanStack does not attempt this and it is a real differentiator. (3) The EXHAUSTIVE ScreenId UNION so `switch (id)` over screens is checked — deleting a screen becomes a compile error at every dispatch site rather than a runtime miss.

From A: (4) The RESIDENCY BET — every screen lives in the window's one node table, navigation allocates nothing, and back/forward preserves scroll, focus and per-screen state for free. That is not a compromise, it is the correct native behavior: switching a tab should not reset the tab. And it dissolves code-splitting entirely, since what Next and TanStack split is parse-and-eval cost that does not exist here. (5) The refusal to invent async as a routing concept — the signal graph already resolves dependencies, and `loaderDeps` is a worse `computed`.

Two things worth taking from the scouting briefs that neither option used: SvelteKit's PARAM MATCHERS (`[id=uuid]` resolving to a compile-time-known validator module) give typed params with zero in-file ceremony and make B's codec vocabulary unnecessary for the common cases; and React Navigation's `groups` (conditional screen sets for signed-in/signed-out) handle the one legitimate case for a conditional screen set without forcing the screen table dynamic — worth adopting before someone reaches for a runtime route registry.

Finally, two housekeeping items surfaced by the scout and independently confirmed here: MEMORY.md still records "no Rust runtime," which is false as of 2026-07-30 and will mis-scope any future session's engine estimates; and there is no CLAUDE.md, so the compile-time-first principle, the module-level-export rule, the `.value` scalar limitation and the MSVC 14.4x floor live only in 86 KB of prose an agent may never read.


---

# Appendix D — Adversarial primitives audit

Run with the default stance that React primitives do **not** transfer to a
no-VDOM compiled framework, with the burden of proof on the design.

| Primitive | Ruling | Why | Compiled form |
|---|---|---|---|
| `The construction pass (the mechanism the whole design rests on)` | **keep-but-redesign** | Not a primitive, but everything below depends on it. The design claims components run 'exactly twice — once at build, once at process start' and that this is cheap because the tree is 'dropped immediately'. Three verified breaks. (1) src/compiler/jsx-runtime.ts:33 installs the list builder, and src/runtime/signal.ts:117 makes the default buildList THROW: 'signal.map() was called outside the compiler'. A construction pass evaluating a real component tree hits that on the first .map(). To not throw it must install the compiler's list builder — meaning item-path.ts's recording proxy, flatten(), normalize(), cn(), styleAttr() and the whole 16 KB jsx-runtime ship to the runtime. That falsifies jsx-runtime.ts:8 ('Nothing here ships to the runtime') and downgrades 'components are erased' to 'erased from the IR, not from the bundle'. (2) The pass allocates one Element object per node plus a children array per element, so the headline claim that a zero-binding subtree 'costs nothing forever' is false at startup and false in peak RSS — true in steady state only. Say that plainly. (3) shapeHash cannot guard the interesting case: the build pass runs under setCompiling(true) (signal.ts:208) where .value on an array returns a recording proxy. If the startup pass does not reproduce that exact mode, the two evaluations take different branches with identical signal counts — a hash collision by construction. The pass must run compiling=true with the compiler's list builder; it IS a second compile minus CSS. | src/runtime/construct.ts imports the compiler's jsx-runtime and item-path (not just signal.ts), calls setCompiling(true) and setListBuilder(compilerBuildList), installs a `constructing` recorder in signal.ts that pushes every signal()/computed()/resource() onto an ordinal array, evaluates the entry module, walks the resulting Element tree in the same pre-order the compiler's emit walk uses to assign node ids, harvests handlers into Map<nodeId, fn> and resolves ref.node, then drops the tree. Emit signalCount + shapeHash into ui.gen.ts and hard-abort on mismatch naming the diverging ordinal. Measure and publish the startup cost — it is the price of deleting NOTES.md:587. |
| `useState` | **keep-but-redesign** | Keep as a signal, but the design badly undersells the semantic break and must not ship without a guard. React's useState returns a VALUE SNAPSHOT per render; a signal returns a LIVE CELL. With run-once bodies, every plain read at component scope freezes forever: `const doubled = count.value * 2` compiles to 0 and never updates, silently, with no error. `if (count.value > 3) return <A/>` picks a branch at startup permanently. `const label = count.value + ' items'` is dead text. This is the single biggest thing users hit, it is invisible (correct first frame, then frozen), and it is exactly the bug class React users never had to think about because re-running the body papers over it. Second break: per-component state does not exist as a concept — there are no instances, so the signal belongs to the CALL; two <Counter/> get two signals only because the body ran twice at construction. That is coincidentally React-like and must be documented as a consequence, not a guarantee. Third: no state can be created after startup; per-row state must be data in the array (app/state.ts already models this with a computed producing `mark`). | `signal(0)` at any scope; harvested by creation ordinal into s[]; ui.gen.ts references s[0] and no longer imports ./state.ts, which is what deletes the module-level-export rule at resolve-refs.ts:66. MANDATORY guard: add a `constructing` flag to signal.ts and throw from the .value getter when `constructing && listener === null` — 'reading .value during construction captures a dead snapshot; wrap it in computed() or interpolate the signal itself'. signal.ts already has the `listener` global (line 48), so this is ~4 lines and converts the worst silent-failure class in the design into a loud error. Without it, reject the primitive. |
| `useEffect` | **keep-but-redesign** | Fires post-commit at the frame boundary, at most once per frame, never per render. Deps are the signals read during the last run — but the existing graph CANNOT support this. signal.ts adds subscribers on read (lines 86 and 159) and NEVER removes them; there is no dep-set clearing on recompute anywhere in the file. So `effect(() => a.value ? b.value : c.value)` permanently accumulates b and c and over-fires forever once both branches have been taken. Correctness holds, cost does not, and the accumulation is unbounded. The design asserts auto-tracking works and never mentions this. Second omission: no cycle guard — an effect writing a signal it reads loops the frame loop with no 'maximum update depth' equivalent. Third and worst: because nothing unmounts, an effect under a `hidden` subtree KEEPS RUNNING. A hidden panel's poll/watch/timer never stops. `hidden` is the design's answer to Show, Suspense, error boundaries and routes, so this is the default case, not an edge case. | effect(fn) registers into the window-scoped owner list at construction, runs once to collect deps, re-enqueues on the post-commit queue. Requires three signal.ts additions: (a) per-subscriber dep sets with clear-and-recollect each run, as intrusive doubly-linked lists rather than Sets — the current Set-per-signal will show up in GC at 120 Hz; (b) a re-entrancy counter that aborts with the effect's `debug` string after N flushes in one frame; (c) subtree-visibility gating — the compiler knows each effect's enclosing hidden-controlled subtree, so emit effect.gate: nodeId \| -1 and skip gated effects while that hidden byte is set. |
| `onCleanup / effect cleanup return` | **keep-but-redesign** | MISSED BY THE DESIGN, and not optional. Its disposal story is 'the only disposal boundary is a window' because nothing unmounts. Fine for signals, wrong for effects: an effect that opens a file watcher, an interval, a subprocess or an FFI-backed resource needs teardown when its subtree hides or a route swaps — both constant, neither closes a window. With Skia/FFI resources downstream a leaked subscription is far more expensive than in the DOM. The design's own risk list says window-scoped disposal 'is the whole answer'; it is the coarsest of three needed scopes. | effect(() => { const t = setInterval(...); return () => clearInterval(t); }). Three disposal scopes, all compile-time-known: window (construction owner), gate (the enclosing hidden-controlled node — run cleanup when it closes, re-run the effect when it reopens), and explicit dispose() from a ref. The gate id comes from the same analysis that emits `boundaries` and `nodeBoundary`. |
| `untrack / peek` | **keep-but-redesign** | MISSED BY THE DESIGN, required the moment effects exist. signal.ts has no untracked read: every .value inside a listener subscribes. `effect(() => { log(a.value); count.value = count.value + 1 })` self-subscribes and loops. Solid ships untrack, Svelte ships untrack/$state.snapshot, Vue ships toRaw — every signals framework needs the escape hatch and this one has none. | sig.peek() reads `current` without consulting the `listener` global — ~3 lines in signal.ts, symmetric with the existing getter. Plus untrack(fn) which nulls `listener` for the duration. Neither has a compiled artifact, correctly: 'is this read tracked' is a property of the reading code, not of the tree. |
| `useLayoutEffect / afterLayout` | **reject** | THE DESIGN IS FACTUALLY WRONG HERE. It claims afterLayout 'runs after tick() and reads the bounds arena, which Rust wrote this same frame' and calls it 'a real layout effect with zero extra passes'. Verified at native-src/dziri-engine/src/engine.rs:263-296: tick() is pump_input -> commit -> resync -> compute layout + write_bounds -> draw() -> present(). Layout and PRESENT are the same call. A callback after tick() runs after the pixels are on screen — it has useEffect timing, not useLayoutEffect timing. Every measure-then-position pattern (tooltip placement, autosizing a popover, scroll-into-view, measuring text to size a container) writes a signal that lands NEXT frame, producing exactly the one-frame flash of wrong geometry that useLayoutEffect exists to prevent. Shipping this under the name afterLayout is worse than not shipping it: the name promises a guarantee the implementation does not provide. | Blocked on an FFI change the design does not budget: split tick() into engine_layout() and engine_paint(), run post-layout callbacks between them, and re-enter layout if any dirtied geometry (bounded to 2 passes, then warn). That is a new symbol on a deliberately narrow 21-symbol surface plus a schema.ts change. Until then ship only ref.bounds() as a synchronous read of LAST frame's bounds arena, documented as one frame stale, and no lifecycle hook at all. |
| `useMemo` | **compile-away** | Two cases, neither needs a React-shaped primitive. Pure-of-constants folds at build because the compiler literally evaluates the module (src/compile.ts imports the .tsx). Signal-derived is `computed`, which exists (signal.ts:132), is lazy, caches, and short-circuits via Object.is in the setter (signal.ts:90). React's dependency array is a manual approximation of dependency tracking; here tracking is real, so the array is not merely unnecessary, it is a lie the user must maintain. Reject the array outright. | Constant-folded into the strings/styles tables, or computed(() => ...) with automatic capture via the existing `listener` global. No dep array ever. Note the same accumulation flaw as effect: computed's subs set is monotone and needs the same clear-and-recollect fix. |
| `useCallback` | **reject** | Its only purpose is referential stability so a reconciler comparing props can skip a subtree. There is no reconciler, no runtime props, and handler identity is already a compile-time constant — handlers are a fixed table keyed by node id (src/runtime/bindings.ts:106 handlerFor scans ui.handlers for h.node === node). Nothing re-creates a handler because nothing re-runs a body. Importing useCallback would import a cost with no benefit and teach a mental model the framework does not have. | None. handlers stays a fixed table of node ids plus a parallel function array harvested at construction. While you are there, replace handlerFor's linear scan with an Int32Array index — it is O(handlers) per click today. |
| `React.memo` | **reject** | Memoizes a component's render output against prop identity. Nothing renders. There is no output to memoize and no runtime props to compare. Same ruling and same reasoning for useDebugValue and every other reconciler-adjacent API. | None. There is no artifact to emit and no runtime hook to expose; the API simply does not exist in the framework surface. |
| `useRef (mutable box)` | **compile-away** | useRef({current: x}) exists solely to survive re-renders. Bodies run once, so a closure variable already survives, trivially and with no allocation. The cleanest possible case of a React primitive dissolving rather than transferring. | A plain `let` in the component closure, captured by handlers and effects. Zero IR artifact, zero runtime object. |
| `useRef (element handle) / refs` | **keep-but-redesign** | Genuinely needed and genuinely cheap — ROADMAP C3, unbuilt, and the sanctioned imperative escape hatch (ROADMAP:473 'Refs, not selectors'). A ref is not a boxed pointer filled during commit; it is a node id known at compile time. Two caveats the design misses: .node is assigned by the CONSTRUCTION pass walk, so it inherits every determinism risk above; and .bounds() is one frame stale (see useLayoutEffect), which belongs in the type's doc comment, not only in a design doc. | const panel = ref() -> panel.node === 37, a compile-time integer. .bounds() reads the bounds arena (Rust writes it at engine.rs:277 write_bounds) and returns last frame. .focus() calls engine.setInputState, already an FFI symbol. No .current, no null state, no fill-during-commit phase. |
| `forwardRef / useImperativeHandle` | **reject** | forwardRef exists because React refs attach to instances and components have none. Here a ref is an integer resolved at build, so a build-time component can return it or accept it as a prop like any other value — props ARE build-time arguments. useImperativeHandle fakes an instance API; there are no instances and nothing to fake. | None. `function Panel({ handle }) { return <div ref={handle}/> }` — the ref object passes as an ordinary build-time argument and resolves to the same integer. |
| `useContext / Context` | **compile-away** | Full agreement with the design, and the strongest primitive in the set. The provider/consumer chain is statically known because the tree is — the compiler is literally holding the Element tree when it resolves it. Runtime artifact: zero. One correction: the design says a signal-valued context 'degenerates into an ordinary binding', which is right, but providing a value that is neither static nor a signal (a plain mutable object read later) must be a compile ERROR, because there is no provider to look it up from. And note what this forbids: dynamic provider values that change WHICH provider wins based on runtime state. This is lexical scoping at build time, nothing more — name it something other than Context so people stop expecting React semantics. | A static value inlines into the style table or string table at every consumer. A signal value emits an ordinary text/style binding on that signal at each consumer site. Theme.use() produces no code whatsoever. |
| `Suspense` | **keep-but-redesign** | The two-materialized-subtrees + complementary hidden bytes lowering is right, and throwing promises is correctly rejected — throw-to-suspend only works because React can re-enter a component body, which is exactly what this framework cannot do. But the compile-time `sources` set IS NOT DERIVABLE and the justification given is false. The design says sources is 'derivable because every binding already carries deps'. A binding's deps are the immediate signal objects recovered by identity (resolve-refs.ts:77-83). If the binding reads a computed, the compiler holds an opaque object; dependency capture is dynamic via the `listener` global at read time (signal.ts:150), and there is no AST pass to see that `computed(() => a.value ? r1.value : r2.value)` touches r1 or r2 or which. The source set must be computed transitively at runtime. Still cheap, still honest — but say so. | Keep boundaries = [{ kind, content: nodeId, fallback: nodeId }] as compile-time structure. Replace static `sources` with runtime pending propagation: resource exposes a pending bit; computed propagates pending from whatever it actually read this evaluation (one extra bit beside the existing `stale` flag at signal.ts:134); the boundary subscribes to the pending state of bindings under content and writes two hidden bytes. Structure compiled, three bytes of status dynamic — that is the ledger entry the brief asks for. Keep the design's genuinely good result: refetch() sets 'stale' not 'pending', the boundary does not flip, and stale-while-refetching is free without transitions. |
| `Error boundaries` | **keep-but-redesign** | Correctly narrowed — 'render threw' is now a compile error, so boundaries catch handler, effect and resource failures only. But 'catching' is underspecified with no unmounting. When a boundary trips, the design flips a hidden byte and shows a fallback; the bindings under the failed subtree KEEP EVALUATING every frame, and if the throw came from a computed they keep throwing, once per frame, forever. The design emits nodeBoundary for INTERACTIVE nodes only — enough to route a handler throw, not enough to disable bindings. A second class the design never raises: the Rust engine builds with panic = 'unwind' and exports panic_for_testing. An engine panic is a fourth failure class no boundary can catch and it needs its own policy — abort with a diagnostic, not a silent dead window. | boundaries entries with kind: ERROR, plus TWO compile-time maps: nodeBoundary (interactive node -> boundary, for dispatch) and bindingBoundary (binding id -> boundary, for gating). A tripped boundary sets a disabled bit the scheduler checks before evaluating any binding in its content subtree, and runs cleanup for every effect gated under it. reset() clears the bit and re-runs. Engine panics take a separate, explicitly non-recoverable path. |
| `useTransition / useDeferredValue / concurrent rendering` | **reject** | Agree with the design; the reasoning is sound. Solid implements transitions by cloning the reactive graph and dual-rendering — the most expensive machinery in its codebase — and the payoff, 'keep showing the old tree while the new one renders', is free here because both trees are already materialized in the arena. There is no reconciler to interrupt, no time slicing to do, and this framework owns its frame loop, so the correct answer to 'don't block the UI' is 'don't block the UI'. One caveat to record: this is a one-way door. If transitions are ever wanted the graph must support forking, and the intrusive-linked-list dep representation recommended for effects makes forking harder, not easier. Take the door and close it deliberately. | None. Debounce is userland over a signal plus a timer. Route swaps are two materialized subtrees and a hidden byte, which is what the router should be doing regardless. |
| `createPortal / <Overlay>` | **keep-but-redesign** | The design says this is '~30 lines in paint.rs, needs NO clipping, so dropdowns/tooltips/dialogs do not have to wait for A4'. VERIFIED FALSE. paint.rs:244-268 hit_test walks the tree and PRUNES on parent bounds — 'if px < x \|\| py < y \|\| px >= x+w \|\| py >= y+h { continue }' — with a comment acknowledging children can overflow and that it prunes anyway. So an overlay painted on a higher layer but positioned outside its parent's box is invisible to hit-testing: the dropdown draws and cannot be clicked, and clicks fall through to what is visually beneath it. That is a second, separate Rust change and it is the one that actually matters. Also unaddressed: keyboard focus order across layers, and Escape-to-dismiss, which today is hardcoded in src/window-host.ts:277 to clear input state globally. The primitive is right; the cost estimate is off by the more important half. | layer: Uint8Array per node, compile-time constant; painter sorts by (layer, tree order). hit_test must be REWRITTEN to test layers in descending order without parent-bounds pruning inside an overlay subtree — overlays need a bounds-rooted traversal, not a tree walk. Positioning needs an anchor (<Overlay anchor={ref}>), and anchoring needs bounds, which are one frame stale — so a dropdown places itself one frame late until the layout/paint split lands. These are one piece of work, not one line item. |
| `key` | **keep-as-is** | Already mandatory and already correct — a type error AND a compile error (jsx-runtime.ts:36-51) with the right justification recorded: item nodes are interchangeable for painting so a reorder needs no structural work, but focus is a node id, so an unkeyed reorder moves focus to the wrong row. One correction to the design: the key FUNCTION compiles away into a property path (item-path.ts recorder, jsx-runtime.ts:44); the key VALUES are irreducibly runtime, and that is already in the ledger as list cardinality/order. Nothing needs changing. This is the one React primitive that transfers intact, and it transfers because it was never about reconciliation — it was always about identity. | keyPath: string[] in the DynList template; runtime reads item[...keyPath] per row. Already built in src/runtime/list-runtime.ts. |
| `Fragment` | **compile-away** | Already does, and needs no new work — confirming rather than proposing. jsx-runtime.ts:276 defines it as the literal string '#fragment' and flatten() splices it at line 338, so it never reaches the node table. No node, no cost, no runtime concept. | The string '#fragment' as a tag, spliced out by flatten() before emit. Zero nodes in ui.gen.ts, zero runtime artifact. |
| `Custom hooks` | **keep-but-redesign** | They work — `function useDisclosure() { const open = signal(false); ... }` is legal anywhere including inside a branch or a loop, because there is no positional slot array and therefore no rules of hooks. A genuine improvement over React, and worth stating that the rules do not get SOLVED, they cease to exist. Two constraints must be documented or users get burned: (1) a hook called conditionally runs once, for whichever branch was live at construction, and nothing re-evaluates the condition — the compiler should reject or hoist state creation inside a conditional whose predicate is a signal, since it can see that it is one; (2) a hook that reads .value and returns a plain value reproduces the frozen-snapshot bug, so hooks must return signals/computeds, never values. Call them factories, not hooks, precisely to break the expectation that they re-run. | Plain build-time functions. Their signals land in the ordinal array in call order; their handlers land in the handler table by whichever node id they attach to. No artifact of the function itself survives. |
| `useSyncExternalStore / external subscriptions` | **keep-but-redesign** | MISSED BY THE DESIGN. `resource` covers one-shot async (fetch, file read). It does not cover what a native desktop app does constantly: subscribe to a stream — a file watcher, an OS theme-change notification, a websocket, child-process stdout, tray events, window focus. Every one is a push source that must land in the signal graph and must be torn down. The design has no primitive for it and no teardown scope (see onCleanup). This is a bigger real-world gap than Suspense. | source<T>(subscribe: (set: (v: T) => void) => () => void, initial: T): ReadonlySignal<T> — a signal whose writer is external, whose unsubscribe registers in the owning disposal scope, and whose writes enqueue into the same frame-boundary flush as everything else. No compiled artifact; the binding reading it is an ordinary binding. Ledger entry: 'the OS pushes when it pushes'. |
| `Per-frame callback / animation driver` | **keep-but-redesign** | MISSED BY THE DESIGN. It pushes declarative CSS transitions into Rust as interpolation records — correct and elegant for `transition: background 150ms` between two precomputed variants. But JS-driven per-frame work has no host at all: dragging a splitter, a resize handle, inertial scrolling, a physics spring, a progress readout tied to a running job. React has requestAnimationFrame; this has nothing, and src/window-host.ts:288 is `await Bun.sleep(8)` — a 125 Hz poll that is not vsync-aligned. The design notes the engine does not own the frame loop yet (A0 step 3) but never connects that to the missing primitive. | onFrame(cb: (dtMs: number) => void), registered in the window scope, invoked from the loop between drainEvents and the next upload, with the same disposal scopes as effect. Deliberately NOT routed through the signal graph — a drag writes node style cells directly and sets PAINT dirty, exactly as the design's animation records do, because propagating a signal per node per frame at 120 Hz is the failure mode Compose and Flutter both avoid. |
| `Controlled inputs (value / onChange / onInput)` | **keep-but-redesign** | MISSED BY THE DESIGN ENTIRELY. The only editing primitive is bindValue (jsx-runtime.ts:116, src/runtime/bindings.ts:80 typeInto), which appends text and handles Backspace — no caret, no selection, no clipboard, no validation, no rejecting a keystroke, no format-as-you-type. That is not a text input, it is a proof of concept, and every real app needs the real thing. React's controlled-input contract (value + onChange, with the ability to reject or transform the write) has no analogue and cannot be added by convention, because the write happens inside typeInto rather than in user code. It belongs on the primitive list with a ruling, not omitted. | <input value={draft} onInput={(next) => ...} /> where the engine reports the INTENDED edit and Bun decides the resulting string, instead of the engine mutating the signal directly. Requires a caret/selection model in the engine (a node-scoped caret index in the input state that already exists) plus at minimum Home/End/arrows/Delete/Ctrl-A/Ctrl-C/Ctrl-V — src/window-host.ts:274 handles exactly two keycodes today. ROADMAP defers rich text deliberately; plain-text editing cannot be deferred with it. |
| `useReducer` | **compile-away** | Pure userland over a signal. [state, dispatch] is signal(init) plus a function that writes it; the reducer is an ordinary function the compiler never needs to see. No framework primitive, no IR artifact, nothing to build. | const state = signal(init); const send = (a) => { state.value = reduce(state.value, a) } — a signal write and a function, both already handled by the existing machinery. |
| `batch / flushSync` | **keep-but-redesign** | batch() exists (signal.ts:176) and dispatch() wraps every handler in it (bindings.ts:124) because otherwise one handler touching two signals asks for three repaints. Under frame-boundary flushing batch stops being required for correctness and becomes a convenience — an improvement, but also an observable timing change to bindings.ts and patches.ts, and the design lists it as a tradeoff without noting the constraint that makes it delicate: computed INVALIDATION must stay synchronous even inside a batch (signal.ts:54-62 documents exactly why — otherwise an effect subscribed to both a signal and a computed derived from it runs twice). After this change the graph has two propagation timings permanently, and that split must be tested, not merely documented. flushSync has no use case: there is no synchronous DOM to read back, and reading bounds synchronously is the useLayoutEffect problem, not a batching problem. | batch() retained unchanged as an opt-in coalescer; the frame-boundary flush subsumes its repaint-coalescing role. No flushSync. |
| `List virtualization / windowing` | **keep-but-redesign** | MISSED BY THE DESIGN, and the omission that breaks a real app fastest. Lists compile to arenas that materialize every row's subtree (list-runtime.ts; capacity defaults to max(8, len*2) at jsx-runtime.ts:71). A 50k-row table means 50k * stride materialized nodes uploaded, laid out by Taffy and hit-tested. There is no windowing primitive, no overflow, and no clipping at all in paint.rs (only draw_round_rect, draw_rect, draw_str) — therefore no scroll container either. The arena model is the right substrate for windowing (fixed stride, no node moves, ids never invalidated is exactly what a recycler wants) but the primitive does not exist and the design does not name it. It also collides with the design's own risk item: if routes materialize both branches, node count multiplies against list capacity. | A windowed list is an arena of visibleCapacity slots plus a scroll-offset signal, where the runtime rebinds slot i to item (offset + i) — a slot rewrite, which the arena already does for reorders, with no structural change. Blocked on A4 (clipping) for the scroll container, but it must be designed now so the arena's stride and relink semantics do not have to change later. |
| `StrictMode / double-invoke` | **reject** | React double-invokes bodies to surface impure renders. There is no render to double-invoke — but the underlying concern transfers exactly, and the design already has the right mechanism under a different name. The construction pass runs the same code the build pass ran, so comparing the two IS the purity check, and it catches precisely the impurity that matters: nondeterministic component bodies producing divergent signal ordinals. Ship the check; reject the concept and the name. | The shapeHash comparison at startup, extended from a count to a structural hash over (node count, tag sequence, binding sites, signal ordinals) so it catches shape divergence with matching counts. Hard abort naming the first diverging ordinal — never a warning. |

VERDICT: the direction is right and the two headline rejections (recomposition, transitions) are correct and well argued. But four load-bearing claims are false against the actual source, and the primitive set has six omissions a real app hits before it hits Suspense.

FALSIFIED CLAIMS (verified in the repo, not inferred):

1. afterLayout is not a layout effect. C:\Users\med\workspace\skia-proto\native-src\dziri-engine\src\engine.rs:263-296 — tick() does layout, write_bounds, draw(), present() in one call. A callback after tick() runs after present. It has useEffect timing. Every measure-then-position pattern flickers one frame. The design calls it "a real layout effect with zero extra passes"; it is neither.

2. Suspense's compile-time `sources` set is not derivable. The design justifies it with "every binding already carries deps" — but deps are the immediate signal objects recovered by identity (src\compiler\resolve-refs.ts:77-83), and dependency capture is dynamic via the `listener` global (src\runtime\signal.ts:150). The compiler holds a `computed` as an opaque object with no AST pass to see inside it. Pending must propagate transitively at runtime. Structure stays compiled; the source set cannot.

3. <Overlay> is not "~30 lines in paint.rs, needs NO clipping". native-src\dziri-engine\src\paint.rs:244-268 — hit_test walks the tree and prunes on parent bounds, with a comment acknowledging overflow and pruning anyway. An overlay outside its parent's box paints and cannot be clicked. hit_test needs rewriting, plus focus order, plus an anchor that depends on one-frame-stale bounds. Three items, not one.

4. The construction pass cannot run with only signal.ts. src\runtime\signal.ts:117 makes the default buildList THROW outside the compiler, and src\compiler\jsx-runtime.ts:33 is what installs the real one. So the startup pass must ship the JSX runtime, the item-path recorder, flatten/normalize/cn, and run under setCompiling(true) — it is a second compile minus CSS. That falsifies jsx-runtime.ts:8 ("Nothing here ships to the runtime") and also falsifies the design's best claim: a zero-binding subtree does NOT "cost nothing forever", it costs a full Element allocation at startup. Steady state only.

CONFIRMED IN THE DESIGN'S FAVOUR:
- src/window-host.ts:80-93 does discard the `Dirty` return from applyTextBindings and applyStylePatches and sets `dirty = true`. engine.rs:273 is `if self.fresh || diff.any` — a colour-only patch relayouts today. Phase information is being computed and thrown away. The plane-mask argument is the strongest part of the design and it is correct.
- engine.rs:311-313: `if diff.node_styles { apply_all_styles() }` — flipping one hidden byte triggers an O(n) restyle. Since Show/Suspense/error boundaries/routes all ride on `hidden`, the cheapest operation in the design is the most expensive one in the engine. Fix the diff before building on it.
- signal.ts:86,159: subscribers are added on read and never removed; there is no dep-set clearing anywhere in the file. Conditional dependencies accumulate monotonically. Effects cannot be built on this graph as-is.

MISSING PRIMITIVES, ranked by when a real app hits them: controlled text input (immediately — bindValue is append-and-backspace, src/window-host.ts:274 handles two keycodes), untrack/peek (the moment effects exist), effect cleanup with a gate scope (hidden subtrees keep their effects running — the default case, not an edge case), external subscription source (file watchers, OS events, child processes — more common in a desktop app than Suspense), per-frame callback (drag, resize handles, springs — no host at all today), list windowing (50k rows materialize fully; no clipping means no scroll container either).

THE ONE THING TO CHANGE FIRST: add a `constructing` flag to signal.ts and throw on `.value` reads at construction scope outside a computed/effect. React's useState returns a per-render snapshot; a signal returns a live cell; with run-once bodies `const doubled = count.value * 2` silently freezes at 0, renders correctly on frame one, and never updates. That is the single biggest semantic break in the design, it is invisible, and it is ~4 lines using the `listener` global that already exists at signal.ts:48. Without that guard, useState-as-signal should be rejected outright.

