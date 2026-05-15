import { useState } from "react";

import type { PathInfo, Scalar } from "../types";
import { scalarToDisplay } from "../lib/schema";

interface Props {
  info: PathInfo;
  /** What to show as the label — full path in flat mode, just the var name
   * in tree mode where the tree itself shows the hierarchy. */
  label: string;
  liveValue?: Scalar;
  selected: boolean;
  onSelect: (path: string, e: React.MouseEvent) => void;
  /** All currently-selected paths — passed at drag time so dragging an
   * already-selected row carries the whole selection. */
  selectedPaths: ReadonlySet<string>;
  /** If provided AND the variable is tunable, clicking the value column
   * starts an inline edit (Enter commits, Escape cancels). */
  onSet?: (info: PathInfo, value: Scalar) => void;
}

export function VariableRow({
  info,
  label,
  liveValue,
  selected,
  onSelect,
  selectedPaths,
  onSet,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const onDragStart = (e: React.DragEvent) => {
    let paths: string[];
    if (selected && selectedPaths.size > 1) {
      paths = Array.from(selectedPaths);
    } else {
      paths = [info.fullPath];
    }
    e.dataTransfer.setData("text/vt-path", paths[0]);
    e.dataTransfer.setData("text/vt-paths", JSON.stringify(paths));
    e.dataTransfer.effectAllowed = "copy";
  };

  const startEdit = () => {
    if (!info.meta.tunable || !onSet) return;
    setDraft(liveValue !== undefined ? String(liveValue) : "");
    setEditing(true);
  };

  const commit = () => {
    if (!onSet) {
      setEditing(false);
      return;
    }
    if (info.meta.type === "double" || info.meta.type === "integer") {
      const n = Number(draft);
      if (Number.isFinite(n)) {
        onSet(info, info.meta.type === "integer" ? Math.trunc(n) : n);
      }
    } else if (info.meta.type === "enum") {
      onSet(info, draft);
    }
    setEditing(false);
  };

  const onValueClick = (e: React.MouseEvent) => {
    if (!info.meta.tunable || !onSet) return;
    e.stopPropagation();
    if (info.meta.type === "boolean") {
      // Toggle in place.
      onSet(info, !(liveValue === true));
    } else {
      startEdit();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setEditing(false);
    }
  };

  const renderValue = () => {
    if (editing) {
      if (info.meta.type === "enum") {
        return (
          <select
            className="live edit"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={commit}
            onClick={(e) => e.stopPropagation()}
          >
            {info.meta.cases?.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        );
      }
      return (
        <input
          className="live edit"
          type="number"
          value={draft}
          autoFocus
          step={info.meta.type === "integer" ? 1 : "any"}
          min={info.meta.min}
          max={info.meta.max}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => setEditing(false)}
          onClick={(e) => e.stopPropagation()}
        />
      );
    }
    const text =
      liveValue !== undefined ? scalarToDisplay(liveValue, info.meta) : "—";
    const cls = `live${liveValue === undefined ? " empty" : ""}${
      info.meta.tunable && onSet ? " editable" : ""
    }`;
    return (
      <span
        className={cls}
        onClick={onValueClick}
        title={
          info.meta.tunable && onSet
            ? info.meta.type === "boolean"
              ? "click to toggle"
              : "click to edit • Enter to commit • Esc to cancel"
            : undefined
        }
      >
        {text}
      </span>
    );
  };

  return (
    <div
      className={`var-row${selected ? " selected" : ""}`}
      draggable={!editing}
      onDragStart={onDragStart}
      onClick={(e) => onSelect(info.fullPath, e)}
      title={`${info.fullPath} (${info.meta.type}${info.meta.units ? ", " + info.meta.units : ""})`}
    >
      <span className={`dot ${info.meta.tunable ? "tunable" : ""}`}>
        {info.meta.tunable ? "✎" : "•"}
      </span>
      <span className="name">{label}</span>
      <span className="type">{info.meta.type}</span>
      {renderValue()}
    </div>
  );
}
