/**
 * What `import "./app.css"` means to TypeScript.
 *
 * A `.css` file is not a module TypeScript knows how to type, so without this it
 * reports TS2882 — "cannot find module or type declarations for side-effect import"
 * — on every stylesheet in the project. The import matters: it is how the compiler
 * learns which stylesheets belong to this window, and its position in the module
 * graph is what orders the cascade.
 *
 * Declared here rather than pulled in from dziri because neither indirection works.
 * Measured, both: `/// <reference types="dziri/css" />` leaves the wildcard invisible
 * (the import still fails to resolve), and `"types": ["dziri/css"]` in tsconfig is
 * TS2688 — the `types` array resolves package roots, not subpaths through an
 * `exports` map. One line in the project is worth more than an indirection that
 * silently does nothing.
 *
 * The empty body is deliberate. The shorthand `declare module "*.css";` would type
 * every such import as `any`, so `styles.button` would type-check and be `undefined`
 * at run time. With the body it is an error — which is correct, because a stylesheet
 * has no value to bind: the cascade is resolved at build time and the artifact holds
 * integers, not a class map.
 *
 * Keep this file.
 */
declare module "*.css" {}
