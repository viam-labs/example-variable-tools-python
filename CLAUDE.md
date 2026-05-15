# CLAUDE.md — example-variable-tools-python

Operational context for future agents working on this repo. Read alongside
`README.md` (user-facing), `webapp/README.md` (scope UI feature reference),
`PUBLISHING.md` (roadmap for shipping `variable_tools` to PyPI), and
`3DVizNotes.md` (research notes on embedding the Viam 3D scene viewer).
Plan that birthed this repo: `/home/shrews/.claude/plans/iridescent-sparking-yao.md`.

## What this is

A Viam module that ships:

1. A drop-in Python library `variable_tools` (in `src/variable_tools/`) that
   any Viam Python module can embed to expose a hierarchical registry of
   typed, runtime-mutable variables over a `vt.*` DoCommand verb namespace
   plus the standard `Sensor.get_readings()` shape.
2. Two Sensor models that exercise the library end-to-end:
   - **`viam:example-variable-tools-python:demo`** — Sensor with a 20 Hz
     fake control loop. As of 0.0.5 includes a 5-waypoint quaternion-slerp
     trajectory with `start`/`pause`/`stop` triggers, a low-pass filtered
     copy of the pose with tunable alphas, and the standard `system.*`
     timing channels via `SystemTiming`.
   - **`viam:example-variable-tools-python:aggregator`** — Sensor that takes
     other resources as deps, fans out via `get_readings` (and `vt.dump`)
     to each in parallel, merges into a unified flat reading map. Itself a
     Sensor so the data manager captures the merged map for free.
3. An SCS-style web scope (`webapp/`) for live inspection, plotting, and
   tuning. Vite + React + uPlot + `@viamrobotics/sdk`. See
   `webapp/README.md` for the full feature surface; broad strokes: drag-
   drop multi-plot, pause + scrub + keyframes, pinned tunables, inline
   sidebar editing, light/dark themes, layout persisted to localStorage.

Inspired by **IHMC YoVariables** — but reshaped for Viam idioms (flat
dotted-path readings instead of a nested tree on the hot path; schema and
tuning over `do_command` instead of a custom protocol).

## File layout

```
webapp/                          # Vite + React + TS + uPlot + @viamrobotics/sdk. See webapp/README.md.
  src/App.tsx                    # Top-level state coordinator. xOverride lives here so scrubBy can pan visible window at edges.
  src/viam-client.ts             # SDK wrapper: probe schema (auto/aggregator/direct), getReadings dump, set
  src/components/
    ConnectionBar.tsx            # Top: status, host, polls/values diagnostics, window/poll dropdowns, theme, connection
    ConnectionDialog.tsx         # Initial / re-auth modal
    VariablePanel.tsx            # Left: search + tree + multi-select + resize handle
    VariableRow.tsx              # Tree row; inline-editable tunable value (Enter commits)
    PlotsArea.tsx                # Toolbar wrapper + grid layout
    PlotsToolbar.tsx             # + plot, pause/step, kf, zoom/pan, reset, columns
    Plot.tsx                     # uPlot mount; pointer events for scrub-drag and middle-pan; scrub + kf overlays; time-corner labels; dbl-click → settings
    PlotSettingsDialog.tsx       # Title + Y-axis (Shared / Independent) segmented control
    DropModeDialog.tsx           # Single / Spread-H / Spread-V picker for multi-drop
    TunablesBar.tsx              # Pinned tunables drop area
    TunableEditor.tsx            # Per-type editor used by tunables bar
  src/lib/ringbuffer.ts          # TimeWindowBuffer — prunes by age (windowSec)
  src/lib/schema.ts              # Schema flatten + scalar formatting (precision parameter)
  src/types.ts                   # Wire-format + UI types incl. PersistedLayout

src/main.py                      # Imports Demo + Aggregator so EasyResource registers them, then Module.run_from_registry().
src/demo.py                      # Demo Sensor — registry, fake 20 Hz loop, trajectory + filter (quaternion slerp).
src/aggregator.py                # Aggregator Sensor — declares config["sources"] as deps, parallel get_readings/vt.dump fan-out, vt.set routing.
src/variable_tools/__init__.py   # Library public surface: Registry, Double, Integer, Boolean, Enum, SystemTiming, handle_command.
src/variable_tools/registry.py   # Registry + Variable subclasses + name validation + version tracking.
src/variable_tools/dispatch.py   # handle_command — verb table for vt.dump / vt.schema / vt.paths / vt.set.
src/variable_tools/timing.py     # SystemTiming — adds system.epoch_s/uptime_s/loop_period_ms/loop_jitter_ms/tick_count.
tests/test_registry.py           # Registry add/get/flatten/schema/version + type coercion + name validation. 64 tests.
tests/test_dispatch.py           # Every vt.* verb: happy path + each error code path.
tests/test_schema_golden.py      # Byte-stable schema assertion against a stored GOLDEN string.
tests/test_demo.py               # Demo Sensor registry shape + tunable round-trip + trajectory math (smoothstep, slerp, axis-angle).
tests/test_aggregator.py         # Aggregator with stub deps; resilience to a failing dep; vt.set routing; schema drift invalidation.
tests/test_timing.py             # SystemTiming math via monkeypatched time.
meta.json                        # Module metadata. Two model entries: :demo and :aggregator, both api rdk:component:sensor.
VERSION                          # Single-line semver. Bump before `make upload` — registry rejects duplicates.
Makefile                         # `make test`, `make module.tar.gz`, `make upload`.
pytest.ini                       # asyncio_mode=auto, testpaths=tests.
run.sh                           # viam-server entrypoint. Creates venv, installs deps, exec's `python -m src.main`.
PUBLISHING.md                    # Plan for taking variable_tools to PyPI.
3DVizNotes.md                    # Research on embedding the Viam 3D scene viewer + scrub sync.
```

