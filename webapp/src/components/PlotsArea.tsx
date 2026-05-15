import { useMemo } from "react";

import type { PathInfo, PlotPanel } from "../types";
import type { RingBuffer } from "../lib/ringbuffer";
import { Plot } from "./Plot";

interface Props {
  plots: PlotPanel[];
  buffers: Map<string, RingBuffer>;
  paths: PathInfo[];
  tick: number;
  onAddPlot: () => void;
  onRemovePlot: (id: string) => void;
  onAddSeries: (plotId: string, path: string) => void;
  onRemoveSeries: (plotId: string, path: string) => void;
}

export function PlotsArea({
  plots,
  buffers,
  paths,
  tick,
  onAddPlot,
  onRemovePlot,
  onAddSeries,
  onRemoveSeries,
}: Props) {
  const pathsByFull = useMemo(
    () => new Map(paths.map((p) => [p.fullPath, p])),
    [paths],
  );

  return (
    <div className="plots">
      {plots.map((plot) => (
        <Plot
          key={plot.id}
          plot={plot}
          buffers={buffers}
          pathsByFull={pathsByFull}
          tick={tick}
          onRemove={() => onRemovePlot(plot.id)}
          onAddSeries={(p) => onAddSeries(plot.id, p)}
          onRemoveSeries={(p) => onRemoveSeries(plot.id, p)}
        />
      ))}
      <button className="add-plot" onClick={onAddPlot}>
        + Add plot
      </button>
    </div>
  );
}
