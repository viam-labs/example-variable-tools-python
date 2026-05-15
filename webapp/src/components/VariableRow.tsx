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
}

export function VariableRow({
  info,
  label,
  liveValue,
  selected,
  onSelect,
  selectedPaths,
}: Props) {
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
  return (
    <div
      className={`var-row${selected ? " selected" : ""}`}
      draggable
      onDragStart={onDragStart}
      onClick={(e) => onSelect(info.fullPath, e)}
      title={`${info.fullPath} (${info.meta.type}${info.meta.units ? ", " + info.meta.units : ""})`}
    >
      <span className={`dot ${info.meta.tunable ? "tunable" : ""}`}>
        {info.meta.tunable ? "✎" : "•"}
      </span>
      <span className="name">{label}</span>
      <span className="type">{info.meta.type}</span>
      <span className={`live${liveValue === undefined ? " empty" : ""}`}>
        {liveValue !== undefined ? scalarToDisplay(liveValue, info.meta) : "—"}
      </span>
    </div>
  );
}