## Tests

`make test` from the repo root installs dev deps into `.venv` and runs
pytest. Library tests have **no Viam SDK dependency** — they exercise
the registry + dispatch directly. Module tests bypass `EasyResource.new()`
via `__new__` + manual attr-set (precedent: example-visualizations-python
and apriltag-tracker test patterns), then exercise the deterministic
methods.

Aggregator deps in tests are stubbed as plain objects with an
`async def do_command` — no real Viam resource handles needed.

**The schema-format golden test is load-bearing.** Any intentional change
to the schema dict shape must update `GOLDEN` in
`tests/test_schema_golden.py`. The dump/print is in the assertion failure
message so you can paste the new value directly.

## Architecture

### Lifecycle (both Sensors)

1. `viam-server` runs `run.sh` → `python -m src.main` →
   `Module.run_from_registry()`.
2. On initial resource creation, `EasyResource.new(config, deps)` constructs
   the instance. Per the precedent in every example module in this
   workspace (`example-visualizations-python`, `apriltag-tracker`,
   `isaac_palletizing_sim`), `new` explicitly invokes
   `instance.reconfigure(config, deps)` — services don't get
   auto-reconfigured and the cost of an extra call on components is
   nothing.
3. `validate_config` must return `Tuple[Sequence[str], Sequence[str]]` —
   required deps, optional deps. Returning a bare list produces a runtime
   warning and treats optional deps as empty.
4. On subsequent reconfigure events the framework calls `validate_config`
   then `reconfigure` directly.

### Demo

- `__init__` builds the registry (now ~30 variables across controller,
  diagnostics, system, trajectory, pose, filtered_pose, filter), then
  attaches `SystemTiming` for the standard timing channels.
- `reconfigure` cancels any prior control-loop task, resets `self._t0`,
  resets trajectory state + filtered pose, starts a new `_loop()` task.
  Catches `RuntimeError` (no running loop) during tests/construction.
- `_loop()` runs at 20 Hz; ticks SystemTiming, mutates the demo
  diagnostics, runs the trajectory state machine (start trigger / pause
  state / stop trigger, smoothstep timing per segment, slerp orientation
  between waypoints), applies a 1st-order low-pass filter (lerp on
  translation, slerp on quaternion) with tunable alphas, writes everything
  to the registry. Exceptions other than `CancelledError` are logged at
  error and the loop exits.
- `get_readings` = `self._registry.flatten()`.
- `do_command` delegates to `handle_command`; non-vt verbs return `{}`.
- `close` cancels and awaits the loop task.

**Pose convention as of 0.0.5:** translation in mm + unit quaternion
`(qw, qx, qy, qz)`. Was orientation-vector form in 0.0.4 and earlier.
The change was made because per-component lerp + renormalize on an
orientation vector only animates well within a single fixed axis;
quaternion slerp gives proper great-circle interpolation across all
rotation axes.

### Aggregator

- `validate_config` parses `sources` (required list of resource name
  strings) and returns it as the required-deps tuple element so the
  framework injects the resource handles at `reconfigure`.
