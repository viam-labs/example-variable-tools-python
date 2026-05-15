import type { PathInfo, Scalar } from "../types";
import { TunableEditor } from "./TunableEditor";

interface Props {
  tunables: PathInfo[];
  latest: Record<string, Scalar>;
  errors: Record<string, string>;
  onSet: (info: PathInfo, value: Scalar) => void;
  disabled: boolean;
}

export function TunablesBar({
  tunables,
  latest,
  errors,
  onSet,
  disabled,
}: Props) {
  if (tunables.length === 0) {
    return null;
  }
  return (
    <div className="tunables">
      <h4>Tunables ({tunables.length})</h4>
      <div className="row">
        {tunables.map((t) => (
          <TunableEditor
            key={t.fullPath}
            info={t}
            currentValue={latest[t.fullPath]}
            error={errors[t.fullPath]}
            disabled={disabled}
            onSet={onSet}
          />
        ))}
      </div>
    </div>
  );
}
