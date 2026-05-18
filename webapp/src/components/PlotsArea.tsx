import { useMemo, useState } from "react";

import type { PathInfo, PlotPanel } from "../types";
import type { RingBuffer } from "../lib/ringbuffer";
import {
  type ExportFormat,
  defaultFilename,
  downloadBlob,
  exportCsv,
  exportMat,
  exportMcap,
} from "../lib/export";
import { ExportDialog } from "./ExportDialog";
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
  xOverride: [number, number] | null;
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
  onZoomIn: () => void;
  onZoomOut: () => void;
  onPanLeft: () => void;
  onPanRight: () => void;
  onResetZoom: () => void;
  onPanByMs: (deltaMs: number) => void;
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
  xOverride,
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
  onZoomIn,
  onZoomOut,
  onPanLeft,
  onPanRight,
  onResetZoom,
  onPanByMs,
}: Props) {
  const pathsByFull = useMemo(
    () => new Map(paths.map((p) => [p.fullPath, p])),
    [paths],
  );

  const plottedPaths = useMemo(() => {
    const set = new Set<string>();
    for (const p of plots) for (const s of p.series) set.add(s);
    return Array.from(set);
  }, [plots]);

  const totalSamples = useMemo(() => {
    let n = 0;
    for (const buf of buffers.values()) n += buf.length;
    return n;
  }, [buffers, tick]);

  const [showExport, setShowExport] = useState(false);
  const canExport = paths.length > 0 && totalSamples > 0;

  const handleExport = async ({
    format,
    scope,
  }: {
    format: ExportFormat;
    scope: "all" | "plotted";
  }) => {
    const include =
      scope === "plotted" ? new Set(plottedPaths) : new Set(paths.map((p) => p.fullPath));
    const series = [];
    for (const path of include) {
      const buf = buffers.get(path);
      if (!buf || buf.length === 0) continue;
      const [xs, ys] = buf.snapshot();
      series.push({ path, xs, ys });
    }
    if (series.length === 0) {
      throw new Error("nothing to export — no buffered samples for the selected scope");
    }
    let blob: Blob;
    let ext: string;
    if (format === "csv") {
      blob = exportCsv(series);
      ext = "csv";
    } else if (format === "mcap") {
      blob = await exportMcap(series);
      ext = "mcap";
    } else if (format === "mat") {
      blob = exportMat(series);
      ext = "mat";
    } else {
      throw new Error(`unsupported format: ${format}`);
    }
    downloadBlob(blob, defaultFilename(ext));
    setShowExport(false);
  };

  return (
    <div className="plots-region">
      <PlotsToolbar
        paused={paused}
        onPauseToggle={onPauseToggle}
        onStepBackward={onStepBackward}
        onStepForward={onStepForward}
        onAddPlot={onAddPlot}
        onZoomIn={onZoomIn}
        onZoomOut={onZoomOut}
        onPanLeft={onPanLeft}
        onPanRight={onPanRight}
        onResetZoom={onResetZoom}
        columns={columns}
        onColumnsChange={onColumnsChange}
        hasPlots={plots.length > 0}
        keyframeCount={keyframes.length}
        canAddKeyframe={paused && scrubTs !== null}
        canNavKeyframe={paused && keyframes.length > 0}
        onAddKeyframe={onAddKeyframe}
        onPrevKeyframe={onPrevKeyframe}
        onNextKeyframe={onNextKeyframe}
        onExport={() => setShowExport(true)}
        canExport={canExport}
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
            keyframes={keyframes}
            xOverride={xOverride}
            onRemove={() => onRemovePlot(plot.id)}
            onAddSeries={(p) => onAddSeries(plot.id, p)}
            onRemoveSeries={(p) => onRemoveSeries(plot.id, p)}
            onScrubTo={onScrubTo}
            onStepForward={onStepForward}
            onStepBackward={onStepBackward}
            onUpdate={(patch) => onUpdatePlot(plot.id, patch)}
            onMultiDrop={(paths) => onMultiDrop(plot.id, paths)}
            onPanByMs={onPanByMs}
          />
        ))}
        {plots.length === 0 && (
          <div className="plots-empty">
            No plots yet. Click <b>+ plot</b> in the toolbar above, then drag
            variables from the left sidebar onto the plot.
          </div>
        )}
      </div>
      {showExport && (
        <ExportDialog
          allPaths={paths.map((p) => p.fullPath)}
          plottedPaths={plottedPaths}
          sampleCount={totalSamples}
          onExport={handleExport}
          onCancel={() => setShowExport(false)}
        />
      )}
    </div>
  );
}
