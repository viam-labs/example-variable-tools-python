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

function tsToHHMMSS(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString();
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
  const canvasRef = useRef<HTMLDivElement>(null);
  const uplotRef = useRef<uPlot | null>(null);
  const [over, setOver] = useState(false);

  // Memoize series shape for uPlot config rebuilds.
  const seriesSig = useMemo(() => plot.series.join("|"), [plot.series]);

  // Rebuild uPlot whenever the series list changes or the container resizes.
  useEffect(() => {
    if (!canvasRef.current) return;
    const el = canvasRef.current;
    if (plot.series.length === 0) {
      uplotRef.current?.destroy();
      uplotRef.current = null;
      return;
    }
    const opts: uPlot.Options = {
      width: el.clientWidth || 600,
      height: el.clientHeight || 200,
      pxAlign: false,
      cursor: { drag: { x: true, y: false }, points: { show: true } },
      scales: {
        x: { time: true },
        y: { auto: true },
      },
      axes: [
        {
          stroke: "#8b949e",
          grid: { stroke: "#30363d22" },
          values: (_u, vals) => vals.map((v) => tsToHHMMSS(v * 1000)),
        },
        {
          stroke: "#8b949e",
          grid: { stroke: "#30363d22" },
        },
      ],
      series: [
        { label: "ts" },
        ...plot.series.map((path, i) => ({
          label: path,
          stroke: COLORS[i % COLORS.length],
          width: 1.5,
          spanGaps: false,
        })),
      ],
    };
    const data: uPlot.AlignedData = [[], ...plot.series.map(() => [])] as uPlot.AlignedData;
    uplotRef.current?.destroy();
    uplotRef.current = new uPlot(opts, data, el);

    const ro = new ResizeObserver(() => {
      uplotRef.current?.setSize({
        width: el.clientWidth,
        height: el.clientHeight,
      });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      uplotRef.current?.destroy();
      uplotRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesSig]);

  // Push new data every tick.
  useEffect(() => {
    if (!uplotRef.current || plot.series.length === 0) return;
    // Find a unified x-axis by intersecting / unioning the timestamps. uPlot
    // requires aligned data, so we union timestamps and emit each series'
    // value at each timestamp (interpolating with the most-recent-known).
    const snapshots = plot.series.map((p) => buffers.get(p)?.snapshot());
    // Collect all x's.
    const xSet = new Set<number>();
    for (const s of snapshots) {
      if (!s) continue;
      for (const x of s[0]) xSet.add(x);
    }
    const xs = Array.from(xSet).sort((a, b) => a - b).map((x) => x / 1000);
    const data: uPlot.AlignedData = [xs] as unknown as uPlot.AlignedData;
    for (const s of snapshots) {
      if (!s) {
        (data as unknown as number[][]).push(xs.map(() => NaN));
        continue;
      }
      const ys: number[] = [];
      let idx = 0;
      let last = NaN;
      for (const x of xs) {
        const xMs = x * 1000;
        while (idx < s[0].length && s[0][idx] <= xMs) {
          last = s[1][idx];
          idx += 1;
        }
        ys.push(last);
      }
      (data as unknown as number[][]).push(ys);
    }
    uplotRef.current.setData(data);
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
        <button className="danger" onClick={onRemove}>
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
              <span className="rm" onClick={() => onRemoveSeries(path)}>
                ×
              </span>
            </span>
          );
        })}
      </div>
      <div className="plot-canvas" ref={canvasRef}>
        {plot.series.length === 0 && <div className="empty">empty</div>}
      </div>
    </div>
  );
}
