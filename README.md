# example-variable-tools-python

A drop-in Python library plus two example Sensors for exposing a hierarchical
registry of named, typed, runtime-mutable variables (`Double`, `Integer`,
`Boolean`, `Enum`) from a Viam module — and an SCS-inspired browser scope for
inspecting, plotting, and tuning them live. Inspired by IHMC YoVariables,
reshaped for Viam idioms (flat dotted-path readings on the hot path; schema
and tuning over `do_command`).

Currently shipping at **0.0.5**.

## What this gives you

```
variable_tools (library)             ← drop into your existing module
├── Registry  (hierarchical container)
├── Double / Integer / Boolean / Enum
├── SystemTiming                     ← drop-in helper that adds system.epoch_s,
│                                       uptime_s, loop_period_ms, loop_jitter_ms,
│                                       tick_count to any module
├── handle_command(reg, cmd)         ← mixin do_command dispatch
└── flatten(), schema()              ← for get_readings + vt.schema

viam:example-variable-tools-python:demo (Sensor)
  ├── controller.pid.kp/ki, controller.state, diagnostics.*
  ├── system.* (via SystemTiming)
  ├── trajectory.* (start/pause/stop, time, state)
  ├── pose.{x,y,z,qw,qx,qy,qz}      ← 5-waypoint quaternion-slerp trajectory
  ├── filtered_pose.*               ← low-pass-smoothed copy of pose
  └── filter.alpha_translation, filter.alpha_orientation (tunable)

viam:example-variable-tools-python:aggregator (Sensor)
  ├── takes resource deps via config "sources": [...]
  ├── parallel get_readings fan-out, prefix keys with dep name
  └── data manager auto-captures the unified flat map

webapp/                              ← Vite + React + uPlot SCS-style scope
  ├── searchable tree of every variable, live values
  ├── multi-plot drag-and-drop, columns layout, per-plot Y-axis modes
  ├── pause + scrub + keyframes; click/drag scrub, wheel-step, middle-pan
  ├── pinned tunables area + inline edit in sidebar (Enter to commit)
  └── light/dark theme, layout persists to localStorage
```

## Drop-in pattern for your own module

The library isn't on PyPI yet (see `PUBLISHING.md`). To use it today, copy
`src/variable_tools/` from this repo into your own module's `src/` directory
— the package is pure Python with no external dependencies. Then:

```python
from .variable_tools import Registry, SystemTiming, handle_command


class MyArm(Arm, EasyResource):
    def __init__(self, name):
        super().__init__(name)
        self._registry = Registry("my_arm")
        # Standard timing channels — optional but free.
        self._timing = SystemTiming(self._registry)
        # Your own variables.
        pid = self._registry.add_child("pid")
        self._kp = pid.add_double("kp", 5.0, tunable=True, min=0.0, max=100.0)
        self._loop_count = self._registry.add_int("loop_count", 0)

    async def do_command(self, command, **kwargs):
        # Library handles vt.* verbs; everything else falls through.
        if (resp := handle_command(self._registry, command)) is not None:
            return resp
        # ... your own verbs ...
        return {}

    # In your control loop:
    #   self._timing.tick()                              # update system.*
    #   self._loop_count.value = self._loop_count.value + 1
    #   self._kp.value = 6.0                              # in-process, no IPC
```

If your module already uses `Sensor`, also wire `get_readings` to the
registry so it's captured by the data manager and visible in the scope:

```python
async def get_readings(self, **kwargs):
    return self._registry.flatten()
```

## Settable vs state — one flag

Every variable carries a `tunable: bool`. Default is `False` (state). Set
`tunable=True` for things clients can write:

```python
pid.add_double("kp", 5.0, tunable=True, min=0.0, max=100.0)   # client-writable
diagnostics.add_int("loop_count", 0)                            # state, default
```

The library enforces it asymmetrically: over-the-wire `vt.set` returns
`{"ok": false, "error": "not_tunable"}` for non-tunable; in-process
`var.value = X` is always allowed (the control loop is trusted).

## Verb contract

All verbs are namespaced `vt.*` to avoid colliding with your module's own
DoCommand verbs. `handle_command` returns `None` if the verb isn't `vt.*`,
so your dispatch falls through.

| Verb | Input | Output |
|---|---|---|
| `vt.dump` | `{"command": "vt.dump"}` | `{"values": {path: scalar}, "version": int}` |
| `vt.schema` | `{"command": "vt.schema"}` | `{"schema": <tree>, "version": int}` |
| `vt.paths` | `{"command": "vt.paths"}` | `{"paths": [str], "version": int}` |
| `vt.set` | `{"command": "vt.set", "path": str, "value": scalar}` | `{"ok": true, "previous": scalar, "value": scalar}` OR `{"ok": false, "error": code}` |

`vt.set` error codes: `unknown_variable`, `not_tunable`, `out_of_range`,
`wrong_type`, `invalid_enum_case`. Min/max bounds are enforced **only** on
`vt.set` — internal `var.value = ...` from your control loop is trusted.

The aggregator additionally implements `vt.schema_all` (returns merged
schemas keyed by source name) and routes `vt.set` by path prefix.

The canonical hot-path data fetch is **`Sensor.get_readings()`**, which
returns the same flat dict as `vt.dump.values` — works for both the demo
and the aggregator (whose `get_readings` does the fan-out). The webapp uses
`getReadings` for polling.

## Wire format

