# 3D Viz Integration Notes

Notes on whether/how to add the Viam 3D scene viewer to the variable-tools
scope webapp, with sync to the existing pause/scrub/keyframe model.

Primary source: <https://viamrobotics.github.io/visualization/>

---

## What's available

- **Package:** `@viamrobotics/motion-tools` on npm. Currently `1.26.1`,
  ~3 MB unpacked, actively maintained (~weekly releases).
- **Built on:** three.js (via `three-mesh-bvh`), `@bufbuild/protobuf`,
  `@connectrpc/connect-web`, Svelte 5 (component lib), `koota`, etc.
- **Apache 2.0** licensed.
- **Maintained by Viam** — same team that ships the renderer in the
  Viam app, so visual parity for free.

### Two operating modes

| Mode | Component | Input | Use case |
|---|---|---|---|
| Live | `<Visualizer partID="...">` | binds to a Viam machine part | shows whatever the machine is publishing right now via `world_state_store` |
| Snapshot | `<Visualizer> ... <Snapshot data={proto} /> ...` | a serialized scene proto | renders arbitrary world state, no live machine, no network — pure client-side |

The `<Snapshot>` component **re-binds on prop change**. That's exactly
what scrubbing needs: bind the closest snapshot from the buffer when the
user moves the scrub line.

### Geometry coverage

All the primitives the existing modules emit:
boxes, spheres, capsules, points, meshes (PLY), point clouds (PCD),
plus drawings, transforms with parent-frame composition, colors,
opacities, axes helpers. We don't have to reimplement any of this —
significantly different from a from-scratch three.js renderer.

---

## Effort to integrate

| Phase | Time | Outcome |
|---|---|---|
| **v1: Live-only 3D pane** | 3–5 days | Mount `<Visualizer partID="…"/>` in a toggleable pane. Always shows the live scene; no scrub sync. |
| **v2: Scrub sync (snapshot buffer)** | +5–7 days | Subscribe to `WorldStateStoreClient` ourselves; build snapshot protos client-side from accumulated stream events; ring-buffer them by timestamp; bind the closest snapshot to `<Snapshot>` when paused. |
| **Total full feature** | **~2 weeks** | 2D graphs and 3D scene scrubbing in lockstep. |

---

## Pros (of using motion-tools)

- **Don't reinvent the renderer.** Geometry types, mesh loading, PCD parsing, frame composition — all done. Visual parity with the Viam app.
- **Snapshot model fits scrubbing perfectly.** Re-binding `<Snapshot>` is the explicit API, not a hack on top of a streaming-only viewer.
- **Maintained.** Updates with the Viam app; you're not stuck owning a fork of three.js scene code.
- **Apache-licensed**, no friction.
- **All the proto schemas ship in the package** via `@bufbuild/protobuf` so client-side snapshot construction is at least possible (vs. needing a separate Go server).

## Cons / risks

- **Svelte 5 component, not React.** Our webapp is React. Mountable, but each `<Visualizer>` instance needs a manual mount/unmount in a `useEffect`. Adapter is small (~50–100 lines, half a day to prototype) but it's a permanent friction point.
- **Bundle size jumps a lot.** Current webapp is ~140 KB gzipped. motion-tools is ~3 MB unpacked → likely 800 KB+ gzipped. ~6× the bundle. Mitigation: lazy-load behind a "show 3D" toggle so it's only paid when used.
- **Snapshot proto construction client-side is unverified.** Docs imply Go is the canonical way (`MarshalBinary` / `MarshalJSON`). For scrub-sync we need to construct snapshots in JS from stream events. The schema ships with `@bufbuild/protobuf` so it should be possible — but spike it before committing. Call it a 1-day risk-buy at the start of v2.
- **State accumulation logic.** Building a world model from `ADDED`/`REMOVED`/`UPDATED` events into a snapshot is its own state machine. Small but easy to get wrong; expect a couple of bugs on first pass.
- **Memory grows with scene complexity.** ~30 KB/snapshot × 300 snapshots in a 30 s window @ 10 Hz = ~9 MB. Fine for typical scenes; tighten the snapshot rate (e.g. every 200 ms instead of every poll) if needed.

