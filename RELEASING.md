# Releasing

A release is one gesture: create the GitHub Release, and its tag triggers
`.github/workflows/release.yml`, which builds the engine on five platform
runners (each gated by the full cargo suite), publishes the five
`dziry-engine-*` packages, then `dziry`, then `create-dziry`. Every publish
is skipped when that exact version already exists on the registry, so a
partially-failed release is resumed by re-running the workflow.

## Checklist

1. **Bump the version in three places** (all must match):
   - `package.json` — `version`
   - `package.json` — all five entries in `optionalDependencies`
     (exact versions, deliberately: the engine and the runtime share a
     protocol version, so a binary from another release is a protocol
     mismatch, not merely stale)
   - `packages/create-dziry/package.json` — `version`
2. `bun install` (refreshes `bun.lock`), then the battery:
   `bun run test && bun run check && bun run docs:build`.
3. Commit and push. Wait for CI to go green on the commit.
4. Write the release notes (format below), then:

   ```bash
   gh release create v<version> --title "v<version>" --notes-file notes.md
   ```

   The tag this creates is what triggers the publish. Watch the `release`
   workflow; when it is green, verify with `npm view dziry version`.
   (`dziry` itself can sit in npm's post-publish processing queue for up to
   ~40 minutes before `npm view` sees it — that is normal.)

## Release notes format

Written for the app author, not the maintainer. The commit log is for us;
the release page is for them.

```markdown
## Breaking changes
- <what changed, as the user experiences it>. **Migration:** <the exact edit>.

## New
- <feature> (docs: <link to its page on dziry.dev>)

## Fixed
- <the symptom the user saw, not the internal cause>

## Notes
- <platform caveats, deprecation warnings, anything upgraders should know>
```

Rules:

- **Breaking changes first, each with a migration step.** If there are none,
  write "No breaking changes." explicitly — during a beta that sentence is
  the most valuable one on the page.
- **Describe what the user experiences**, not the commit: "macOS: red and
  blue were swapped on screen", never "pin BGRA8888 in raster_surface".
- **Every "New" entry links to its docs page.** A feature with no docs page
  is not done.
- No internal file names, no dates, no "refactored X" — pure refactors are
  invisible to users and do not appear at all.
- Credit outside contributors by handle.

## Auth

Publishing currently authenticates with a granular npm token in the
`NPM_TOKEN` repository secret (the account's 2FA is a passkey, which CI
cannot answer). The planned migration is npm Trusted Publishing (OIDC),
configured per package on npmjs.com — once that lands, the token steps
disappear from `release.yml` and the secret is deleted.

## Versioning during the beta

Betas are `0.1.0-beta.N` and may break the authoring API — that is what the
"Breaking changes" section is for. `bun run docs:version` snapshots the docs
only when there is a stable release worth freezing; do not run it for betas.
