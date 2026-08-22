---
name: browser-oracle
description: Measure what a browser actually does, then record it. Use whenever a dziry decision depends on browser behaviour — focus and blur semantics, what a cascade or specificity edge case resolves to, default/UA styles, list markers, form control behaviour, scroll anchoring, event order, IME, HiDPI rounding — or whenever anyone (user or assistant) is about to assert "browsers do X" from memory. Also use before writing any browser-behaviour claim into API.md, BROWSER-FACTS.md, ROADMAP.md or a code comment. Runs a probe in headless Chrome/Edge over CDP via `bun run probe <name>`.
---

# Browser oracle

dziry reimplements browser behaviour for an audience of web developers, so decisions constantly
rest on *"what does a browser actually do here?"* **Recalled answers are wrong often enough to
change decisions.** On 2026-07-31 two separate confidently-stated claims were refuted by
measurement within an hour, one of which had already been written into `API.md` as a design
divergence.

A **probe** is a measuring instrument — like a space probe. A small self-contained page that
pokes the browser and prints what it observed. Nothing to do with problems.

## When to use this

Reach for it when any of these is true:

- A decision hinges on browser behaviour and nobody has measured it *in this repo*.
- You or the user is about to write "browsers do X" into a doc, a code comment, or a decision.
- The user asks "what does Chrome do if…", or proposes matching browser behaviour.
- A design divergence from the browser is being justified — the justification must cite a
  measurement, not a recollection.
- An existing entry in `BROWSER-FACTS.md` is older than the question you are asking, or was
  measured on a different engine version.

Do **not** use it for: what the *spec* says (read the spec), or how another *framework* behaves
(read its source). This measures engines only.

## How to run

```bash
bun run probe focus-removal                      # one probe
bun run probe focus-removal --size 1280x800      # viewport
bun run probe focus-removal --dpr 2              # HiDPI
bun run probe focus-removal --headed             # watch it happen
bun run probe focus-removal --shot out.png       # screenshot
bun run probe --all                              # every probe
bun run probe                                    # lists available probes
```

One command does everything: starts a static server on an ephemeral port, launches headless
Chrome/Edge with a throwaway profile, navigates, waits for the probe to finish, prints its table,
tears everything down. Exit code 1 if any probe failed.

Uses whatever Chromium browser is installed — Chrome or Edge, both fine, both Blink. Override
with `CHROME=/path/to/binary`. There is no install step and no downloaded browser.

## Where things live

```
guards/probes/
  _harness.js          shared helpers — import from every probe
  focus-removal.html   one probe per question
scripts/probe.ts       the CDP runner
scripts/probe-server.ts  static host for guards/probes/
BROWSER-FACTS.md       dated findings. THE OUTPUT. A probe run that isn't recorded is wasted.
```

Name a probe after the *question*, not the feature: `focus-removal`, `cascade-origin-order`,
`list-marker-defaults`. One question per file.

## How to write a probe

```html
<!doctype html>
<meta charset="utf-8">
<title>my-question</title>
<style>body{font:12px ui-monospace,monospace;padding:16px}#out{white-space:pre;line-height:1.5}</style>
<h3>one line saying what this asks</h3>
<script type="module">
  import { log, active, tick, frame, mount, measure, report } from "./_harness.js";

  const setup = () => {
    mount('<div id="anc"><button id="btn">t</button></div>');   // fresh markup per case
    const btn = document.getElementById("btn");
    btn.focus();
    return btn;                                                  // listeners attach to this
  };

  log("=== does focus survive? ===");
  await measure("remove focused element", {
    setup,
    mutate: (btn) => btn.remove(),
    events: ["blur", "focusout"],       // optional: which events to record
    read: active,                        // optional: defaults to active()
  });

  report();                              // REQUIRED — the runner waits for this
</script>
```

Harness API:

| | |
|---|---|
| `mount(html)` | replace the stage with fresh markup. Call per case so no case inherits another's state. |
| `measure(name, {setup, mutate, read, events})` | run one case; records state before, synchronously after, and after a tick |
| `active()` | short description of `document.activeElement` |
| `tick()` | one macrotask |
| `frame()` | two rAFs — use when the question involves layout or style resolution |
| `log(s)` | free-form line |
| `report()` | **required.** Fills `#out`, logs `[PROBE]`, sets `document.title = "done N"` |

`report()` is how the runner knows the probe finished. A probe that never calls it fails with
*"probe never called report()"* rather than hanging.

`report()` also prints the engine name and version, viewport and DPR at the top of every table,
because these are engine behaviours, not "browser" behaviours.

## Rules, each one learned the hard way

- **Never inject a probe into a live page.** Two reasons, both silent: the host page's stylesheet
  contaminates any cascade or layout measurement, and a *backgrounded tab suppresses focus
  events* — which produced a wrong, published finding on 2026-07-31. Always `bun run probe`.
- **`file://` is blocked** for the Chrome extension, and top-level `data:` navigation is blocked
  by Chrome itself. That is why there is a server.
- **Measure synchronously *and* after a tick.** `measure()` does both. Reporting one hides
  whether an effect is deferred, which has repeatedly been the interesting part.
- **Observing can perturb.** Reading `document.activeElement` around a dispatched event changed
  the outcome in one case. If two runs disagree, do not pick the nicer answer — log every
  intermediate step and re-run until you can explain the difference, or record it as unresolved.
- **Run it twice** before recording. Flaky is a finding.
- **Say "Chromium 151", never "browsers".** Different engines, different answers; and the
  installed browser may be Edge.
- **Record in `BROWSER-FACTS.md`**: date, engine + version, the table, and what it means for
  dziry. Append a new dated block; never overwrite an earlier finding. If a new run corrects an
  old one, say so explicitly and say what was wrong — a superseded claim may already have been
  built on.

## When a result contradicts a design decision

Say so immediately and plainly, before writing anything into `API.md`. Then check whether the
refuted claim was already used to justify something, and go fix that too — on 2026-07-31 a bad
measurement had already become an API divergence, and withdrawing the divergence was the actual
deliverable.

A measured refutation is the highest-value output this skill produces. Confirming what everyone
already believed is the cheap case.
