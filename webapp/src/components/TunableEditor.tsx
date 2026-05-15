import { useEffect, useState } from "react";

import type { PathInfo, Scalar } from "../types";

interface Props {
  info: PathInfo;
  currentValue?: Scalar;
  error?: string;
  disabled: boolean;
  onSet: (info: PathInfo, value: Scalar) => void;
}

export function TunableEditor({
  info,
  currentValue,
  error,
  disabled,
  onSet,
}: Props) {
  const [draft, setDraft] = useState<string>("");

  // Reset draft when the live value changes externally (and draft is empty).
  useEffect(() => {
    if (currentValue !== undefined && draft === "") {
      setDraft(String(currentValue));
    }
  }, [currentValue, draft]);

  const submit = () => {
    if (info.meta.type === "double" || info.meta.type === "integer") {
      const n = Number(draft);
      if (!Number.isFinite(n)) return;
      onSet(info, info.meta.type === "integer" ? Math.trunc(n) : n);
    } else if (info.meta.type === "boolean") {
      onSet(info, draft === "true");
    } else if (info.meta.type === "enum") {
      onSet(info, draft);
    }
  };

  const inputEl = (() => {
    if (info.meta.type === "boolean") {
      return (
        <select
          value={String(currentValue ?? false)}
          onChange={(e) => onSet(info, e.target.value === "true")}
          disabled={disabled}
        >
          <option value="false">false</option>
          <option value="true">true</option>
        </select>
      );
    }
    if (info.meta.type === "enum") {
      return (
        <select
          value={String(currentValue ?? info.meta.cases?.[0] ?? "")}
          onChange={(e) => onSet(info, e.target.value)}
          disabled={disabled}
        >
          {info.meta.cases?.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      );
    }
    // numeric
    return (
      <>
        <input
          type="number"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          disabled={disabled}
          step={info.meta.type === "integer" ? 1 : "any"}
          min={info.meta.min}
          max={info.meta.max}
        />
        <button onClick={submit} disabled={disabled}>
          Set
        </button>
      </>
    );
  })();

  return (
    <span className="tunable" title={info.fullPath}>
      <span className="path">{info.fullPath}</span>
      {inputEl}
      {info.meta.units && <span className="units">{info.meta.units}</span>}
      {error && <span className="err">{error}</span>}
    </span>
  );
}
