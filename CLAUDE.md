# CLAUDE.md — example-variable-tools-python

Operational context for future agents working on this repo. Read alongside
`README.md` (user-facing). Plan that birthed this repo:
`/home/shrews/.claude/plans/iridescent-sparking-yao.md`.

## What this is

A Viam module that ships:

1. A drop-in Python library `variable_tools` (in `src/variable_tools/`) that
   any Viam Python module can embed to expose a hierarchical registry of
   typed, runtime-mutable variables over a `vt.*` DoCommand verb namespace.
2. Two Sensor models that exercise the library end-to-end:
   - **`viam:example-variable-tools-python:demo`** — a Sensor with a fake
     20 Hz control loop populating ~6 variables across 2 child registries.
   - **`viam:example-variable-tools-python:aggregator`** — a Sensor that
     takes other resources as deps, fans out `vt.dump` to each in parallel,
     and returns a unified flat reading map. The aggregator is itself a
     Sensor so the data manager captures the merged map for free.

Inspired by **IHMC YoVariables** — but reshaped for Viam idioms (flat
dotted-path readings instead of a nested tree on the hot path; schema and
tuning over `do_command` instead of a custom protocol).

## File layout

```
webapp/                      # SCS-inspired browser UI. Vite + React + TS + uPlot + @viamrobotics/sdk. See webapp/README.md.
  src/App.tsx                # Top-level state + layout coordinator
  src/viam-client.ts         # SDK wrapper: probe schema (auto/aggregator/direct), dump, set
  src/components/            # Connection bar/dialog, variable panel (flat+tree), plots, tunables bar
  src/lib/ringbuffer.ts      # Fixed-capacity sample store for plots
src/main.py                  # Imports Demo + Aggregator so EasyResource registers them, then Module.run_from_registry().
src/demo.py                  # Demo Sensor — builds a registry, runs a 20 Hz fake control loop, dispatches do_command to handle_command.
src/aggregator.py            # Aggregator Sensor — declares config["sources"] as deps, parallel vt.dump fan-out, vt.set routing.
src/variable_tools/__init__.py  # Library public surface: Registry, Double, Integer, Boolean, Enum, handle_command.
src/variable_tools/registry.py  # Registry + Variable subclasses + name validation + version tracking.
src/variable_tools/dispatch.py  # handle_command — verb table for vt.dump / vt.schema / vt.paths / vt.set.
tests/test_registry.py       # Registry add/get/flatten/schema/version + type coercion + name validation. 64 tests.
tests/test_dispatch.py       # Every vt.* verb: happy path + each error code path.
tests/test_schema_golden.py  # Byte-stable schema assertion against a stored GOLDEN string.
tests/test_demo.py           # Demo Sensor registry shape + tunable round-trip via do_command.
tests/test_aggregator.py     # Aggregator with stub deps; resilience to a failing dep; vt.set routing; schema drift invalidation.
meta.json                    # Module metadata. Two model entries: :demo and :aggregator, both api rdk:component:sensor.
VERSION                      # Single-line semver. Bump before `make upload` — registry rejects duplicates.
Makefile                     # `make test`, `make module.tar.gz`, `make upload`.
pytest.ini                   # asyncio_mode=auto, testpaths=tests.
run.sh                       # viam-server entrypoint. Creates venv, installs deps, exec's `python -m src.main`.
```

## Tests

`make test` from the repo root installs dev deps into `.venv` and runs
pytest. The library tests have **no Viam SDK dependency** — they exercise
the registry + dispatch directly. The module tests (`test_demo.py`,
`test_aggregator.py`) bypass `EasyResource.new()` via `__new__` + manual
attr-set (precedent: example-visualizations-python and apriltag-tracker
test patterns), then exercise the deterministic methods.

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
   `instance.reconfigure(config, deps)` even though the SDK auto-reconfigure
   for components nominally covers it — the precedents all play it safe
   because services don't get auto-reconfigured and the cost of an extra
   call is nothing.
3. `validate_config` must return `Tuple[Sequence[str], Sequence[str]]` —
   required deps, optional deps. Returning a bare list produces a runtime
   warning and treats optional deps as empty.
4. On subsequent reconfigure events the framework calls `validate_config`
   then `reconfigure` directly.

### Demo

- `__init__` builds the registry (6 variables, structure locked at startup).
- `reconfigure` cancels any prior control-loop task, resets `self._t0`,
  starts a new `_loop()` task. Catches `RuntimeError` (no running loop)
  during tests/construction.
- `_loop()` runs at 20 Hz; each tick increments `loop_count`, updates
  `loop_time_ms` (sine wave on a 5 s period), flips `fault_active` every
  7 s, cycles `state` through `STATE_CYCLE`. Exceptions other than
  `CancelledError` are logged at error and the loop exits.
- `get_readings` = `self._registry.flatten()`.
- `do_command` delegates to `handle_command`; non-vt verbs return `{}`.
- `close` cancels and awaits the loop task.

### Aggregator

- `validate_config` parses `sources` (required list of resource name
  strings) and returns it as the required-deps tuple element so the
  framework injects the resource handles at `reconfigure`.
- `reconfigure` matches injected `dependencies` by `ResourceName.name`
  against the configured `sources`. Missing sources are warned (the
  framework should have already refused to start if a required dep is
  missing — but defense-in-depth). Schedules a best-effort
  `_refresh_schemas` task that calls `vt.schema` on each dep.
- `get_readings` issues `vt.dump` to every dep via `asyncio.gather` with
  `return_exceptions=True`, then merges the responses. A dep that raises,
  returns a non-Mapping, or returns a Mapping without `"values"` is logged
  at warning and skipped — the readings set is partial-but-valid.
- **Schema drift detection:** each dep's cached schema carries a `version`
  int. If a `vt.dump` reply's `version` doesn't match the cached schema's
  `version`, the cache for that dep is invalidated (next `vt.schema_all`
  will re-fetch).
- `do_command`:
  - `vt.schema_all` → refresh + return cached schemas keyed by dep name.
  - `vt.set` with `path = "<dep>.<rest>"` → routes to the dep's
    `do_command({"command": "vt.set", "path": rest, "value": value})`.
    No dot in path or unknown dep prefix → `unknown_variable` error.
  - Other verbs → `{}`.

### Library (`variable_tools`)

- **`Registry`** is hierarchical (insertion-ordered children + variables,
  single namespace). Names match `^[A-Za-z0-9_-]+$` — dots are forbidden
  because `.` is the path separator. Duplicate names within a registry are
  rejected at add time.
- **`_version`** is an int bumped on every successful add. **`effective_version()`** returns the max over the subtree. Aggregators compare cached
  schema versions against incoming dump versions to detect drift.
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
- **No locking around variable read/write in v1.** Single-process asyncio
  + GIL covers scalar reads/writes. Users adding OS threads own their
  locking; document if you ever add a thread-based example.

## Releasing

Current published version is in `VERSION` (one line, bare semver).
`make upload`:
1. Runs `make test` (fails fast if any test fails).
2. Builds `module.tar.gz`.
3. Pushes via `viam module upload --version=$(cat VERSION) --platform=linux/any module.tar.gz`.

Bump `VERSION` before each upload — the registry rejects duplicate
versions. Commit the bump in the same commit as any code changes the
release pulls in.

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
  YAGNI for v1.
