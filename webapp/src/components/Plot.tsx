import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";

import type { PathInfo, PlotPanel } from "../types";
import type { RingBuffer } from "../lib/ringbuffer";
import { scalarToDisplay } from "../lib/schema";

interface Props {
  plot: PlotPanel;
  buffers: Map<string, RingBuffer>;
  pathsByFull: Map<string, PathInfo>;
  tick: number;
  paused: boolean;
  cursorTs: number | null;
  onCursorTsChange: (ts: number | null) => void;
  onRemove: () => void;
  onAddSeries: (path: string) => void;
  onRemoveSeries: (path: string) => void;
}

const COLORS = [
  "#58a6ff",
  "#3fb950",
  "#f0883e",
  "#bc8cff",
  "#d29922",
  "#ff7b72",
  "#79c0ff",
  "#56d364",
];

const CANVAS_HEIGHT = 220;
const CURSOR_SYNC_KEY = "vt-scope";

function tsLabel(secs: number): string {
  const d = new Date(secs * 1000);
  return d.toLocaleTimeString("en-US", { hour12: false });
}

/** Build an uPlot AlignedData from a set of (xs, ys) snapshots, aligning
 * onto a unified x axis. */
function alignData(
  snapshots: Array<[number[], number[]] | undefined>,
): uPlot.AlignedData {
  const xSet = new Set<number>();
  for (const s of snapshots) {
    if (!s) continue;
    for (const x of s[0]) xSet.add(x);
  }
  const xs = Array.from(xSet).sort((a, b) => a - b);
  const xsSec = xs.map((x) => x / 1000);
  const out: number[][] = [xsSec];
  for (const s of snapshots) {
    if (!s) {
      out.push(xs.map(() => NaN));
      continue;
    }
    const ys: number[] = new Array(xs.length);
    let idx = 0;
    let last = NaN;
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i];
      while (idx < s[0].length && s[0][idx] <= x) {
        last = s[1][idx];
        idx += 1;
      }
      ys[i] = last;
    }
    out.push(ys);
  }
  return out as unknown as uPlot.AlignedData;
}

