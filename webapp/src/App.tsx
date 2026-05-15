import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ConnectionBar } from "./components/ConnectionBar";
import { ConnectionDialog } from "./components/ConnectionDialog";
import { DropModeDialog } from "./components/DropModeDialog";
import { PlotsArea } from "./components/PlotsArea";
import { TunablesBar } from "./components/TunablesBar";
import { VariablePanel } from "./components/VariablePanel";
import { RingBuffer } from "./lib/ringbuffer";
import { scalarToNumber } from "./lib/schema";
import { tryViamAppContext } from "./lib/viam-context";
import type {
  ConnectionConfig,
  ConnectionStatus,
  PathInfo,
  PersistedLayout,
  PlotPanel,
  Scalar,
} from "./types";
import {
  type ConnectedSession,
  connect,
  disconnect,
  dump,
  setValue,
} from "./viam-client";

const LS_KEY = "variable-tools-scope:layout";
const DEFAULT_WINDOW_SEC = 30;
const DEFAULT_COLUMNS = 1;
const DEFAULT_SIDEBAR_WIDTH = 280;
const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 600;

function loadLayout(): PersistedLayout {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) throw new Error("none");
    const parsed = JSON.parse(raw) as PersistedLayout;
    return {
      plots: parsed.plots ?? [],
      treeExpanded: parsed.treeExpanded ?? [],
      pollRateHz: parsed.pollRateHz ?? 10,
      connection: parsed.connection,
      theme: parsed.theme ?? "dark",
      windowSec: parsed.windowSec ?? DEFAULT_WINDOW_SEC,
      columns: parsed.columns ?? DEFAULT_COLUMNS,
      sidebarWidth: parsed.sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH,
      pinnedTunables: parsed.pinnedTunables ?? [],
    };
  } catch {
    return {
      plots: [],
      treeExpanded: [],
      pollRateHz: 10,
      theme: "dark",
      windowSec: DEFAULT_WINDOW_SEC,
      columns: DEFAULT_COLUMNS,
      sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
      pinnedTunables: [],
    };
  }
}

function saveLayout(layout: PersistedLayout): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(layout));
  } catch {
    // ignore quota errors
  }
}

let plotIdCounter = 0;
function newPlotId(): string {
  plotIdCounter += 1;
  return `p${Date.now().toString(36)}${plotIdCounter}`;
}

