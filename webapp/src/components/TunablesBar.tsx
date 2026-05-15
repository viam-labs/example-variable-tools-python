import { useState } from "react";

import type { PathInfo, Scalar } from "../types";
import { TunableEditor } from "./TunableEditor";

interface Props {
  /** All available tunables in the schema (used to look up metadata for
   * pinned paths). */
  allTunables: PathInfo[];
  /** Paths the user has pinned to the tunables area. */
  pinned: string[];
  latest: Record<string, Scalar>;
  errors: Record<string, string>;
  onSet: (info: PathInfo, value: Scalar) => void;
  onAdd: (path: string) => void;
  onRemove: (path: string) => void;
  disabled: boolean;
}

export function TunablesBar({
  allTunables,
  pinned,
  latest,
  errors,
  onSet,
  onAdd,
  onRemove,
  disabled,
}: Props) {
  const [over, setOver] = useState(false);
  const tunableByPath = new Map(allTunables.map((p) => [p.fullPath, p]));
  const pinnedInfos = pinned
    .map((p) => tunableByPath.get(p))
    .filter((p): p is PathInfo => !!p);

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
        if (Array.isArray(parsed)) {
          paths = parsed.filter((p) => typeof p === "string");
        }
      } catch {
        // fall through
      }
    }
    if (paths.length === 0) {
      const single = e.dataTransfer.getData("text/vt-path");
      if (single) paths = [single];
    }
    // Filter to tunable-only — silently drop non-tunable selections.
    for (const p of paths) {
      if (tunableByPath.has(p)) onAdd(p);
    }
  };

  return (
    <div
      className={`tunables${over ? " over" : ""}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <h4>
        Tunables ({pinnedInfos.length}
        {pinnedInfos.length !== allTunables.length && (
          <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>
            {" "}
            of {allTunables.length}
          </span>
        )}
        )
      </h4>
      {pinnedInfos.length === 0 ? (
        <div className="tunables-empty">
          drag tunable variables here to expose their editors
        </div>
      ) : (
        <div className="row">
          {pinnedInfos.map((t) => (
            <div className="pinned-tunable" key={t.fullPath}>
              <TunableEditor
                info={t}
                currentValue={latest[t.fullPath]}
                error={errors[t.fullPath]}
                disabled={disabled}
                onSet={onSet}
              />
              <button
                className="ghost"
                onClick={() => onRemove(t.fullPath)}
                title="Unpin"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
