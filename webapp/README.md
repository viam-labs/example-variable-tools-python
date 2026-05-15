# variable-tools scope

An SCS-inspired browser scope for inspecting, plotting, and tuning
`variable_tools` registries exposed by any Viam module.

## What it does

- **Connects** to any Viam machine running a sensor that responds to
  `getReadings` (and, optionally, the `vt.schema` / `vt.schema_all`
  DoCommand verbs for typed schema info). Auto-detects whether the target
  is an aggregator (fan-out across deps) or a single sensor (direct).
- **Variable panel (left).** Hierarchical tree, search box, multi-select
  via `shift`/`ctrl`-click, draggable to plots and the tunables area.
  Live values inline; for tunable variables you can **click the value to
  edit it inline** (number input for double/integer with min/max from the
  schema, dropdown for enum/boolean — Enter commits, Esc cancels). The
  panel itself is **resizable** (drag the right edge).
- **Plot grid (center).** Drag any variable onto a plot to time-series
  it. Multi-select lets you drop several at once: a small dialog asks
  whether to stack into a single plot, spread one-per-plot
  left-to-right, or top-to-bottom across the column-major layout.
  Configurable **column count (1–4)**. Per-plot **double-click** opens
  a settings dialog: optional title, **Shared / Independent y-axis**
  segmented control. Each plot shows live values in colored chips below
  the canvas, and start/end timestamps with millisecond precision in
  the bottom corners. ⚙ and × buttons float in the top-right of each
  plot canvas.
- **Toolbar above the plots.** `+ plot`, `⏸ Pause / ▶ Resume`,
  `◀ ▶ step`, `◆+ / ◀◆ / ◆▶ keyframes` (count badge), `🔍+ / 🔍−`
  zoom, `◁ ▷` pan, `⟲` reset, `Cols` selector. Pause and step only
  scrub when paused; zoom/pan affect the shared x range across all
  plots.
- **Pause + scrub.** Paused state freezes the polling loop, draws a
  scrub line in every plot synced to the same timestamp, and reflects
  that timestamp's value in every chip and in the left sidebar's live
  values. Scrub interactions:
  - **Click + drag** anywhere on a plot canvas: continuous scrub.
  - **Wheel** over a plot: step one sample per notch (down = forward).
  - **Step buttons**: advance/retreat by `1 / pollRateHz` seconds.
  - **Edge auto-pan**: scrubbing past the visible-range edge slides the
    window so the scrub line stays on screen.
- **Middle-click drag**: pan the visible x range. Works whether playing
  or paused.
- **Keyframes.** When paused, `◆+` saves the current scrub position; the
  saved keyframes render as dashed yellow vertical lines (distinct from
  the solid accent scrub line) in every plot. `◀◆` / `◆▶` jump between
  them, wrapping. Session-only state.
- **Pinned tunables (bottom).** Empty by default — drag tunable variables
  in to expose editor widgets at the bottom. Multi-drag works; non-tunable
  items in a multi-drop are silently ignored. Editors are type-aware
  (number with min/max, enum dropdown, boolean dropdown — boolean is a
  dropdown rather than a click-toggle so triggers like
  `trajectory.start` need explicit confirmation). Pinned list persists
  to localStorage. Header shows "(N of M)" so you can tell there are
  more available.
- **Light / dark theme** toggle (☀/☾) in the connection bar. Persisted.
- **Layout persistence.** Connection config, plot list (with their
  series + Y-axis mode + title), tree expansion, poll rate, window
  duration, columns, theme, sidebar width, and pinned tunables — all
  persisted to `localStorage`. Refresh keeps your setup.
- **Buffer window** (top bar): 10 s / 30 s / 1 min / 5 min / 15 min.
  Sample storage prunes older samples by age.
- **Connection-bar diagnostics**: `polls: N • values: M/P • last: Xms ago`
  is the quickest way to verify data is flowing, separate from any
  rendering issue. If `values: 0/N`, the `getReadings` call is empty —
  usually means you're connected to a non-`vt.*` resource.

## Running locally

```sh
cd webapp
npm install
npm run dev        # → http://localhost:5173
```

First load shows a connection dialog. Fill in:

- **Machine address** — the `*.viam.cloud` FQDN for the machine. For the
  demo module deployed to `variable-tools-9000` in this workspace:
  `variable-tools-9000-main.pgn074cus0.viam.cloud`.
- **API key id + key** — create one on app.viam.com under Settings → API
  Keys if you don't have one. Read access to the machine is enough for
  inspection; for `vt.set` (tuning) you need write.
- **Resource name** — usually the aggregator (`vt-aggregator`). If your
  machine doesn't run an aggregator, point this at a single sensor and
  pick "Direct sensor" in the Mode dropdown.

Credentials persist to `localStorage` — clear it through devtools to
force the dialog back on next load.

## How it talks to the machine

The webapp uses `@viamrobotics/sdk` over WebRTC, dialed through Viam's
signaling at `app.viam.com:443`. STUN servers are populated automatically.
The same auth and addressing works against any machine in any Viam org
you have access to.

For each poll:

1. Calls **`Sensor.getReadings()`** on the configured resource. (Earlier
   versions used `do_command({"command": "vt.dump"})`, which works for
   single sensors but returned `{}` against the aggregator pre-0.0.3 —
   `getReadings` works uniformly because the aggregator's
   `get_readings` does the fan-out.)