export function App() {
  const initial = useMemo(loadLayout, []);
  // Embed context wins over localStorage so that opening the scope from
  // a different Viam-app machine swaps in the right credentials without
  // the user having to clear localStorage.
  const embedConnection = useMemo(tryViamAppContext, []);
  const initialConnection = embedConnection ?? initial.connection;

  const [session, setSession] = useState<ConnectedSession | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>({
    state: "disconnected",
  });
  const [showDialog, setShowDialog] = useState<boolean>(!initialConnection);
  const [connection, setConnection] = useState<ConnectionConfig | undefined>(
    initialConnection,
  );

  const [search, setSearch] = useState<string>("");
  const [treeExpanded, setTreeExpanded] = useState<Set<string>>(
    new Set(initial.treeExpanded),
  );
  const [pollRateHz, setPollRateHz] = useState<number>(initial.pollRateHz);
  const [plots, setPlots] = useState<PlotPanel[]>(initial.plots);
  const [theme, setTheme] = useState<"dark" | "light">(initial.theme);
  const [windowSec, setWindowSec] = useState<number>(initial.windowSec);
  const [columns, setColumns] = useState<number>(initial.columns);
  const [sidebarWidth, setSidebarWidth] = useState<number>(initial.sidebarWidth);
  const [pinnedTunables, setPinnedTunables] = useState<string[]>(
    initial.pinnedTunables,
  );
  const [paused, setPaused] = useState<boolean>(false);
  /** Persistent scrub-point timestamp (ms). Only meaningful when paused. */
  const [scrubTs, setScrubTs] = useState<number | null>(null);
  /** Saved keyframe timestamps (ms). Session-only. */
  const [keyframes, setKeyframes] = useState<number[]>([]);
  /** Pending multi-drop awaiting user choice. */
  const [pendingDrop, setPendingDrop] = useState<{
    targetPlotId: string;
    paths: string[];
  } | null>(null);
  /** User-driven x-axis range override (seconds, uPlot's time-scale unit).
   * null means auto-fit to data. Lives in App so the polling loop can
   * pan it when the scrub crosses the edge of view. */
  const [xOverride, setXOverride] = useState<[number, number] | null>(null);

  // Apply theme to document root.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const [latest, setLatest] = useState<Record<string, Scalar>>({});
  const [tick, setTick] = useState(0);
  const [lastDumpAt, setLastDumpAt] = useState<number | null>(null);
  const [setErrors, setSetErrors] = useState<Record<string, string>>({});

  const buffersRef = useRef<Map<string, RingBuffer>>(new Map());

  // Persist layout.
  useEffect(() => {
    saveLayout({
      connection,
      plots,
      treeExpanded: Array.from(treeExpanded),
      pollRateHz,
      theme,
      windowSec,
      columns,
      sidebarWidth,
      pinnedTunables,
    });
  }, [connection, plots, treeExpanded, pollRateHz, theme, windowSec, columns, sidebarWidth, pinnedTunables]);

  const pinTunable = useCallback((path: string) => {
    setPinnedTunables((cur) => (cur.includes(path) ? cur : [...cur, path]));
  }, []);
  const unpinTunable = useCallback((path: string) => {
    setPinnedTunables((cur) => cur.filter((p) => p !== path));
  }, []);

  // Apply window changes to all existing buffers.
  useEffect(() => {
    for (const buf of buffersRef.current.values()) {
      buf.setWindow(windowSec * 1000);
    }
  }, [windowSec]);

  const ensureBuffers = useCallback(
    (paths: PathInfo[]) => {
      const bufs = buffersRef.current;
      for (const p of paths) {
        if (!bufs.has(p.fullPath)) {
          bufs.set(p.fullPath, new RingBuffer(windowSec * 1000));
        }
      }
    },
    [windowSec],
  );

  const handleConnect = useCallback(
    async (cfg: ConnectionConfig) => {
      setStatus({ state: "connecting" });
      setConnection(cfg);
      setShowDialog(false);
      try {
        const sess = await connect(cfg);
        buffersRef.current.clear();
        for (const p of sess.paths) {
          buffersRef.current.set(p.fullPath, new RingBuffer(windowSec * 1000));
        }
        setSession(sess);
        setStatus({ state: "connected" });
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : String(err ?? "unknown error");
        setStatus({ state: "error", message });
        setSession(null);
        setShowDialog(true);
      }
    },
    [windowSec],
  );

  const handleDisconnect = useCallback(() => {
    disconnect(session);
    setSession(null);
    setStatus({ state: "disconnected" });
  }, [session]);

  // Auto-connect on mount if we have saved credentials.
  useEffect(() => {
    if (connection && status.state === "disconnected") {
      void handleConnect(connection);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Polling loop. Restarts when session/rate changes. Skips when paused.
  useEffect(() => {
    if (!session || paused) return;
    let cancelled = false;
    let inFlight = false;
    const intervalMs = Math.max(20, Math.round(1000 / pollRateHz));
    const metaByPath = new Map(session.paths.map((p) => [p.fullPath, p.meta]));

    const tickFn = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const values = await dump(session);
        if (cancelled) return;
        const ts = Date.now();
        const bufs = buffersRef.current;
        let nKeys = 0;
        for (const [k, v] of Object.entries(values)) {
          let buf = bufs.get(k);
          if (!buf) {
            buf = new RingBuffer(windowSec * 1000);
            bufs.set(k, buf);
          }
          buf.push(ts, scalarToNumber(v, metaByPath.get(k)));
          nKeys += 1;
        }
        if (nKeys === 0) {
          // eslint-disable-next-line no-console
          console.warn("get_readings returned 0 keys", values);
        }
        setLatest(values);
        setTick((t) => t + 1);
        setLastDumpAt(ts);
        if (status.state === "error") setStatus({ state: "connected" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error("get_readings failed", err);
        setStatus({ state: "error", message: msg });
      } finally {
        inFlight = false;
      }
    };

    const id = setInterval(() => void tickFn(), intervalMs);
    void tickFn();
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [session, pollRateHz, paused, windowSec, status.state]);

  // Variable-panel data.
  const pathsBySource = useMemo(() => {
    const m = new Map<string, PathInfo[]>();
    if (!session) return m;
    for (const p of session.paths) {
      const list = m.get(p.source) ?? [];
      list.push(p);
      m.set(p.source, list);
    }
    return m;
  }, [session]);

  useEffect(() => {
    if (session) ensureBuffers(session.paths);
  }, [session, ensureBuffers]);

  // Plot management.
  const addPlot = useCallback(() => {
    setPlots((p) => [...p, { id: newPlotId(), series: [] }]);
  }, []);
  const removePlot = useCallback((id: string) => {
    setPlots((p) => p.filter((x) => x.id !== id));
  }, []);
  const addSeries = useCallback((plotId: string, path: string) => {
    setPlots((p) =>
      p.map((x) =>
        x.id === plotId && !x.series.includes(path)
          ? { ...x, series: [...x.series, path] }
          : x,
      ),
    );
  }, []);
  const removeSeries = useCallback((plotId: string, path: string) => {
    setPlots((p) =>
      p.map((x) =>
        x.id === plotId
          ? { ...x, series: x.series.filter((s) => s !== path) }
          : x,
      ),
    );
  }, []);

  // Pause / resume / scrub.
  const togglePause = useCallback(() => {
    setPaused((p) => {
      const next = !p;
      if (next) {
        // Initialize scrub at latest sample timestamp.
        setScrubTs(lastDumpAt);
      } else {
        setScrubTs(null);
      }
      return next;
    });
  }, [lastDumpAt]);

  const stepMs = Math.max(1, Math.round(1000 / pollRateHz));

  /** Get the [oldest, newest] timestamps across all buffers, for clamping. */
  const scrubBounds = useCallback((): [number, number] | null => {
    let oldest = Infinity;
    let newest = -Infinity;
    for (const buf of buffersRef.current.values()) {
      const [xs] = buf.snapshot();
      if (xs.length === 0) continue;
      if (xs[0] < oldest) oldest = xs[0];
      if (xs[xs.length - 1] > newest) newest = xs[xs.length - 1];
    }
    if (!Number.isFinite(oldest) || !Number.isFinite(newest)) return null;
    return [oldest, newest];
  }, []);

  const scrubTo = useCallback(
    (ts: number) => {
      const bounds = scrubBounds();
      if (!bounds) return;
      const [lo, hi] = bounds;
      setScrubTs(Math.max(lo, Math.min(hi, ts)));
    },
    [scrubBounds],
  );

  /** Auto-fit data range, in seconds. */
  const autoRange = useCallback((): [number, number] | null => {
    const b = scrubBounds();
    if (!b) return null;
    return [b[0] / 1000, b[1] / 1000];
  }, [scrubBounds]);

  const currentRange = useCallback((): [number, number] | null => {
    return xOverride ?? autoRange();
  }, [xOverride, autoRange]);

  const scrubBy = useCallback(
    (deltaMs: number) => {
      setScrubTs((cur) => {
        if (cur === null) return cur;
        const bounds = scrubBounds();
        if (!bounds) return cur;
        const [lo, hi] = bounds;
        const next = Math.max(lo, Math.min(hi, cur + deltaMs));
        // Edge auto-pan: if scrub left visible range, shift xOverride to
        // keep scrub on screen.
        const r = currentRange();
        if (r) {
          const [vLoSec, vHiSec] = r;
          const vLo = vLoSec * 1000;
          const vHi = vHiSec * 1000;
          if (next > vHi) {
            const overshoot = next - vHi;
            setXOverride([(vLo + overshoot) / 1000, (vHi + overshoot) / 1000]);
          } else if (next < vLo) {
            const undershoot = vLo - next;
            setXOverride([(vLo - undershoot) / 1000, (vHi - undershoot) / 1000]);
          }
        }
        return next;
      });
    },
    [scrubBounds, currentRange],
  );

  const stepForward = useCallback(() => scrubBy(stepMs), [scrubBy, stepMs]);
  const stepBackward = useCallback(() => scrubBy(-stepMs), [scrubBy, stepMs]);

  // Zoom / pan on the x-axis. All ops update xOverride.
  const zoomIn = useCallback(() => {
    const r = currentRange();
    if (!r) return;
    const [lo, hi] = r;
    const center = paused && scrubTs !== null ? scrubTs / 1000 : (lo + hi) / 2;
    const q = (hi - lo) / 4;
    setXOverride([center - q, center + q]);
  }, [currentRange, paused, scrubTs]);

  const zoomOut = useCallback(() => {
    const r = currentRange();
    if (!r) return;
    const [lo, hi] = r;
    const center = paused && scrubTs !== null ? scrubTs / 1000 : (lo + hi) / 2;
    const span = hi - lo;
    let newSpan = span * 2;
    // Clamp to the buffer window — there's no data past that anyway.
    if (newSpan > windowSec) newSpan = windowSec;
    setXOverride([center - newSpan / 2, center + newSpan / 2]);
  }, [currentRange, paused, scrubTs, windowSec]);

  const panLeft = useCallback(() => {
    const r = currentRange();
    if (!r) return;
    const [lo, hi] = r;
    const shift = (hi - lo) / 4;
    setXOverride([lo - shift, hi - shift]);
  }, [currentRange]);

  const panRight = useCallback(() => {
    const r = currentRange();
    if (!r) return;
    const [lo, hi] = r;
    const shift = (hi - lo) / 4;
    setXOverride([lo + shift, hi + shift]);
  }, [currentRange]);

  const resetZoom = useCallback(() => setXOverride(null), []);

  /** Pan the visible window by an absolute time delta (ms). Negative
   * shifts the view left (earlier times). Used by middle-click drag. */
  const panByMs = useCallback(
    (deltaMs: number) => {
      const r = currentRange();
      if (!r) return;
      const dSec = deltaMs / 1000;
      setXOverride([r[0] + dSec, r[1] + dSec]);
    },
    [currentRange],
  );

  // Keyframes: add at current scrub position, navigate to nearest prev/next.
  const addKeyframe = useCallback(() => {
    if (scrubTs === null) return;
    setKeyframes((kfs) => {
      if (kfs.includes(scrubTs)) return kfs;
      return [...kfs, scrubTs].sort((a, b) => a - b);
    });
  }, [scrubTs]);

  const prevKeyframe = useCallback(() => {
    if (keyframes.length === 0) return;
    const cur = scrubTs;
    let target: number | null = null;
    for (const kf of keyframes) {
      if (cur === null || kf < cur) target = kf;
    }
    if (target === null) target = keyframes[keyframes.length - 1];
    setScrubTs(target);
  }, [keyframes, scrubTs]);

  const nextKeyframe = useCallback(() => {
    if (keyframes.length === 0) return;
    const cur = scrubTs;
    for (const kf of keyframes) {
      if (cur === null || kf > cur) {
        setScrubTs(kf);
        return;
      }
    }
    // Wrap to first.
    setScrubTs(keyframes[0]);
  }, [keyframes, scrubTs]);

  const updatePlot = useCallback(
    (id: string, patch: Partial<PlotPanel>) => {
      setPlots((p) =>
        p.map((x) => (x.id === id ? { ...x, ...patch } : x)),
      );
    },
    [],
  );

  /** Handle a drop of multiple paths onto a plot. If only one plot exists,
   * stack everything in there (no point asking). Otherwise, surface the
   * spread-mode picker. */
  const handleMultiDrop = useCallback(
    (targetPlotId: string, paths: string[]) => {
      if (plots.length <= 1 || paths.length <= 1) {
        setPlots((ps) =>
          ps.map((x) => {
            if (x.id !== targetPlotId) return x;
            const set = new Set(x.series);
            for (const p of paths) set.add(p);
            return { ...x, series: Array.from(set) };
          }),
        );
        return;
      }
      setPendingDrop({ targetPlotId, paths });
    },
    [plots.length],
  );

  /** Apply a chosen spread mode to the pending drop, then dismiss. */
  const applyDrop = useCallback(
    (mode: "single" | "spread-h" | "spread-v") => {
      if (!pendingDrop) return;
      const { targetPlotId, paths } = pendingDrop;
      const targetIdx = plots.findIndex((p) => p.id === targetPlotId);
      if (targetIdx < 0) {
        setPendingDrop(null);
        return;
      }

      // Build the order in which we'll visit plots, starting from target.
      let order: number[];
      if (mode === "single") {
        order = [targetIdx];
      } else if (mode === "spread-h") {
        // Row-major (the natural CSS-grid fill order).
        order = plots.map((_, i) => i);
      } else {
        // Column-major reordering for spread-v.
        const rows = Math.ceil(plots.length / columns);
        const reorder: number[] = [];
        for (let c = 0; c < columns; c++) {
          for (let r = 0; r < rows; r++) {
            const idx = r * columns + c;
            if (idx < plots.length) reorder.push(idx);
          }
        }
        order = reorder;
      }

      // Rotate so we start at target.
      const targetPosInOrder = order.indexOf(targetIdx);
      if (targetPosInOrder > 0) {
        order = [
          ...order.slice(targetPosInOrder),
          ...order.slice(0, targetPosInOrder),
        ];
      }

      // Distribute paths across order, wrapping if more paths than plots.
      const perPlot = new Map<string, string[]>();
      paths.forEach((path, i) => {
        const plotIdx = order[i % order.length];
        const id = plots[plotIdx].id;
        const list = perPlot.get(id) ?? [];
        list.push(path);
        perPlot.set(id, list);
      });

      setPlots((ps) =>
        ps.map((x) => {
          const additions = perPlot.get(x.id);
          if (!additions) return x;
          const set = new Set(x.series);
          for (const p of additions) set.add(p);
          return { ...x, series: Array.from(set) };
        }),
      );
      setPendingDrop(null);
    },
    [pendingDrop, plots, columns],
  );

  /** Values shown in the sidebar: latest when playing, scrub-lookup when
   * paused. Tunables always show latest (the actual current value). */
  const displayValues = useMemo(() => {
    if (!paused || scrubTs === null) return latest;
    const out: Record<string, Scalar> = {};
    for (const [path, buf] of buffersRef.current.entries()) {
      const v = buf.valueAt(scrubTs);
      if (v !== undefined) out[path] = v;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest, paused, scrubTs, tick]);

  // Tunable set with optimistic local update.
  const handleSet = useCallback(
    async (info: PathInfo, value: Scalar) => {
      if (!session) return;
      setSetErrors((e) => {
        const { [info.fullPath]: _, ...rest } = e;
        return rest;
      });
      const prev = latest[info.fullPath];
      setLatest((l) => ({ ...l, [info.fullPath]: value }));
      try {
        const resp = await setValue(session, info, value);
        if (!resp.ok) {
          setSetErrors((e) => ({
            ...e,
            [info.fullPath]: resp.error ?? "set failed",
          }));
          if (prev !== undefined) {
            setLatest((l) => ({ ...l, [info.fullPath]: prev }));
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setSetErrors((e) => ({ ...e, [info.fullPath]: msg }));
        if (prev !== undefined) {
          setLatest((l) => ({ ...l, [info.fullPath]: prev }));
        }
      }
    },
    [session, latest],
  );

  const tunables = useMemo(
    () => (session ? session.paths.filter((p) => p.meta.tunable) : []),
    [session],
  );

  return (
    <div className="app">
      <ConnectionBar
        status={status}
        host={connection?.host}
        resource={connection?.resource}
        mode={session?.mode}
        pollRateHz={pollRateHz}
        onPollRateChange={setPollRateHz}
        onEditConnection={() => setShowDialog(true)}
        onDisconnect={handleDisconnect}
        theme={theme}
        onThemeToggle={() => setTheme(theme === "dark" ? "light" : "dark")}
        tickCount={tick}
        latestKeys={Object.keys(latest).length}
        pathCount={session?.paths.length ?? 0}
        lastDumpAt={lastDumpAt}
        windowSec={windowSec}
        onWindowSecChange={setWindowSec}
        paused={paused}
      />
      <div
        className="main"
        style={{ gridTemplateColumns: `${sidebarWidth}px 1fr` }}
      >
        <VariablePanel
          paths={session?.paths ?? []}
          pathsBySource={pathsBySource}
          search={search}
          onSearchChange={setSearch}
          treeExpanded={treeExpanded}
          onTreeExpandedChange={setTreeExpanded}
          latest={displayValues}
          width={sidebarWidth}
          onWidthChange={(w) =>
            setSidebarWidth(Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, w)))
          }
          onSet={handleSet}
        />
        <PlotsArea
          plots={plots}
          buffers={buffersRef.current}
          paths={session?.paths ?? []}
          tick={tick}
          paused={paused}
          scrubTs={scrubTs}
          columns={columns}
          keyframes={keyframes}
          xOverride={xOverride}
          onColumnsChange={setColumns}
          onPauseToggle={togglePause}
          onStepForward={stepForward}
          onStepBackward={stepBackward}
          onScrubTo={scrubTo}
          onAddKeyframe={addKeyframe}
          onPrevKeyframe={prevKeyframe}
          onNextKeyframe={nextKeyframe}
          onAddPlot={addPlot}
          onRemovePlot={removePlot}
          onUpdatePlot={updatePlot}
          onAddSeries={addSeries}
          onRemoveSeries={removeSeries}
          onMultiDrop={handleMultiDrop}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          onPanLeft={panLeft}
          onPanRight={panRight}
          onResetZoom={resetZoom}
          onPanByMs={panByMs}
        />
      </div>
      <TunablesBar
        allTunables={tunables}
        pinned={pinnedTunables}
        latest={latest}
        errors={setErrors}
        onSet={handleSet}
        onAdd={pinTunable}
        onRemove={unpinTunable}
        disabled={!session}
      />
      {showDialog && (
        <ConnectionDialog
          initial={connection}
          onConnect={handleConnect}
          onCancel={
            session
              ? () => setShowDialog(false)
              : undefined /* can't cancel from initial */
          }
          errorMessage={
            status.state === "error" ? status.message : undefined
          }
        />
      )}
      {pendingDrop && (
        <DropModeDialog
          pathCount={pendingDrop.paths.length}
          plotCount={plots.length}
          columns={columns}
          onChoose={applyDrop}
          onCancel={() => setPendingDrop(null)}
        />
      )}
    </div>
  );
}
