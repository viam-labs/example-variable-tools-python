# variable-tools scope

An SCS-inspired web UI for inspecting and tuning `variable_tools` registries
exposed by any Viam module via the `vt.*` DoCommand verbs.

## What it does

- Connects to any Viam machine running a sensor that responds to `vt.dump`
  (and optionally `vt.schema` / `vt.schema_all`).
- Shows the schema as a **searchable flat list or hierarchical tree** in the
  left panel. The list/tree updates live values inline so you can see what
  each variable is doing right now.
- **Drag any variable onto a plot in the center** to time-series it. Multiple
  variables per plot, multiple plots stacked. Plots redraw every poll tick.
- **Tunable variables** show up in a bar at the bottom with type-appropriate
  inline editors — number input for doubles/integers (with min/max enforced
  by `vt.set` on the server), dropdown for enums, toggle for booleans.
- **Polling rate** is configurable from the top bar (1–30 Hz). The library's
  in-process variables update at whatever rate the host module mutates them;
  this is just the polling rate over gRPC.
- **Layout persists** to `localStorage` (connection config, plot list,
  view mode, tree expansion, poll rate).

## Running locally

```sh
cd webapp
npm install
npm run dev        # → http://localhost:5173
```

First load shows a connection dialog. Fill in:

- **Machine address** — the `*.viam.cloud` FQDN for the machine. For the demo
  module deployed to `variable-tools-9000`, this is
  `variable-tools-9000-main.pgn074cus0.viam.cloud`.
- **API key id + key** — create one on app.viam.com under Settings → API Keys
  if you don't have one. The key only needs read access to the machine.
- **Resource name** — usually the aggregator (`vt-aggregator`). If your
  machine doesn't run an aggregator, point this at a single sensor and pick
  "Direct sensor" in the Mode dropdown.

Credentials persist to `localStorage` — clear it through devtools to force
the dialog back on next load.

## How it talks to the machine

The webapp uses `@viamrobotics/sdk` over WebRTC, dialed through Viam's
signaling at `app.viam.com:443`. STUN servers are populated automatically.
The same auth and addressing works against any machine in any Viam org you
have access to.

For each poll:

1. Issues `do_command({"command": "vt.dump"})` on the configured resource.
2. Appends `(timestamp_ms, value)` to a ring buffer per variable path
   (capacity 4000 samples ≈ 200 s at 20 Hz).
3. Bumps a tick counter; plots redraw against their subscribed buffers.

On connect (and any time you reconnect):

1. Probes `vt.schema_all` for aggregator mode, falls back to `vt.schema` for
   direct mode. The schema tree drives the variable panel + tunable list.
2. Flattens to dotted-path keys matching the wire format of `vt.dump`.

## Plotting non-numeric values

The wire format includes booleans and enums. The plot lib (uPlot) is numeric,
so:

- **Booleans** plot as 0 / 1.
- **Enums** plot as the index into their `cases` list. The chip in the plot
  shows the path; the schema's `cases` are the y-axis lookup, but we don't
  label y-ticks for them in v1 — coming later.
- **Doubles / Integers** plot natively in their own units.

If a plot mixes types (e.g. `loop_count` Integer + `loop_time_ms` Double),
uPlot auto-scales to fit both. For control-engineering use you typically
group like-typed variables in one plot.

## Tuning at runtime

The tunables bar at the bottom lists every variable with `tunable: true` from
the schema. Editing one issues `vt.set` against the right resource:

- **Aggregator mode:** `vt.set` is sent to the aggregator with the full
  prefixed path (e.g. `vt-demo.controller.pid.kp`); the aggregator splits
  off the prefix and routes to the owning dep.
- **Direct mode:** `vt.set` is sent to the sensor with the local path
  (e.g. `controller.pid.kp`).

The UI does an optimistic local update on submit; if the server returns
`{"ok": false, "error": ...}` (e.g. `out_of_range` or `invalid_enum_case`),
the previous value is restored and the error is shown inline on the editor
until the next successful set.

## Limitations (v1)

- **Polling, not streaming.** Variables mutating inside the host module
  faster than the poll rate are aliased. Bumping past ~20 Hz starts dropping
  samples in practice over WebRTC. For diagnostics this is plenty; for
  control-loop scrubbing you'd want a streaming verb (out of scope for v1).
- **No plot reorder / resize.** Plots stack in insertion order at fixed
  height. Use add/remove. Reorder is a small follow-up.
- **No persisted ring buffer.** Refresh wipes history.
- **Enum y-axis labels** are numeric indices in v1 — readable from the chip
  legend, not yet drawn as named lanes.

## File layout

```
webapp/
  src/
    main.tsx                # React entry
    App.tsx                 # State coordinator + layout
    types.ts                # Wire-format and UI types
    viam-client.ts          # SDK wrapper: connect / dump / set / schema probe
    styles.css              # All styles (no framework)
    components/
      ConnectionBar.tsx     # Top: status, host, resource, poll rate
      ConnectionDialog.tsx  # Initial / re-auth modal
      VariablePanel.tsx     # Left: search + flat/tree
      VariableRow.tsx       # Draggable variable row
      PlotsArea.tsx         # Stack of plots
      Plot.tsx              # Single uPlot + drop target
      TunablesBar.tsx       # Bottom bar
      TunableEditor.tsx     # Per-type editor
    lib/
      ringbuffer.ts         # Fixed-capacity sample store
      schema.ts             # Flatten / value coercion helpers
```