---

## Svelte vs React — should we migrate the webapp?

The webapp is React + Vite + uPlot today. motion-tools is Svelte 5.

### Why "yes if 3D":

- **No Svelte-in-React adapter** — `<Visualizer>` and `<Snapshot>` drop in natively. Removes the worst friction point of the 3D plan, forever.
- **Bundle math reverses.** If you adopt motion-tools, the Svelte runtime is *already in your bundle* (motion-tools brings it). Staying on React means you pay React (~45 KB gzipped) on top, for nothing extra. Svelte rewrite saves that ~45 KB.
- **Reactivity fits this app well.** Svelte 5 runes (`$state`, `$derived`, `$effect`) suit a polling-driven, fine-grained UI — less boilerplate than React's `useCallback` / `useMemo` / dep-array dance. The chip-value updates and scrub propagation in particular are cleaner in Svelte.
- **Per-property updates.** Svelte updates surgical DOM properties; React re-runs whole components. For 50+ chips updating at 10 Hz, slightly snappier and less GC pressure.

### Why "no" if no 3D:

- **Rewrite cost.** ~1500 lines across ~12 files. Realistic rewrite: 3–5 days of focused work.
- **Risk to working features.** Pause/scrub/keyframes/cursor sync took multiple iterations to nail — particularly the uPlot ownership bug. Re-implementing under a new framework risks similar subtle regressions.
- **Lost time.** Days spent learning React patterns for *this* app evaporate.
- **No concrete payoff** without motion-tools in the picture.

### Hybrid (React shell + Svelte 3D pane only)

Actively avoid. Two state models, two reactivity systems, in the same app. Worst of both worlds.

### Migration breakdown if we do it

- **Stays mostly intact:** `viam-client.ts`, `lib/ringbuffer.ts`, `lib/schema.ts` — these barely change.
- **Mechanical:** most components are direct rewrites; layout + props translate cleanly.
- **Biggest single chunk:** `Plot.tsx`. uPlot lifecycle has different idioms in Svelte (mount on `onMount`, set data on a derived store) but the shape is the same.

---

## Decision matrix

| Plan | Recommendation |
|---|---|
| **Probably going to do 3D in the next month or two** | Rewrite to Svelte 5 *now*, before adding more features. Cheaper to migrate at 1500 lines than at 3000. Then build 3D as a native motion-tools integration. |
| **3D is "maybe someday"** | Stay in React. Don't pre-pay for a feature you might never want. |
| **3D is definitely not happening** | Stay in React. Don't migrate. |

---

## When you might want 3D

3D is mostly load-bearing for **spatial reasoning**: arm IK, collision
avoidance, AprilTag pose verification, motion planning trajectories,
end-effector reach checks. The kinds of debugging where "is that
geometry where I think it is in the world frame" matters.

For PID tuning, signal monitoring, scalar/bool/enum control-loop
introspection — the 2D scope already captures everything. The chip
values + sidebar give precise numeric introspection. 3D would be
satisfying but isn't load-bearing for that work.

A reasonable trigger to start the 3D phase: when you have a specific
spatial-debugging task that demands it, or when you want to demo the
webapp at the same time as a 3D-driven module like `apriltag-tracker`
or `example-visualizations-python`.

---

## What we ruled out

- **iframe of the Viam app's 3D view.** Quick (~30 min) but no scrub sync; iframe is independent live view. CSP/X-Frame-Options likely block it anyway. Worth a 10-minute test if quick spatial context (without sync) is enough.
- **Custom three.js renderer from scratch.** Was the assumed path before discovering motion-tools is published. Now strictly worse — ~2 weeks of work to reach feature parity with what motion-tools gives for free.
- **Wait for upstream to publish.** Already published. (`@viamrobotics/motion-tools`.)