`get_readings` returns flat dotted-path keys: `{"controller.pid.kp": 5.0,
"diagnostics.loop_count": 42}`. The tree shape lives in `vt.schema` and is
sent once per client. This matches IHMC's SCS log convention and means Viam
Cloud's data tab plots each variable as its own scalar time-series — nested
readings would either get flattened anyway or stored as un-plottable JSON.

Variable and registry names must match `^[A-Za-z0-9_-]+$` — the `.`
separator is reserved, dots in names would be ambiguous. Duplicates inside
a single registry are rejected at add time.

## Configuring the demo

Drop this into your machine config (or just bump `version` and let viam-server
pick up the changes):

```json
{
  "modules": [
    {
      "type": "registry",
      "name": "example-variable-tools-python",
      "module_id": "viam:example-variable-tools-python",
      "version": "0.0.5"
    }
  ],
  "components": [
    {
      "name": "vt-demo",
      "namespace": "rdk",
      "type": "sensor",
      "model": "viam:example-variable-tools-python:demo",
      "attributes": {}
    },
    {
      "name": "vt-aggregator",
      "namespace": "rdk",
      "type": "sensor",
      "model": "viam:example-variable-tools-python:aggregator",
      "attributes": {
        "sources": ["vt-demo"],
        "prefix_with_name": true
      },
      "depends_on": ["vt-demo"]
    }
  ]
}
```

The demo runs a 20 Hz fake control loop with:

- **`controller.*`** — PID gains (tunable), state machine
- **`diagnostics.*`** — counter, fault flag, sine-wave loop time
- **`system.*`** — wall clock, uptime, loop period, loop jitter, tick count
- **`trajectory.*`** — `start`/`pause`/`stop` (tunable booleans), `trajectory_time`
  (tunable, default 8 s), `time_in_trajectory` (read-only), `state` enum readout
- **`pose.{x,y,z,qw,qx,qy,qz}`** — current waypoint-interpolated pose
  (translation in mm, unit quaternion), 5 waypoints with smoothstep timing
  per segment and slerp orientation
- **`filtered_pose.*`** — same shape as `pose`, filtered through a 1st-order
  low-pass with separate alphas for translation and orientation (slerp-EMA)
- **`filter.alpha_translation`**, **`filter.alpha_orientation`** — both tunable,
  range 0.001–1.0, default 0.1

The aggregator (above) declares `vt-demo` as a dep, fans out, and adds the
`vt-demo.` prefix to every key. A source that doesn't speak `vt.*` (or
crashes) is logged and skipped — the reading set is partial-but-valid.

`do_command` on the aggregator:
- `vt.schema_all` returns merged schemas keyed by dep name
- `vt.dump` delegates to `get_readings`
- `vt.set` routes by path prefix: `vt-demo.controller.pid.kp` → forwards to
  the `vt-demo` dep as `controller.pid.kp`

## Tests

```sh
make test
```

Runs the full pytest suite (118 tests as of 0.0.5). The schema-format
golden test (`tests/test_schema_golden.py`) is byte-stable — any
intentional change to the schema shape must update the stored golden
string.

## Web UI — `webapp/`

An SCS-inspired browser scope for live inspection and tuning.

```sh
cd webapp && npm install && npm run dev   # → http://localhost:5173
```

Headline features:

- Searchable hierarchical tree with live values inline; **shift/ctrl-click**
  to multi-select; **drag** onto a plot or the tunables bar
- Multi-plot grid with **drag-drop**, **columns 1–4**, per-plot **shared/
  independent Y-axis** mode, drop-mode picker for spreading multiple
  variables across plots
- **⏸ Pause / ▶ Resume**, **◀ ▶ step**, **🔍+ / 🔍− / pan / reset zoom**,
  buffer window 10 s–15 min — all in a graph-area toolbar
- **Scrub when paused** with a vertical accent line synced across all
  plots; chip values + sidebar values reflect the scrub timestamp;
  **click/drag** to scrub, **wheel** to step, **middle-mouse drag** to pan,
  edge auto-pan
- **Keyframes** ◆+ / ◀◆ / ◆▶ — pin scrub points and jump between them
- **Pinned tunables** area at the bottom: drag tunable variables in to
  expose editor widgets, including from multi-selection
- **Inline editing** in the sidebar — click any tunable value, type, Enter
  to commit; bool/enum use a small dropdown so they need explicit
  confirmation
- **Light / dark theme**, **resizable sidebar**, full layout persisted to
  `localStorage`

See `webapp/README.md` for the full feature list, connection setup, and
limitations.

## What this isn't

- **Not real-time at control-loop rate.** Polling over gRPC realistically
  caps around 20 Hz over WebRTC. For diagnostics and tuning, polling is
  fine; for control-loop scrubbing you'd want a streaming verb (out of
  scope, see `3DVizNotes.md` for related thinking).
- **Not cross-process state.** Each module owns its own registry. Variable
  updates inside a module are in-process and free; the aggregator's
  cross-module merge is poll-based.
- **Not yet on PyPI.** See `PUBLISHING.md` for the roadmap.

## Files

- `src/variable_tools/` — the library (drop-in)
- `src/demo.py`, `src/aggregator.py`, `src/main.py` — the example sensors
- `tests/` — 118 pytests; `make test` runs them
- `webapp/` — Vite + React + uPlot scope (see `webapp/README.md`)
- `PUBLISHING.md` — roadmap for shipping the library publicly
- `3DVizNotes.md` — design notes for embedding the Viam 3D scene viewer
- `CLAUDE.md` — operational context for future agents

## License

Apache 2.0.
