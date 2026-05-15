interface Props {
  pathCount: number;
  plotCount: number;
  columns: number;
  onChoose: (mode: "single" | "spread-h" | "spread-v") => void;
  onCancel: () => void;
}

export function DropModeDialog({
  pathCount,
  plotCount,
  columns,
  onChoose,
  onCancel,
}: Props) {
  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <form
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => e.preventDefault()}
      >
        <h2>
          Drop {pathCount} variable{pathCount === 1 ? "" : "s"}
        </h2>
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
          You have {plotCount} plot{plotCount === 1 ? "" : "s"} in a {columns}-column grid.
        </span>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            marginTop: 6,
          }}
        >
          <button
            type="button"
            className="primary"
            style={{ textAlign: "left", padding: "8px 12px" }}
            onClick={() => onChoose("single")}
          >
            <b>Single plot</b>
            <div style={{ fontSize: 11, opacity: 0.9, marginTop: 2 }}>
              Stack all {pathCount} variables into the plot you dropped on.
            </div>
          </button>
          <button
            type="button"
            style={{ textAlign: "left", padding: "8px 12px" }}
            onClick={() => onChoose("spread-h")}
          >
            <b>Spread horizontally</b>
            <div
              style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}
            >
              One variable per plot, left-to-right then top-to-bottom.
              Wraps if more variables than plots.
            </div>
          </button>
          <button
            type="button"
            style={{ textAlign: "left", padding: "8px 12px" }}
            onClick={() => onChoose("spread-v")}
          >
            <b>Spread vertically</b>
            <div
              style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}
            >
              One variable per plot, top-to-bottom then left-to-right.
              Wraps if more variables than plots.
            </div>
          </button>
        </div>
        <div className="actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
