import type { PathInfo, Scalar } from "../types";
import { scalarToDisplay } from "../lib/schema";

interface Props {
  info: PathInfo;
  /** What to show as the label — full path in flat mode, just the var name
   * in tree mode where the tree itself shows the hierarchy. */
  label: string;
  liveValue?: Scalar;
}

export function VariableRow({ info, label, liveValue }: Props) {
  const onDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData("text/vt-path", info.fullPath);
    e.dataTransfer.effectAllowed = "copy";
  };
  return (
    <div
      className="var-row"
      draggable
      onDragStart={onDragStart}
      title={`${info.fullPath} (${info.meta.type}${info.meta.units ? ", " + info.meta.units : ""})`}
    >
      <span className={`dot ${info.meta.tunable ? "tunable" : ""}`}>
        {info.meta.tunable ? "✎" : "•"}
      </span>
      <span className="name">{label}</span>
      <span className="type">{info.meta.type}</span>
      <span className="live">
        {liveValue !== undefined ? scalarToDisplay(liveValue, info.meta) : "—"}
      </span>
    </div>
  );
}
