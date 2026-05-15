import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ConnectionBar } from "./components/ConnectionBar";
import { ConnectionDialog } from "./components/ConnectionDialog";
import { PlotsArea } from "./components/PlotsArea";
import { TunablesBar } from "./components/TunablesBar";
import { VariablePanel } from "./components/VariablePanel";
import { RingBuffer } from "./lib/ringbuffer";
import { scalarToNumber } from "./lib/schema";
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
const BUFFER_CAPACITY = 4000; // ~3.3 min at 20 Hz

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
    };
  } catch {
    return { plots: [], treeExpanded: [], pollRateHz: 10, theme: "dark" };
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

  const [session, setSession] = useState<ConnectedSession | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>({
    state: "disconnected",
  });
  const [showDialog, setShowDialog] = useState<boolean>(!initial.connection);
  const [connection, setConnection] = useState<ConnectionConfig | undefined>(
    initial.connection,
  );

  const [search, setSearch] = useState<string>("");
  const [treeExpanded, setTreeExpanded] = useState<Set<string>>(
    new Set(initial.treeExpanded),
  );
  const [pollRateHz, setPollRateHz] = useState<number>(initial.pollRateHz);
  const [plots, setPlots] = useState<PlotPanel[]>(initial.plots);
  const [theme, setTheme] = useState<"dark" | "light">(initial.theme);

  // Apply theme to document root.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const [latest, setLatest] = useState<Record<string, Scalar>>({});
  const [tick, setTick] = useState(0); // bumped on each successful dump
  const [lastDumpAt, setLastDumpAt] = useState<number | null>(null);
  const [setErrors, setSetErrors] = useState<Record<string, string>>({});

  const buffersRef = useRef<Map<string, RingBuffer>>(new Map());

  // Persist layout on relevant changes.
  useEffect(() => {
    saveLayout({
      connection,
      plots,
      treeExpanded: Array.from(treeExpanded),
      pollRateHz,
      theme,
    });
  }, [connection, plots, treeExpanded, pollRateHz, theme]);

  // Manage ring buffers: create on first sight of a path, never delete (they
  // hold history that may still be referenced by plot series).
  const ensureBuffers = useCallback((paths: PathInfo[]) => {
    const bufs = buffersRef.current;
    for (const p of paths) {
      if (!bufs.has(p.fullPath)) {
        bufs.set(p.fullPath, new RingBuffer(BUFFER_CAPACITY));
      }
    }
  }, []);

  // Connection lifecycle.
  const handleConnect = useCallback(async (cfg: ConnectionConfig) => {
    setStatus({ state: "connecting" });
    setConnection(cfg);
    setShowDialog(false);
    try {
      const sess = await connect(cfg);
      buffersRef.current.clear();
      for (const p of sess.paths) {
        buffersRef.current.set(p.fullPath, new RingBuffer(BUFFER_CAPACITY));
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
  }, []);

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

  // Polling loop. Restarts when session or rate changes.
  useEffect(() => {
    if (!session) return;
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
            buf = new RingBuffer(BUFFER_CAPACITY);
            bufs.set(k, buf);
          }
          buf.push(ts, scalarToNumber(v, metaByPath.get(k)));
          nKeys += 1;
        }
        if (nKeys === 0) {
          // Surface this as an error: connection works but vt.dump returned
          // nothing — usually means we're talking to a non-vt resource or
          // an aggregator with no live deps.
          // eslint-disable-next-line no-console
          console.warn("vt.dump returned 0 keys", values);
        }
        setLatest(values);
        setTick((t) => t + 1);
        setLastDumpAt(ts);
        if (status.state === "error") setStatus({ state: "connected" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error("vt.dump failed", err);
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
  }, [session, pollRateHz]);

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
      />
      <div className="main">
        <VariablePanel
          paths={session?.paths ?? []}
          pathsBySource={pathsBySource}
          search={search}
          onSearchChange={setSearch}
          treeExpanded={treeExpanded}
          onTreeExpandedChange={setTreeExpanded}
          latest={latest}
        />
        <PlotsArea
          plots={plots}
          buffers={buffersRef.current}
          paths={session?.paths ?? []}
          tick={tick}
          onAddPlot={addPlot}
          onRemovePlot={removePlot}
          onAddSeries={addSeries}
          onRemoveSeries={removeSeries}
        />
      </div>
      <TunablesBar
        tunables={tunables}
        latest={latest}
        errors={setErrors}
        onSet={handleSet}
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
    </div>
  );
}
