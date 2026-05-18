import { useState } from "react";

import type { ExportFormat } from "../lib/export";

interface Props {
  /** All available variable paths (the schema's flat key list). */
  allPaths: string[];
  /** Subset of paths actually plotted (across all plots). */
  plottedPaths: string[];
  /** Buffer counts per path — to surface "X paths, Y total samples" hints. */
  sampleCount: number;
  onExport: (opts: {
    format: ExportFormat;
    scope: "all" | "plotted";
  }) => void | Promise<void>;
  onCancel: () => void;
}

const FORMATS: Array<{
  value: ExportFormat;
  label: string;
  hint: string;
}> = [
  {
    value: "csv",
    label: "CSV",
    hint: "Wide table — timestamp + one column per variable. Universal; opens in Excel, pandas, MATLAB's readtable.",
  },
  {
    value: "mcap",
    label: "MCAP",
    hint: "Robotics log format. One channel per variable, JSON messages. Open in Foxglove or any MCAP-aware tool.",
  },
  {
    value: "mat",
    label: "MATLAB (.mat v5)",
    hint: "Native MATLAB binary. Loads as a struct with one field per variable plus timestamp_ms.",
  },
];

export function ExportDialog({
  allPaths,
  plottedPaths,
  sampleCount,
  onExport,
  onCancel,
}: Props) {
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [scope, setScope] = useState<"all" | "plotted">(
    plottedPaths.length > 0 ? "plotted" : "all",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onExport({ format, scope });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-overlay" onClick={busy ? undefined : onCancel}>
      <form
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2>Export buffered data</h2>
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
          {allPaths.length} variables in schema · {plottedPaths.length} on
          plots · {sampleCount} total samples currently buffered (limited by
          the Window setting).
        </span>

        <div className="field">
          <label>Scope</label>
          <div className="segmented">
            <button
              type="button"
              className={scope === "plotted" ? "active" : ""}
              onClick={() => setScope("plotted")}
              disabled={plottedPaths.length === 0}
              title={
                plottedPaths.length === 0
                  ? "No variables on plots yet"
                  : `Export only the ${plottedPaths.length} plotted variables`
              }
            >
              Plotted only ({plottedPaths.length})
            </button>
            <button
              type="button"
              className={scope === "all" ? "active" : ""}
              onClick={() => setScope("all")}
            >
              All buffered ({allPaths.length})
            </button>
          </div>
        </div>

        <div className="field">
          <label>Format</label>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            {FORMATS.map((f) => (
              <label
                key={f.value}
                style={{
                  display: "flex",
                  gap: 8,
                  padding: "6px 8px",
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                  cursor: "pointer",
                  background: format === f.value ? "var(--accent-soft)" : "transparent",
                }}
              >
                <input
                  type="radio"
                  name="format"
                  value={f.value}
                  checked={format === f.value}
                  onChange={() => setFormat(f.value)}
                  style={{ marginTop: 2 }}
                />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 12 }}>{f.label}</div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--text-dim)",
                      marginTop: 2,
                    }}
                  >
                    {f.hint}
                  </div>
                </div>
              </label>
            ))}
          </div>
        </div>

        <div
          style={{ fontSize: 11, color: "var(--text-dim)" }}
        >
          Parquet is intentionally not yet supported here (would require
          shipping ~2 MB of Arrow + parquet-wasm in the bundle). CSV
          imports cleanly into pandas / DuckDB if you need columnar.
        </div>

        {error && <div className="error">{error}</div>}

        <div className="actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "Exporting…" : "Export"}
          </button>
        </div>
      </form>
    </div>
  );
}
