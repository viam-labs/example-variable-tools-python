// Types matching the variable_tools wire format.

export type Scalar = number | boolean | string;

export type VariableType = "double" | "integer" | "boolean" | "enum";

export interface VariableMeta {
  name: string;
  type: VariableType;
  tunable: boolean;
  units?: string;
  min?: number;
  max?: number;
  cases?: string[];
}

export interface SchemaTreeNode {
  name: string;
  version: number;
  variables: VariableMeta[];
  children: SchemaTreeNode[];
}

/** A variable path resolved against the connection (either direct or via
 * aggregator), with everything the UI needs to display + edit it. */
export interface PathInfo {
  /** Full key as it appears in `get_readings` / `vt.dump`, e.g.
   * "vt-demo.controller.pid.kp" when going through an aggregator. */
  fullPath: string;
  /** The variable's local path within its owning resource, e.g.
   * "controller.pid.kp" (no source prefix). Used for vt.set against the
   * owning resource directly. */
  localPath: string;
  /** The resource name that owns this variable (a dep name when via an
   * aggregator; the resource name itself when direct). */
  source: string;
  /** Dotted registry chain (without the variable's own name), e.g.
   * "controller.pid" — used to group in the tree view. */
  registryPath: string;
  meta: VariableMeta;
}

export interface ConnectionConfig {
  host: string;
  keyId: string;
  apiKey: string;
  /** Resource name to query. Typically the aggregator. */
  resource: string;
  /** "auto" probes vt.schema_all first (aggregator), falls back to vt.schema
   * (direct sensor). User can force either with "aggregator" or "direct". */
  mode: "auto" | "aggregator" | "direct";
}

export type ConnectionStatus =
  | { state: "disconnected" }
  | { state: "connecting" }
  | { state: "connected" }
  | { state: "error"; message: string };

export interface PlotPanel {
  id: string;
  title?: string;
  series: string[]; // full paths
  yMin?: number;
  yMax?: number;
  /** "shared" = all series share one auto-scaled y axis (default).
   *  "independent" = each series gets its own auto-scaled y scale so
   *  variables with different magnitudes are all visible. */
  yMode?: "shared" | "independent";
}

export interface PersistedLayout {
  connection?: ConnectionConfig;
  plots: PlotPanel[];
  treeExpanded: string[];
  pollRateHz: number;
  theme: "dark" | "light";
  windowSec: number;
  columns: number;
}
