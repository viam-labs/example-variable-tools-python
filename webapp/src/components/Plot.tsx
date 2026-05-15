import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";

import type { PathInfo, PlotPanel } from "../types";
import type { RingBuffer } from "../lib/ringbuffer";

interface Props {
  plot: PlotPanel;
  buffers: Map<string, RingBuffer>;
  pathsByFull: Map<string, PathInfo>;
  tick: number;
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

function tsLabel(secs: number): string {
  const d = new Date(secs * 1000);
  return d.toLocaleTimeString("en-US", { hour12: false });
}

/** Build an uPlot AlignedData from a set of (xs, ys) snapshots, aligning
 * onto a unified x axis (the union of all timestamps). For each series,
 * the value at a given x is the most recent sample at-or-before x. */
function alignData(snapshots: Array<[number[], number[]] | undefined>): uPlot.AlignedData {
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

  // Build / rebuild uPlot whenever the series list changes. Immediately
  // populate from current buffer state so the user doesn't have to wait
  // for the next poll tick to see anything.
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
      cursor: { drag: { x: true, y: false }, points: { show: true } },
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
    };

    const initial = alignData(plot.series.map((p) => buffers.get(p)?.snapshot()));
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

  return (
    <div
      className={`plot${over ? " over" : ""}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="plot-header">
        <span className="title">{plot.title || `Plot`}</span>
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
          return (
            <span className="chip" key={path}>
              <span
                className="swatch"
                style={{ background: COLORS[i % COLORS.length] }}
              />
              <span>{path}</span>
              {info?.meta.units && (
                <span style={{ color: "var(--text-dim)", fontSize: 10 }}>
                  {info.meta.units}
                </span>
              )}
              <span className="rm" onClick={() => onRemoveSeries(path)} title="Remove">
                ×
              </span>
            </span>
          );
        })}
      </div>
      <div
        className="plot-canvas-wrap"
        style={{ position: "relative", height: CANVAS_HEIGHT, width: "100%", overflow: "hidden" }}
      >
        {/* uPlot owns this div — it must have no React-managed children, or
            React will remove uPlot's canvas elements on re-renders. */}
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
