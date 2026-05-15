import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";

import type { PathInfo, PlotPanel } from "../types";
import type { RingBuffer } from "../lib/ringbuffer";
import { scalarToDisplay } from "../lib/schema";
import { PlotSettingsDialog } from "./PlotSettingsDialog";

interface Props {
  plot: PlotPanel;
  buffers: Map<string, RingBuffer>;
  pathsByFull: Map<string, PathInfo>;
  tick: number;
  paused: boolean;
  scrubTs: number | null;
  xOverride: [number, number] | null;
  onRemove: () => void;
  onAddSeries: (path: string) => void;
  onRemoveSeries: (path: string) => void;
  onScrubTo: (ts: number) => void;
  onStepForward: () => void;
  onStepBackward: () => void;
  onUpdate: (patch: Partial<PlotPanel>) => void;
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

const CANVAS_HEIGHT = 160;
const CURSOR_SYNC_KEY = "vt-scope";
const CHIP_PRECISION = 4;

function timeLabel(secs: number): string {
  if (!Number.isFinite(secs)) return "";
  const d = new Date(secs * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

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
  scrubTs,
  xOverride,
  onRemove,
  onAddSeries,
  onRemoveSeries,
  onScrubTo,
  onStepForward,
  onStepBackward,
  onUpdate,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const uplotRef = useRef<uPlot | null>(null);
  const [over, setOver] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const yMode: "shared" | "independent" = plot.yMode ?? "shared";

  // Build signature includes yMode so changes rebuild uPlot.
  const buildSig = useMemo(
    () => `${plot.series.join("|")}__${yMode}`,
    [plot.series, yMode],
  );

  const [xRange, setXRange] = useState<[number, number] | null>(null);

  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Build / rebuild uPlot whenever series or yMode changes.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    uplotRef.current?.destroy();
    uplotRef.current = null;

    if (plot.series.length === 0 || width === 0) return;

    const accent = "#58a6ff";
    const grid = getCssVar("--border") || "#30363d";
    const stroke = getCssVar("--text-dim") || "#8b949e";

    const isIndep = yMode === "independent";

    const scales: uPlot.Options["scales"] = { x: { time: true } };
    if (isIndep) {
      plot.series.forEach((_p, i) => {
        scales[`y${i}`] = { auto: true };
      });
    } else {
      scales.y = { auto: true };
    }

    const opts: uPlot.Options = {
      width,
      height: CANVAS_HEIGHT,
      pxAlign: false,
      cursor: {
        // No crosshair, no hover dots — chips show values; scrub line is
        // the sole position indicator when paused.
        show: false,
        drag: { x: false, y: false, setScale: false },
        sync: {
          key: CURSOR_SYNC_KEY,
          scales: ["x", null],
        },
      },
      scales,
      axes: [
        {
          stroke,
          grid: { stroke: grid, width: 0.5 },
          ticks: { stroke: grid, width: 0.5 },
          values: () => [],
          size: 4,
        },
        // Y axis on the left only meaningful when shared.
        ...(isIndep
          ? []
          : [
              {
                stroke,
                grid: { stroke: grid, width: 0.5 },
                ticks: { stroke: grid, width: 0.5 },
                size: 38,
              } as uPlot.Axis,
            ]),
      ],
      series: [
        {},
        ...plot.series.map((path, i) => ({
          label: path,
          stroke: COLORS[i % COLORS.length] ?? accent,
          width: 1.5,
          spanGaps: true,
          ...(isIndep ? { scale: `y${i}` } : {}),
        })),
      ],
      hooks: {
        setScale: [
          (u) => {
            const sx = u.scales.x;
            if (sx.min != null && sx.max != null) {
              setXRange([sx.min, sx.max]);
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
  }, [buildSig, width]);

  useEffect(() => {
    const u = uplotRef.current;
    if (!u || plot.series.length === 0) return;
    const data = alignData(plot.series.map((p) => buffers.get(p)?.snapshot()));
    u.setData(data);
  }, [tick, buildSig, plot.series, buffers]);

  useEffect(() => {
    const u = uplotRef.current;
    if (!u) return;
    if (xOverride) {
      u.setScale("x", { min: xOverride[0], max: xOverride[1] });
    } else {
      const xs = u.data[0] as readonly number[];
      if (xs && xs.length > 0) {
        u.setScale("x", { min: xs[0], max: xs[xs.length - 1] });
      }
    }
  }, [xOverride]);

  const posToTs = (clientX: number): number | null => {
    const u = uplotRef.current;
    const el = containerRef.current;
    if (!u || !el) return null;
    const rect = el.getBoundingClientRect();
    const left = clientX - rect.left;
    const xVal = u.posToVal(left, "x");
    if (xVal == null || !Number.isFinite(xVal)) return null;
    return xVal * 1000;
  };

  const onClick = (e: React.MouseEvent) => {
    if (!paused) return;
    const ts = posToTs(e.clientX);
    if (ts !== null) onScrubTo(ts);
  };

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (!paused) return;
      e.preventDefault();
      if (e.deltaY > 0) onStepForward();
      else if (e.deltaY < 0) onStepBackward();
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [paused, onStepForward, onStepBackward]);

  const scrubLeftPx = useMemo(() => {
    if (!paused || scrubTs === null) return null;
    const u = uplotRef.current;
    if (!u) return null;
    const px = u.valToPos(scrubTs / 1000, "x", false);
    if (px == null || !Number.isFinite(px) || px < 0) return null;
    return px;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused, scrubTs, xRange, tick, width]);

  const chipValue = (path: string): number | undefined => {
    const buf = buffers.get(path);
    if (!buf) return undefined;
    if (paused && scrubTs !== null) return buf.valueAt(scrubTs);
    return buf.last()?.value;
  };

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

  const startLabel = xRange ? timeLabel(xRange[0]) : "";
  const endLabel = xRange ? timeLabel(xRange[1]) : "";
  const scrubLabel =
    paused && scrubTs !== null ? timeLabel(scrubTs / 1000) : "";

  return (
    <div
      className={`plot${over ? " over" : ""}${paused ? " paused" : ""}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDoubleClick={() => setShowSettings(true)}
    >
      <div className="plot-header">
        <span className="title">{plot.title ?? ""}</span>
        <button
          className="ghost"
          onClick={(e) => {
            e.stopPropagation();
            setShowSettings(true);
          }}
          title="Plot settings (or double-click the plot)"
        >
          ⚙
        </button>
        <button className="ghost" onClick={onRemove} title="Remove plot">
          ×
        </button>
      </div>
      <div
        className="plot-canvas-wrap"
        ref={wrapRef}
        style={{
          position: "relative",
          height: CANVAS_HEIGHT,
          width: "100%",
          overflow: "hidden",
          cursor: paused ? "ew-resize" : "default",
        }}
        onClick={onClick}
      >
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
        {scrubLeftPx !== null && (
          <div
            className="scrub-line"
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: scrubLeftPx,
              width: 0,
              borderLeft: "1.5px solid var(--accent)",
              pointerEvents: "none",
            }}
          />
        )}
        {xRange && (
          <>
            <div className="time-corner left">{startLabel}</div>
            <div className="time-corner right">{endLabel}</div>
            {scrubLabel && (
              <div className="time-corner center">{scrubLabel}</div>
            )}
          </>
        )}
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
                ? scalarToDisplay(v, info?.meta, CHIP_PRECISION)
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
      {showSettings && (
        <PlotSettingsDialog
          plot={plot}
          onSave={(patch) => {
            onUpdate(patch);
            setShowSettings(false);
          }}
          onCancel={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}

function getCssVar(name: string): string {
  if (typeof window === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
