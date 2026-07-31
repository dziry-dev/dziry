---
name: mdn-sync
description: Vendor MDN's CSS and HTML prose locally so it can be grepped offline. Use before implementing a CSS property or HTML element when you need the edge cases and examples, when working without network, and whenever you are about to assert what the spec says. Runs `bun run mdn:sync`, then grep `vendor/mdn/files/en-us/web/`.
---

# mdn-sync

```bash
bun run mdn:sync            # clone or update (~30 MB, ~6 s)
bun run mdn:sync --status   # which commit is checked out
```

Then just grep it — it is Markdown on disk, no index, no database:

```bash
rg "min-width: auto" vendor/mdn/files/en-us/web/css
rg -l "currentcolor" vendor/mdn/files/en-us/web/css/reference/properties/
```

Pages live at `vendor/mdn/files/en-us/web/css/reference/properties/<name>/index.md`, with YAML
front matter carrying `title`, `slug`, `page-type` (`css-property`, `css-shorthand-property`,
`css-at-rule`, `css-selector`) and `browser-compat`.

## Why this and not a docset

A Dash/Zeal docset is HTML plus a SQLite index, ~100 MB, and Zeal's own CLI only *launches its
GUI* — nothing prints to stdout, so it was never scriptable. MDN's content is a public git repo of
Markdown, and a sparse shallow clone of just the CSS and HTML trees is one tenth the size, six
seconds, and pinnable to a commit. `vendor/mdn.json` records the SHA so a finding is reproducible.

## It is prose only — facts come from `mdn-data`

The Markdown does **not** contain initial values or inheritance flags. MDN renders those "Formal
definition" tables from the `mdn-data` package, which is a dependency here already. So:

- *"what is `border-color`'s initial value?"* → `mdn-data`, or run `spec-audit`
- *"what happens to `min-width: auto` on a flex item?"* → grep this

## Read the prose, then measure it

MDN tells you what should happen. It is a **hypothesis**, and the browser is the test — twice in
one session a confidently-recalled behaviour turned out to be wrong. Use this to find out what to
probe, then run `browser-oracle` to find out what actually happens, and record the result in
`BROWSER-FACTS.md`.

## Licence

MDN prose is CC-BY-SA. `vendor/mdn/` is gitignored deliberately: vendoring it would attach a
share-alike obligation to a repo that does not otherwise carry one. It is a local tool, not part
of the project.