export function Plot({
  plot,
  buffers,
  pathsByFull,
  tick,
  paused,
  cursorTs,
  onCursorTsChange,
  onRemove,
  onAddSeries,
  onRemoveSeries,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const uplotRef = useRef<uPlot | null>(null);
  const [over, setOver] = useState(false);

  const seriesSig = useMemo(() => plot.series.join("|"), [plot.series]);

  // Width tracking for responsive plot.
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Build / rebuild uPlot whenever the series list changes.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    uplotRef.current?.destroy();
    uplotRef.current = null;

    if (plot.series.length === 0 || width === 0) return;

    const accent = "#58a6ff";
    const grid = getCssVar("--border") || "#30363d";
    const stroke = getCssVar("--text-dim") || "#8b949e";

    const opts: uPlot.Options = {
      width,
      height: CANVAS_HEIGHT,
      pxAlign: false,
      cursor: {
        drag: { x: true, y: false, setScale: true },
        points: { show: true },
        sync: {
          key: CURSOR_SYNC_KEY,
          scales: ["x", null],
        },
      },
      scales: {
        x: { time: true },
        y: { auto: true },
      },
      axes: [
        {
          stroke,
          grid: { stroke: grid, width: 0.5 },
          ticks: { stroke: grid, width: 0.5 },
          values: (_u, vals) => vals.map(tsLabel),
        },
        {
          stroke,
          grid: { stroke: grid, width: 0.5 },
          ticks: { stroke: grid, width: 0.5 },
        },
      ],
      series: [
        {},
        ...plot.series.map((path, i) => ({
          label: path,
          stroke: COLORS[i % COLORS.length] ?? accent,
          width: 1.5,
          spanGaps: true,
        })),
      ],
      hooks: {
        setCursor: [
          (u) => {
            const left = u.cursor.left;
            if (left == null || left < 0) {
              onCursorTsChange(null);
              return;
            }
            const xVal = u.posToVal(left, "x");
            if (xVal != null && Number.isFinite(xVal)) {
              onCursorTsChange(xVal * 1000);
            } else {
              onCursorTsChange(null);
            }
          },
        ],
      },
    };

    const initial = alignData(
      plot.series.map((p) => buffers.get(p)?.snapshot()),
    );
    const u = new uPlot(opts, initial, el);
    uplotRef.current = u;

    return () => {
      u.destroy();
      uplotRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesSig, width]);

  // Push fresh data on every tick.
  useEffect(() => {
    const u = uplotRef.current;
    if (!u || plot.series.length === 0) return;
    const data = alignData(plot.series.map((p) => buffers.get(p)?.snapshot()));
    u.setData(data);
  }, [tick, seriesSig, plot.series, buffers]);

  const onDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("text/vt-path")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setOver(true);
    }
  };
  const onDragLeave = () => setOver(false);
  const onDrop = (e: React.DragEvent) => {
    const path = e.dataTransfer.getData("text/vt-path");
    setOver(false);
    if (path) onAddSeries(path);
  };

  const resetZoom = () => {
    const u = uplotRef.current;
    if (!u) return;
    u.setScale("x", { min: null as unknown as number, max: null as unknown as number });
    u.setScale("y", { min: null as unknown as number, max: null as unknown as number });
  };

  // Compute current chip values: at cursor when scrubbing, latest otherwise.
  const chipValue = (path: string): number | undefined => {
    const buf = buffers.get(path);
    if (!buf) return undefined;
    if (cursorTs !== null) return buf.valueAt(cursorTs);
    return buf.last()?.value;
  };

  const sampleCount = plot.series.reduce(
    (acc, p) => acc + (buffers.get(p)?.length ?? 0),
    0,
  );

  return (
    <div
      className={`plot${over ? " over" : ""}${paused ? " paused" : ""}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="plot-header">
        <span className="title">{plot.title || `Plot`}</span>
        {plot.series.length > 0 && (
          <span style={{ color: "var(--text-dim)", fontSize: 11 }}>
            {sampleCount} samples
          </span>
        )}
        <button
          onClick={resetZoom}
          title="Reset zoom (or double-click the plot)"
          disabled={plot.series.length === 0}
        >
          ⟲ zoom
        </button>
        <button className="danger" onClick={onRemove} title="Remove plot">
          ×
        </button>
      </div>
      <div className="plot-series">
        {plot.series.length === 0 && (
          <span style={{ color: "var(--text-dim)", fontSize: 11 }}>
            drag variables here to plot
          </span>
        )}
        {plot.series.map((path, i) => {
          const info = pathsByFull.get(path);
          const v = chipValue(path);
          const display =
            v === undefined
              ? "—"
              : Number.isFinite(v)
                ? scalarToDisplay(v, info?.meta)
                : "—";
          return (
            <span className="chip" key={path}>
              <span
                className="swatch"
                style={{ background: COLORS[i % COLORS.length] }}
              />
              <span className="chip-path">{path}</span>
              <span className="chip-value">{display}</span>
              {info?.meta.units && (
                <span style={{ color: "var(--text-dim)", fontSize: 10 }}>
                  {info.meta.units}
                </span>
              )}
              <span
                className="rm"
                onClick={() => onRemoveSeries(path)}
                title="Remove"
              >
                ×
              </span>
            </span>
          );
        })}
      </div>
      <div
        className="plot-canvas-wrap"
        style={{
          position: "relative",
          height: CANVAS_HEIGHT,
          width: "100%",
          overflow: "hidden",
        }}
      >
        {/* uPlot owns this div — it must have no React-managed children. */}
        <div
          className="plot-canvas"
          ref={containerRef}
          style={{ height: "100%", width: "100%" }}
        />
        {plot.series.length === 0 && (
          <div className="empty" style={{ position: "absolute", inset: 0 }}>
            empty
          </div>
        )}
      </div>
    </div>
  );
}

function getCssVar(name: string): string {
  if (typeof window === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
