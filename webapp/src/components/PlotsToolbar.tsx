interface Props {
  paused: boolean;
  onPauseToggle: () => void;
  onStepBackward: () => void;
  onStepForward: () => void;
  onAddPlot: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onPanLeft: () => void;
  onPanRight: () => void;
  onResetZoom: () => void;
  columns: number;
  onColumnsChange: (n: number) => void;
  hasPlots: boolean;
  keyframeCount: number;
  canAddKeyframe: boolean;
  canNavKeyframe: boolean;
  onAddKeyframe: () => void;
  onPrevKeyframe: () => void;
  onNextKeyframe: () => void;
  onExport: () => void;
  canExport: boolean;
  scrubTs: number | null;
  trimIn: number | null;
  trimOut: number | null;
  trimActive: boolean;
  onSetTrimIn: () => void;
  onSetTrimOut: () => void;
  onApplyTrim: () => void;
  onClearTrim: () => void;
}

const COLUMN_OPTIONS = [1, 2, 3, 4];

export function PlotsToolbar({
  paused,
  onPauseToggle,
  onStepBackward,
  onStepForward,
  onAddPlot,
  onZoomIn,
  onZoomOut,
  onPanLeft,
  onPanRight,
  onResetZoom,
  columns,
  onColumnsChange,
  hasPlots,
  keyframeCount,
  canAddKeyframe,
  canNavKeyframe,
  onAddKeyframe,
  onPrevKeyframe,
  onNextKeyframe,
  onExport,
  canExport,
  scrubTs,
  trimIn,
  trimOut,
  trimActive,
  onSetTrimIn,
  onSetTrimOut,
  onApplyTrim,
  onClearTrim,
}: Props) {
  const canSetMark = scrubTs !== null;
  const canApply =
    trimIn !== null && trimOut !== null && trimIn !== trimOut && !trimActive;
  return (
    <div className="plots-toolbar">
      <button onClick={onAddPlot} title="Add a new empty plot panel">
        + plot
      </button>

      <span className="sep" />

      <button
        onClick={onPauseToggle}
        className={paused ? "primary" : ""}
        title={paused ? "Resume polling" : "Pause polling and scrub"}
      >
        {paused ? "▶ Resume" : "⏸ Pause"}
      </button>
      <button
        onClick={onStepBackward}
        disabled={!paused}
        title="Step scrub one sample backward"
      >
        ◀
      </button>
      <button
        onClick={onStepForward}
        disabled={!paused}
        title="Step scrub one sample forward"
      >
        ▶
      </button>

      <span className="sep" />

      <button
        onClick={onAddKeyframe}
        disabled={!canAddKeyframe}
        title="Add a keyframe at the current scrub position"
      >
        ◆+
      </button>
      <button
        onClick={onPrevKeyframe}
        disabled={!canNavKeyframe}
        title="Jump to previous keyframe"
      >
        ◀◆
      </button>
      <button
        onClick={onNextKeyframe}
        disabled={!canNavKeyframe}
        title="Jump to next keyframe"
      >
        ◆▶
      </button>
      <span className="crumb" style={{ minWidth: 28 }}>
        {keyframeCount > 0 ? `(${keyframeCount})` : ""}
      </span>

      <span className="sep" />

      <button onClick={onZoomIn} disabled={!hasPlots} title="Zoom in (x)">
        🔍+
      </button>
      <button onClick={onZoomOut} disabled={!hasPlots} title="Zoom out (x)">
        🔍−
      </button>
      <button onClick={onPanLeft} disabled={!hasPlots} title="Pan left">
        ◁
      </button>
      <button onClick={onPanRight} disabled={!hasPlots} title="Pan right">
        ▷
      </button>
      <button onClick={onResetZoom} disabled={!hasPlots} title="Reset zoom (auto-fit)">
        ⟲
      </button>

      <span className="sep" />

      <label className="crumb">
        Cols:&nbsp;
        <select
          value={columns}
          onChange={(e) => onColumnsChange(Number(e.target.value))}
          title="Layout: number of columns"
        >
          {COLUMN_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>

      <span className="sep" />

      <button
        onClick={onSetTrimIn}
        disabled={!canSetMark}
        className={trimIn !== null ? "active" : ""}
        title="Set trim start at the current scrub position"
      >
        [ in
      </button>
      <button
        onClick={onSetTrimOut}
        disabled={!canSetMark}
        className={trimOut !== null ? "active" : ""}
        title="Set trim end at the current scrub position"
      >
        out ]
      </button>
      <button
        onClick={onApplyTrim}
        disabled={!canApply}
        className={trimActive ? "primary" : ""}
        title="Apply: lock plots and export to the in/out range"
      >
        ✂ Trim
      </button>
      <button
        onClick={onClearTrim}
        disabled={trimIn === null && trimOut === null && !trimActive}
        title="Clear trim markers and restore full view"
      >
        ↺
      </button>

      <span className="sep" />

      <button
        onClick={onExport}
        disabled={!canExport}
        title={
          trimActive
            ? "Export buffered data within the trim range (CSV / MCAP / MAT)"
            : "Export buffered data to CSV / MCAP / MAT"
        }
      >
        ⤓ Export
      </button>
    </div>
  );
}
