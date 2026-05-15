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
          <label htmlFor="title">Title</label>
          <input
            id="title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="optional"
            autoFocus
          />
        </div>
        <div className="field">
          <label>Y-axis</label>
          <div className="segmented">
            <button
              type="button"
              className={yMode === "shared" ? "active" : ""}
              onClick={() => setYMode("shared")}
            >
              Shared
            </button>
            <button
              type="button"
              className={yMode === "independent" ? "active" : ""}
              onClick={() => setYMode("independent")}
            >
              Independent
            </button>
          </div>
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
