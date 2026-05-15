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
  keyframes: number[];
  xOverride: [number, number] | null;
  onRemove: () => void;
  onAddSeries: (path: string) => void;
  onRemoveSeries: (path: string) => void;
  onScrubTo: (ts: number) => void;
  onStepForward: () => void;
  onStepBackward: () => void;
  onUpdate: (patch: Partial<PlotPanel>) => void;
  onMultiDrop: (paths: string[]) => void;
  onPanByMs: (deltaMs: number) => void;
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
  keyframes,
  xOverride,
  onRemove,
  onAddSeries,
  onRemoveSeries,
  onScrubTo,
  onStepForward,
  onStepBackward,
  onUpdate,
  onMultiDrop,
  onPanByMs,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const uplotRef = useRef<uPlot | null>(null);
  const [over, setOver] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const dragModeRef = useRef<"scrub" | "pan" | null>(null);
  const panLastXRef = useRef<number>(0);

  const yMode: "shared" | "independent" = plot.yMode ?? "shared";

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

  /** Offset (CSS px) of uPlot's plot area within our containerRef, plus the
   * plot area's CSS width. uPlot reserves left margin for the y-axis when
   * present, so the plot area is narrower than the container — using the
   * container as the basis for px↔value conversions silently shifts every
   * click and overlay by the y-axis width. Use ``u.over`` (the overlay
   * element positioned exactly at the plot area) as the source of truth. */
  const plotArea = (): { left: number; width: number } | null => {
    const u = uplotRef.current;
    const container = containerRef.current;
    if (!u || !container) return null;
    const overRect = u.over.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    return {
      left: overRect.left - containerRect.left,
      width: overRect.width,
    };
  };

  const posToTs = (clientX: number): number | null => {
    const u = uplotRef.current;
    if (!u) return null;
    const overRect = u.over.getBoundingClientRect();
    const left = clientX - overRect.left;
    const xVal = u.posToVal(left, "x");
    if (xVal == null || !Number.isFinite(xVal)) return null;
    return xVal * 1000;
  };

  // --- pointer interactions: left=drag-scrub (paused), middle=drag-pan (always) ---

  const onPointerDown = (e: React.PointerEvent) => {
    // Don't intercept presses that started on interactive overlay
    // children (gear / ×). Capturing the pointer here would redirect
    // the mouseup away from the button and the click would never fire.
    const target = e.target as HTMLElement;
    if (target.closest(".plot-overlay-buttons")) return;

    if (e.button === 0 && paused) {
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      dragModeRef.current = "scrub";
      const ts = posToTs(e.clientX);
      if (ts !== null) onScrubTo(ts);
    } else if (e.button === 1) {
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      dragModeRef.current = "pan";
      panLastXRef.current = e.clientX;
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const mode = dragModeRef.current;
    if (mode === "scrub") {
      const ts = posToTs(e.clientX);
      if (ts !== null) onScrubTo(ts);
    } else if (mode === "pan") {
      const dx = e.clientX - panLastXRef.current;
      panLastXRef.current = e.clientX;
      const u = uplotRef.current;
      if (!u) return;
      const sx = u.scales.x;
      if (sx.min == null || sx.max == null) return;
      const area = plotArea();
      if (!area || area.width === 0) return;
      const rangeMs = (sx.max - sx.min) * 1000;
      const dtMs = (dx / area.width) * rangeMs;
      // Drag right → view should follow content right → xMin decreases.
      onPanByMs(-dtMs);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (dragModeRef.current) {
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      dragModeRef.current = null;
    }
  };

  // Suppress middle-click auto-scroll cursor and the contextmenu on right-
  // click within the plot (we don't use right-click yet but it's confusing).
  const onAuxClick = (e: React.MouseEvent) => {
    if (e.button === 1) e.preventDefault();
  };

  // Wheel: when paused, step the scrub one sample per notch.
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

  // Compute pixel positions of scrub / keyframe lines, in container coords.
  // valToPos returns CSS pixels relative to the plot area's left edge — we
  // add the plot-area offset so the rendered line (positioned in our wrap
  // div) aligns with the plotted data.
  const pxFor = (tsMs: number): number | null => {
    const u = uplotRef.current;
    if (!u) return null;
    const xRel = u.valToPos(tsMs / 1000, "x", false);
    if (xRel == null || !Number.isFinite(xRel)) return null;
    const area = plotArea();
    if (!area) return null;
    if (xRel < 0 || xRel > area.width) return null;
    return area.left + xRel;
  };

  const scrubLeftPx = useMemo(() => {
    if (!paused || scrubTs === null) return null;
    return pxFor(scrubTs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused, scrubTs, xRange, tick, width]);

  const keyframePx = useMemo(() => {
    return keyframes
      .map((kf) => ({ ts: kf, px: pxFor(kf) }))
      .filter((k) => k.px !== null) as Array<{ ts: number; px: number }>;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyframes, xRange, tick, width]);

  const chipValue = (path: string): number | undefined => {
    const buf = buffers.get(path);
    if (!buf) return undefined;
    if (paused && scrubTs !== null) return buf.valueAt(scrubTs);
    return buf.last()?.value;
  };

  const onDragOver = (e: React.DragEvent) => {
    if (
      e.dataTransfer.types.includes("text/vt-path") ||
      e.dataTransfer.types.includes("text/vt-paths")
    ) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setOver(true);
    }
  };
  const onDragLeave = () => setOver(false);
  const onDrop = (e: React.DragEvent) => {
    setOver(false);
    let paths: string[] = [];
    const arrStr = e.dataTransfer.getData("text/vt-paths");
    if (arrStr) {
      try {
        const parsed = JSON.parse(arrStr);
        if (Array.isArray(parsed)) paths = parsed.filter((p) => typeof p === "string");
      } catch {
        // fall through
      }
    }
    if (paths.length === 0) {
      const single = e.dataTransfer.getData("text/vt-path");
      if (single) paths = [single];
    }
    if (paths.length === 0) return;
    if (paths.length === 1) {
      onAddSeries(paths[0]);
    } else {
      onMultiDrop(paths);
    }
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
      <div
        className="plot-canvas-wrap"
        ref={wrapRef}
        style={{
          position: "relative",
          height: CANVAS_HEIGHT,
          width: "100%",
          overflow: "hidden",
          cursor:
            dragModeRef.current === "pan"
              ? "grabbing"
              : paused
                ? "ew-resize"
                : "default",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onAuxClick={onAuxClick}
      >
        <div
          className="plot-canvas"
          ref={containerRef}
          style={{ height: "100%", width: "100%" }}
        />
        {plot.title && <div className="plot-title-overlay">{plot.title}</div>}
        <div className="plot-overlay-buttons">
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
          <button
            className="ghost"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            title="Remove plot"
          >
            ×
          </button>
        </div>
        {plot.series.length === 0 && (
          <div className="empty" style={{ position: "absolute", inset: 0 }}>
            empty
          </div>
        )}
        {keyframePx.map((k) => (
          <div
            key={k.ts}
            className="keyframe-line"
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: k.px,
              width: 0,
              borderLeft: "1px dashed var(--warn)",
              pointerEvents: "none",
            }}
          />
        ))}
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
        {xRange && (() => {
          const area = plotArea();
          if (!area) return null;
          return (
            <div
              className="time-corner-band"
              style={{
                position: "absolute",
                bottom: 2,
                left: area.left,
                width: area.width,
                pointerEvents: "none",
              }}
            >
              <div className="time-corner left">{startLabel}</div>
              <div className="time-corner right">{endLabel}</div>
              {scrubLabel && (
                <div className="time-corner center">{scrubLabel}</div>
              )}
            </div>
          );
        })()}
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
