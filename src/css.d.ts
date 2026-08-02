/**
 * What `import "./app.css"` means to TypeScript.
 *
 * Without this, `tsc` reports TS2882 — "cannot find module or type declarations for
 * side-effect import" — because a `.css` file is not a module it knows how to type.
 * The alternatives it offers are worse: `allowArbitraryExtensions` makes it look for
 * a sibling `app.d.css.ts` that nobody wants to write, and silencing the import with
 * `// @ts-expect-error` would hide a genuine typo in the path.
 *
 * # An empty body, not the shorthand
 *
 * `declare module "*.css";` — the shorthand — would also silence TS2882, but it
 * types every import from it as `any`. Measured: with the shorthand,
 * `import styles from "./app.css"` then `styles.button` type-checks and is
 * `undefined` in the running app. With the empty body it is TS2339, "property
 * 'button' does not exist".
 *
 * That is the whole difference and it is why the body is here. A default import
 * itself is still permitted — it binds an empty module namespace rather than being
 * rejected outright — but nothing can be read off it, which is the guarantee that
 * matters: a stylesheet has no value to bind. The cascade is resolved at build time
 * and the artifact holds integers, so there is no class map and no CSS-module object
 * for a name to refer to.
 *
 * The import is still load-bearing despite binding nothing: it is how the compiler
 * learns the sheet belongs to this window, and its position in the module graph is
 * what orders the cascade.
 */
declare module "*.css" {}