- `reconfigure` matches injected `dependencies` by `ResourceName.name`
  against the configured `sources`. Missing sources are warned (defense in
  depth). Schedules a best-effort `_refresh_schemas` task that calls
  `vt.schema` on each dep.
- `get_readings` issues `vt.dump` to every dep via `asyncio.gather` with
  `return_exceptions=True`, then merges the responses, prefixing each key
  with the dep's resource name. A dep that raises, returns a non-Mapping,
  or returns a Mapping without `"values"` is logged at warning and
  skipped — the readings set is partial-but-valid.
- **Schema drift detection:** each dep's cached schema carries a `version`
  int. If a `vt.dump` reply's `version` doesn't match the cached schema's
  `version`, the cache for that dep is invalidated (next `vt.schema_all`
  refetches).
- `do_command`:
  - `vt.schema_all` → refresh + return cached schemas keyed by dep name.
  - `vt.dump` → delegates to `get_readings`. Added in 0.0.3 because the
    earlier webapp called `do_command({"command": "vt.dump"})` on the
    aggregator and got `{}`. The webapp now uses `getReadings` directly
    but the verb is preserved for clients that don't differentiate
    between modes.
  - `vt.set` with `path = "<dep>.<rest>"` → routes to the dep's
    `do_command({"command": "vt.set", "path": rest, "value": value})`.
    No dot in path or unknown dep prefix → `unknown_variable` error.
  - Other verbs → `{}`.

### Library (`variable_tools`)

- **`Registry`** is hierarchical (insertion-ordered children + variables,
  single namespace). Names match `^[A-Za-z0-9_-]+$` — dots are forbidden
  because `.` is the path separator. Duplicate names within a registry are
  rejected at add time.
- **`_version`** is an int bumped on every successful add.
  **`effective_version()`** returns the max over the subtree. Aggregators
  compare cached schema versions against incoming dump versions to detect
  drift.
- **Type coercion is strict.** Doubles reject str, Integers reject bools
  (even though `isinstance(True, int)`), Booleans reject ints, Enums reject
  cases not in the declared list. The `_coerce` raise distinguishes
  `TypeError` (wrong type) from `ValueError` (right type but bad value) so
  dispatch can pick the right error code.
- **Min/max are advisory.** Internal `var.value = ...` writes don't enforce
  them — the trusted control loop can overshoot briefly. Only `vt.set`
  bounds-checks.
