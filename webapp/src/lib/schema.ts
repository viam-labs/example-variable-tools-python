import type { PathInfo, SchemaTreeNode, Scalar, VariableMeta } from "../types";

/** Walk a single source's schema tree into a flat list of PathInfo, prefixed
 * with `source` when `prefixWithSource` is true (aggregator mode). */
export function flattenSchema(
  source: string,
  tree: SchemaTreeNode,
  prefixWithSource: boolean,
): PathInfo[] {
  const out: PathInfo[] = [];
  const walk = (node: SchemaTreeNode, registryPath: string): void => {
    for (const v of node.variables) {
      const localPath = registryPath ? `${registryPath}.${v.name}` : v.name;
      const fullPath = prefixWithSource ? `${source}.${localPath}` : localPath;
      out.push({
        fullPath,
        localPath,
        source,
        registryPath,
        meta: v,
      });
    }
    for (const c of node.children) {
      const next = registryPath ? `${registryPath}.${c.name}` : c.name;
      walk(c, next);
    }
  };
  walk(tree, "");
  return out;
}

/** Convert a scalar value from the server into a number for plotting. Bools
 * map to 0/1; enums map to the index in their `cases` list; strings/unknowns
 * become NaN (uPlot will skip them). */
export function scalarToNumber(value: Scalar, meta?: VariableMeta): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    if (meta?.type === "enum" && meta.cases) {
      const i = meta.cases.indexOf(value);
      return i >= 0 ? i : NaN;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/** Build a display label for a scalar in current-value text contexts.
 * ``precision`` controls the fixed decimal count for doubles (default 2;
 * chips in the plot area use 4 for finer-grained scrubbing readouts). */
export function scalarToDisplay(
  value: Scalar,
  meta?: VariableMeta,
  precision = 2,
): string {
  if (typeof value === "number") {
    if (meta?.type === "integer") return String(Math.trunc(value));
    return Number.isFinite(value) ? value.toFixed(precision) : String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}
