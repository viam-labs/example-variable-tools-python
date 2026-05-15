import { useCallback, useMemo, useState } from "react";

import type { PathInfo, PlotPanel } from "../types";
import type { RingBuffer } from "../lib/ringbuffer";
import { Plot } from "./Plot";
import { PlotsToolbar } from "./PlotsToolbar";

interface Props {
  plots: PlotPanel[];
  buffers: Map<string, RingBuffer>;
  paths: PathInfo[];
  tick: number;
  paused: boolean;
  scrubTs: number | null;
  columns: number;
  keyframes: number[];
  onColumnsChange: (n: number) => void;
  onPauseToggle: () => void;
  onStepForward: () => void;
  onStepBackward: () => void;
  onScrubTo: (ts: number) => void;
  onAddKeyframe: () => void;
  onPrevKeyframe: () => void;
  onNextKeyframe: () => void;
  onAddPlot: () => void;
  onRemovePlot: (id: string) => void;
  onUpdatePlot: (id: string, patch: Partial<PlotPanel>) => void;
  onAddSeries: (plotId: string, path: string) => void;
  onRemoveSeries: (plotId: string, path: string) => void;
  onMultiDrop: (targetPlotId: string, paths: string[]) => void;
}

/** X-axis range in seconds (uPlot's time-scale unit). null means auto-fit. */
type XRange = [number, number] | null;

function deriveAutoRange(buffers: Map<string, RingBuffer>): XRange {
  let lo = Infinity;
  let hi = -Infinity;
  for (const buf of buffers.values()) {
    if (buf.length === 0) continue;
    const [xs] = buf.snapshot();
    if (xs[0] < lo) lo = xs[0];
    if (xs[xs.length - 1] > hi) hi = xs[xs.length - 1];
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  return [lo / 1000, hi / 1000];
}

export function PlotsArea({
  plots,
  buffers,
  paths,
  tick,
  paused,
  scrubTs,
  columns,
  keyframes,
  onColumnsChange,
  onPauseToggle,
  onStepForward,
  onStepBackward,
  onScrubTo,
  onAddKeyframe,
  onPrevKeyframe,
  onNextKeyframe,
  onAddPlot,
  onRemovePlot,
  onUpdatePlot,
  onAddSeries,
  onRemoveSeries,
  onMultiDrop,
}: Props) {
  const pathsByFull = useMemo(
    () => new Map(paths.map((p) => [p.fullPath, p])),
    [paths],
  );

  const [xOverride, setXOverride] = useState<XRange>(null);

  const currentRange = useCallback((): [number, number] | null => {
    if (xOverride) return xOverride;
    return deriveAutoRange(buffers);
  }, [xOverride, buffers]);

  const zoomIn = useCallback(() => {
    const r = currentRange();
    if (!r) return;
    const [lo, hi] = r;
    const c = (lo + hi) / 2;
    const q = (hi - lo) / 4;
    setXOverride([c - q, c + q]);
  }, [currentRange]);

  const zoomOut = useCallback(() => {
    const r = currentRange();
    if (!r) return;
    const [lo, hi] = r;
    const c = (lo + hi) / 2;
    const span = hi - lo;
    setXOverride([c - span, c + span]);
  }, [currentRange]);

  const panLeft = useCallback(() => {
    const r = currentRange();
    if (!r) return;
    const [lo, hi] = r;
    const span = hi - lo;
    const shift = span / 4;
    setXOverride([lo - shift, hi - shift]);
  }, [currentRange]);

  const panRight = useCallback(() => {
    const r = currentRange();
    if (!r) return;
    const [lo, hi] = r;
    const span = hi - lo;
    const shift = span / 4;
    setXOverride([lo + shift, hi + shift]);
  }, [currentRange]);

  const resetZoom = useCallback(() => setXOverride(null), []);

  return (
    <div className="plots-region">
      <PlotsToolbar
        paused={paused}
        onPauseToggle={onPauseToggle}
        onStepBackward={onStepBackward}
        onStepForward={onStepForward}
        onAddPlot={onAddPlot}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onPanLeft={panLeft}
        onPanRight={panRight}
        onResetZoom={resetZoom}
        columns={columns}
        onColumnsChange={onColumnsChange}
        hasPlots={plots.length > 0}
        keyframeCount={keyframes.length}
        canAddKeyframe={paused && scrubTs !== null}
        canNavKeyframe={paused && keyframes.length > 0}
        onAddKeyframe={onAddKeyframe}
        onPrevKeyframe={onPrevKeyframe}
        onNextKeyframe={onNextKeyframe}
      />
      <div
        className="plots"
        style={{
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        }}
      >
        {plots.map((plot) => (
          <Plot
            key={plot.id}
            plot={plot}
            buffers={buffers}
            pathsByFull={pathsByFull}
            tick={tick}
            paused={paused}
            scrubTs={scrubTs}
            xOverride={xOverride}
            onRemove={() => onRemovePlot(plot.id)}
            onAddSeries={(p) => onAddSeries(plot.id, p)}
            onRemoveSeries={(p) => onRemoveSeries(plot.id, p)}
            onScrubTo={onScrubTo}
            onStepForward={onStepForward}
            onStepBackward={onStepBackward}
            onUpdate={(patch) => onUpdatePlot(plot.id, patch)}
            onMultiDrop={(paths) => onMultiDrop(plot.id, paths)}
          />
        ))}
        {plots.length === 0 && (
          <div className="plots-empty">
            No plots yet. Click <b>+ plot</b> in the toolbar above, then drag
            variables from the left sidebar onto the plot.
          </div>
        )}
      </div>
    </div>
  );
}