- **Schema is byte-stable** through `json.dumps(..., sort_keys=True)`.
  Optional fields (units, min, max) are omitted when `None` rather than
  serialized as nulls. Insertion order of children/variables is preserved
  in the lists (lists aren't sorted by `sort_keys`).
- **`SystemTiming`** is a small helper. Construct with a Registry: it
  adds a `system` child with `epoch_s` / `uptime_s` / `loop_period_ms` /
  `loop_jitter_ms` (windowed std-dev) / `tick_count`. Call `.tick()` once
  per loop iteration. Optional but free for any module that adopts the
  library.

## Conventions and gotchas

- **`vt.*` verb prefix avoids collisions.** Existing example modules in
  this workspace use bare verbs (`list`, `add`, `get_pose`, etc.); bare
  `dump` / `set` would silently collide if a host module embeds the
  library alongside its own surface.
- **`handle_command` returns `None` for non-`vt.*` verbs.** This is what
  lets a host module's `do_command` fall through to its own dispatch after
  calling `handle_command`. Returning a dict (even an error dict) signals
  that the library claimed the verb.
- **`flatten()` does NOT include the Registry's own name in returned
  keys.** So `Registry("arm").add_double("kp", 5.0)` flatten()s to
  `{"kp": 5.0}`, not `{"arm.kp": 5.0}`. The aggregator adds the
  resource-name prefix; double-prefixing would yield ugly keys like
  `arm-1.arm.controller.pid.kp`.
- **Aggregator is a Sensor with dependencies.** Sensors can have deps
  (apriltag-tracker's `overlay_camera` is a Camera with a source-camera
  dep, same pattern). Don't refactor it to a Service unless you have a
  separate reason — Sensor gets you free data-manager capture.
- **Bool is an int in Python.** `isinstance(True, int) == True`. The
  Integer coercer explicitly rejects bools so that
  `int_var.value = True` raises rather than silently storing `1`.
- **`gRPC Value` collapses int and float to float on the wire.** The
  Integer coercer accepts `5.0` (calls `is_integer()`) but rejects `5.5`.
  Schema is the source of truth for distinguishing — clients re-cast using
  the type field.
- **`Sensor.get_readings()` is the canonical hot-path data fetch.** The
  `vt.dump` verb works too (the demo's host implements it; the aggregator
  added it in 0.0.3) but the webapp's poll loop uses `getReadings` because
  it works uniformly across aggregator (fan-out via its own `get_readings`)
  and direct (whose `get_readings` is just `registry.flatten()`).
- **No locking around variable read/write in v1.** Single-process asyncio
  + GIL covers scalar reads/writes. Users adding OS threads own their
  locking; document if you ever add a thread-based example.
- **Boolean trigger semantics are ugly.** Demo's `trajectory.start` and
  `trajectory.stop` are momentary triggers — the loop clears them after
  handling. Webapp briefly sees `true` then `false` between polls. The
  `trajectory.state` enum is the authoritative readout. Document this if
  building similar APIs elsewhere; an Enum command channel is cleaner.
- **Quaternion slerp handles shortest-path via negation.** If
  `dot(q0, q1) < 0`, `_slerp` negates `q1` so it interpolates along the
  shorter arc. Filter slerp also handles this — important since the
  filter chases targets across many ticks and could otherwise wander.

## Webapp gotchas (live in `webapp/`)

- **uPlot's plot area is offset within its container** by the y-axis
  margin (~38 px in shared mode). Use `u.over.getBoundingClientRect()`
  for click-X → time and time → pixel-X math, not the container rect, or
  scrub line and click positions skew by the margin width. Bug fixed in
  the px↔value rewrite — see `Plot.tsx` `plotArea()`.
- **React vs imperative DOM library ownership.** The div uPlot mounts
  into must have NO React-managed children, or React reconciliation will
  remove uPlot's canvas elements on rerenders. Time corners + scrub line
  + empty-state placeholder live as siblings in a positioned wrap div.
- **Pointer capture eats events on overlay buttons.** When paused, the
  wrap's `onPointerDown` would call `setPointerCapture` for scrub-drag,
  which redirected `pointerup` away from the gear/× buttons and the
  click never fired. Buttons now `stopPropagation` on `onPointerDown`
  themselves.
- **Don't rely on uPlot.cursor.sync to sync x scale across plots.** It
  syncs cursor position only. We share the x scale by lifting `xOverride`
  to App and applying it via `u.setScale("x", ...)` in each plot.

## Releasing

Current published version is in `VERSION` (one line, bare semver, currently
`0.0.5`).

`make upload`:
1. Runs `make test` (fails fast if any test fails).
2. Builds `module.tar.gz`.
3. Pushes via `viam module upload --version=$(cat VERSION) --platform=linux/any module.tar.gz`.

Bump `VERSION` before each upload — the registry rejects duplicate
versions. Commit the bump in the same commit as any code changes the
release pulls in.

**Registry constraint to remember:** model `short_description` in
`meta.json` is capped at 100 characters. The first attempted upload of
0.0.1 failed because the aggregator's was 119; trim before push.

## Don't

- **Don't put the schema in `get_readings`.** The schema is metadata that
  changes on registry mutation, not on every tick. Re-encoding it per poll
  wastes bandwidth proportional to depth × poll rate. Schema lives in
  `vt.schema`; readings stay flat.
- **Don't allow dots in variable / registry names.** Path parsing is
  unambiguous because of the name-regex check at add time. Loosening this
  would break `Registry.get(path)`, the aggregator's `vt.set` routing
  (which splits on first `.`), and the schema golden test.
- **Don't make `vt.set` silent on non-tunable vars.** Returning
  `{"ok": false, "error": "not_tunable"}` is the contract. Tunable opt-in
  is the only safety net keeping clients from writing to diagnostic vars.
- **Don't drop the schema golden test.** It catches the most expensive
  regression class — a silent change to the JSON shape that breaks every
  client expecting the old format.
- **Don't widen the type system without a plan.** Adding `Long`, `Float32`,
  or fixed-width arrays sounds reasonable but needs serialization
  decisions (gRPC Value can't represent int64 distinctly from float64).
  Pose-as-quaternion already nudges at this; adding higher-arity types
  needs design.
- **Don't switch the webapp to live updates without measuring.** It uses
  React; per-tick re-renders are expensive at high rates and the chip
  values currently update via a tick counter that bumps once per dump.
  See `3DVizNotes.md` for the full Svelte-vs-React analysis if you're
  considering rewriting.
