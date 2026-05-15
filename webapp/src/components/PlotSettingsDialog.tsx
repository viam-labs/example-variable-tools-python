import { useState } from "react";

import type { PlotPanel } from "../types";

interface Props {
  plot: PlotPanel;
  onSave: (patch: Partial<PlotPanel>) => void;
  onCancel: () => void;
}

export function PlotSettingsDialog({ plot, onSave, onCancel }: Props) {
  const [title, setTitle] = useState(plot.title ?? "");
  const [yMode, setYMode] = useState<"shared" | "independent">(
    plot.yMode ?? "shared",
  );

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({ title: title.trim() || undefined, yMode });
  };

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <form
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2>Plot settings</h2>
        <div className="field">
          <label htmlFor="title">Title (optional)</label>
          <input
            id="title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="leave blank for none"
            autoFocus
          />
        </div>
        <div className="field">
          <label>Y-axis scaling</label>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12,
              color: "var(--text)",
              padding: "4px 0",
            }}
          >
            <input
              type="radio"
              name="ymode"
              value="shared"
              checked={yMode === "shared"}
              onChange={() => setYMode("shared")}
            />
            <span>
              <b>Shared</b> — all variables on one auto-scaled y axis
            </span>
          </label>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12,
              color: "var(--text)",
              padding: "4px 0",
            }}
          >
            <input
              type="radio"
              name="ymode"
              value="independent"
              checked={yMode === "independent"}
              onChange={() => setYMode("independent")}
            />
            <span>
              <b>Independent</b> — each variable normalized to its own range
            </span>
          </label>
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
            Use independent when plotting variables with very different
            magnitudes (e.g. a counter alongside a unit-range double).
            Precise values stay readable in the chips at the bottom.
          </span>
        </div>
        <div className="actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
