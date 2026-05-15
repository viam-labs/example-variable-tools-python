# Publishing `variable_tools`

Plan for taking the embedded library out of this example module and
shipping it as a standalone, reusable artifact.

Today the library lives inside this repo as `src/variable_tools/`. Users
adopt it by copying the directory into their own module's source tree.
That's fine for a couple of in-house users; it doesn't scale to "a
generic Viam Python convenience" for the broader community.

This doc tracks what needs to happen before that promotion.

---

## Phase 1 — Stand it up as its own package

Goal: make `pip install viam-variable-tools` work and exercise it from a
brand-new module with no copy-paste.

- [ ] **Decide the name and home.** Suggested: package
  `viam_variable_tools`, distribution `viam-variable-tools`, repo
  `viam-labs/viam-variable-tools`. Avoid clashing with anything Viam may
  ship in core. Confirm name availability on PyPI.
- [ ] **Extract `src/variable_tools/` into a new repo.** Keep the API
  identical. The example module here keeps using it as a dependency
  rather than an embedded copy.
- [ ] **Write `pyproject.toml`** (PEP 621). Build backend
  `hatchling` or `setuptools`. No runtime deps (it's pure Python). Dev
  deps: pytest, pytest-asyncio for tests of any future async surface.
- [ ] **Move tests with the package.** All four test files
  (`test_registry.py`, `test_dispatch.py`, `test_schema_golden.py`,
  `test_timing.py`) are library-only — no Viam SDK dependency. They
  belong in the new repo.
- [ ] **Decide minimum Python version.** Currently uses 3.8+ syntax
  (`from typing import` etc.). Hold the line at 3.9 or 3.10.
- [ ] **License the package** Apache 2.0 (same as the example module).
  Add `LICENSE` and a SPDX header in each source file.
- [ ] **Add a `CHANGELOG.md`.** Start at `0.1.0` (treating today's API
  as the first stable surface).
- [ ] **CI: GitHub Actions.** Run pytest against the supported Python
  matrix on push/PR. Build a wheel + sdist on tag.
- [ ] **PyPI release pipeline.** Trusted publisher via OIDC if
  publishing under a Viam org; otherwise a token from a maintainer.
  Tag `v0.1.0` → wheel + sdist on PyPI.

## Phase 2 — Repoint this example module to consume the package

- [ ] Add `viam-variable-tools` to `requirements.txt` here.
- [ ] Delete `src/variable_tools/` from this repo.
- [ ] Update imports in `src/demo.py`, `src/aggregator.py` from
  `from .variable_tools import ...` to `from variable_tools import ...`.
- [ ] Update `Makefile` so `module.tar.gz` no longer lists the embedded
  library files (they come from the venv).
- [ ] Bump the example module version (next would be `0.1.0` when this
  flips, since it's a consumer-API change for downstream forks).

## Phase 3 — Documentation site

A README in the package repo isn't enough for an external audience that
hasn't seen the example.

- [ ] **Quickstart**: a 30-line "add it to your existing module" walk-
  through, using a generic component (e.g. an Arm or a Sensor) rather
  than the playground demo. Show the four steps: build a registry,
  call `tick()` on `SystemTiming`, mutate variables in your loop,
  delegate `do_command` to `handle_command`.
- [ ] **API reference**: auto-generated from docstrings (mkdocs +
  mkdocstrings, or pdoc). Class-by-class: `Registry`, `Variable`,
  `Double`, `Integer`, `Boolean`, `Enum`, `SystemTiming`,
  `handle_command`.
- [ ] **Wire format reference**: the four `vt.*` verbs and their
  request/response shapes. Same content as the README's verb contract
  table but on its own page so it's easy to link to from third-party
  client docs.
- [ ] **Patterns page**: building a custom component, exposing PID gains,
  a "tunable from the start" pattern, dealing with momentary triggers
  (and why we recommend an Enum command channel over boolean triggers
  in new code).
- [ ] **Migration / versioning policy**: SemVer commitment for the
  Python API and the wire-format schema. Schema changes are a
  major-version bump (the byte-stable golden test gates this).

## Phase 4 — More examples (separate repos)

The example here is a fake control loop. To make the value clear to
people building real things:

- [ ] **`variable-tools-arm-example`** — wraps an existing Arm component,
  exposes joint targets vs measured + a few PID-like tunables.
- [ ] **`variable-tools-vision-example`** — a vision module that exposes
  detection-rate, last-detection-latency, threshold tunables.
- [ ] **Tutorial blog post / docs entry on viam.com** linking to the
  package and these examples.

## Phase 5 — The scope webapp

Currently the webapp lives in `webapp/` of this example module. For
broader use it deserves its own repo.

- [ ] **Promote the webapp** to `viam-labs/variable-tools-scope`. Same
  Vite + React + uPlot stack. README explains how to point it at any
  machine running a `vt.*` resource.
- [ ] **Hosted version**: GitHub Pages deployment of the static build
  so users can use it without `npm install`. Caveat: WebRTC works from
  any origin, so a static page is fine — credentials still entered at
  runtime, never baked in.
- [ ] **Decide on Svelte vs React.** When/if we adopt
  `@viamrobotics/motion-tools` for a 3D scene panel, the React/Svelte
  mismatch tilts the calculus toward a Svelte rewrite. See
  `3DVizNotes.md` in this repo for the analysis.

## Phase 6 — Go port (optional)

- [ ] If demand exists from Go-module authors, port the library to Go.
  API surface translates directly: `Registry`, `Variable[T]` generics,
  `HandleCommand`. Wire format identical.

## Open questions

- **Naming.** Does "variable_tools" stick, or rename to something more
  Viam-flavored (`viam_signals`, `viam_introspect`, etc.)? Decide before
  publishing — rename later is painful.
- **PyPI org.** Personal account, viam-labs, or `viam`? `viam` is the
  official Viam org's namespace. Publishing under `viam` requires
  Viam-employee status / their org's approval.
- **Should `SystemTiming` ship in the same package or a sub-package?**
  It's a 50-line helper; in-package is fine.
- **Versioning the schema independently from the library.** A `vt.set`
  client + a `vt.dump` client should agree on schema shape regardless
  of library version. The byte-stable golden test enforces this within
  the test suite, but should we expose `SCHEMA_FORMAT_VERSION` as a
  constant so cross-version clients can negotiate? Not yet, but flag
  if we ever consider a schema change.

## Risks

- **API churn before 1.0.** The `tunable` flag, `vt.set` error codes,
  schema field names — anything we expose in 0.x can change. Be honest
  about that in the README.
- **Bus factor.** This is currently one person's library. PyPI
  publication implies some commitment to maintaining it. If that
  commitment isn't there, leaving as a copy-paste reference in the
  example repo is a legitimate alternative.
- **Overlap with anything Viam may ship later.** If Viam adds a
  first-party introspection API, this library either becomes redundant
  or has to bridge to it. Worth checking before committing to the name.