2. Appends `(timestamp_ms, value)` to a per-path **time-windowed buffer**
   (prunes by age based on the Window setting).
3. Bumps a tick counter; plots redraw against their subscribed buffers.

On connect (and any time you reconnect):

1. Probes `vt.schema_all` for aggregator mode, falls back to `vt.schema`
   for direct mode. The schema tree drives the variable panel and the
   tunable list.
2. Flattens to dotted-path keys matching the wire format of `getReadings`.

## Plotting non-numeric values

The wire format includes booleans and enums. uPlot is numeric, so:

- **Booleans** plot as 0 / 1.
- **Enums** plot as the index into their `cases` list. The chip shows the
  current case name; the y-axis shows the numeric index.
- **Doubles / Integers** plot natively in their own units.

If you mix variables with very different magnitudes (e.g. a counter
alongside a unit-range double), set the plot's Y-axis mode to
**Independent** in the settings dialog. Each series gets its own
auto-scaled scale; precise values stay readable in the chips.

## Tuning at runtime

Two ways to set values:

1. **Inline in the sidebar.** Click any tunable value to start editing.
   Number input for doubles/integers (with min/max from the schema),
   dropdown for enum/boolean. Enter commits, Esc cancels.
2. **Pinned tunables area** at the bottom. Drag tunables in; each gets a
   sticky editor. Useful for the few knobs you tweak repeatedly.

Both paths issue `vt.set` against the right resource:

- **Aggregator mode:** `vt.set` is sent to the aggregator with the full
  prefixed path (e.g. `vt-demo.controller.pid.kp`); the aggregator
  splits off the prefix and routes to the owning dep.
- **Direct mode:** `vt.set` is sent to the sensor with the local path
  (e.g. `controller.pid.kp`).

The UI does an optimistic local update on submit; if the server returns
`{"ok": false, "error": ...}` (e.g. `out_of_range` or
`invalid_enum_case`), the previous value is restored and the error is
shown inline on the editor until the next successful set.

## Limitations

- **Polling, not streaming.** Variables mutating inside the host module
  faster than the poll rate are aliased. Bumping past ~20 Hz starts
  dropping samples in practice over WebRTC. For diagnostics this is
  plenty; control-loop scrubbing would need a streaming verb.
- **Boolean trigger bounce.** Variables used as momentary triggers (like
  `trajectory.start`) flip to true, the loop processes them, then resets
  to false within one tick. The webapp briefly shows true. Use the
  trajectory's `state` enum as the authoritative readout.
- **No persisted ring buffer.** Refresh wipes plotted history (the
  layout persists, but in-memory samples don't).
- **Enum y-axis labels are numeric indices**, not named lanes. The chip
  legend has the case names; lane labels are a follow-up.
- **No 3D scene.** See `../3DVizNotes.md` for the design space and the
  rationale for not adding it yet (`@viamrobotics/motion-tools` is
  available but Svelte; the React/Svelte trade-off is documented
  there).

## File layout

```
webapp/
  src/
    main.tsx                 # React entry
    App.tsx                  # State coordinator: connection, polling, scrub, zoom, plots, pinned tunables
    types.ts                 # Wire-format + UI types incl. PersistedLayout
    viam-client.ts           # SDK wrapper: connect / getReadings dump / vt.set / schema probe
    styles.css               # All styles (no framework)
    components/
      ConnectionBar.tsx      # Top: status, host, polls/values, window, poll, theme
      ConnectionDialog.tsx   # Initial / re-auth modal
      VariablePanel.tsx      # Left: search + tree + multi-select; resize handle
      VariableRow.tsx        # Tree row; inline-editable tunable
      PlotsArea.tsx          # Toolbar wrapper + grid
      PlotsToolbar.tsx       # + plot, pause/step, kf, zoom/pan, reset, columns
      Plot.tsx               # uPlot mount + scrub + kf + time corners + chips below
      PlotSettingsDialog.tsx # Title + Y-axis Shared/Independent
      DropModeDialog.tsx     # Single / Spread-H / Spread-V picker
      TunablesBar.tsx        # Pinned tunables drop area
      TunableEditor.tsx      # Per-type editor widget
    lib/
      ringbuffer.ts          # TimeWindowBuffer — age-based pruning
      schema.ts              # Flatten + scalar-display formatting (precision arg)
```

## Tips and gotchas

- **Diagnostic readout in the connection bar** is the first thing to
  check when something seems off. `polls: 0` → polling never started.
  `values: 0/N` → connection works but `getReadings` is empty (likely
  wrong resource). `last: > 1s ago` → polling is hung or rate is too
  slow.
- **Scrub line jumps** to the click position when paused. To get the
  exact value at a peak, click on the peak.
- **Per-plot ⚙ gear** opens settings without needing to double-click;
  same dialog. ⚙ and × overlay buttons appear on hover (or when
  dragging variables in).
- **Open browser devtools** to see the first `[get_readings raw response]`
  log per session — useful when wire-format differences cause empty
  values.
- **`Sensor.getReadings` is the data path,** not `vt.dump`. The
  aggregator's `do_command` does also handle `vt.dump` as of 0.0.3 if
  you're querying via DoCommand instead.

## Theming

Two themes (`dark` / `light`) controlled by the ☀/☾ button in the
connection bar. Both palettes use CSS custom properties under
`[data-theme="dark"]` and `[data-theme="light"]` selectors. Add or tweak
them in `src/styles.css` if you want to brand the scope.
