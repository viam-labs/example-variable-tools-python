import { useMemo } from "react";

import type { PathInfo, Scalar } from "../types";
import { VariableRow } from "./VariableRow";

interface Props {
  paths: PathInfo[];
  pathsBySource: Map<string, PathInfo[]>;
  search: string;
  onSearchChange: (s: string) => void;
  viewMode: "flat" | "tree";
  onViewModeChange: (m: "flat" | "tree") => void;
  treeExpanded: Set<string>;
  onTreeExpandedChange: (s: Set<string>) => void;
  latest: Record<string, Scalar>;
}

export function VariablePanel({
  paths,
  pathsBySource,
  search,
  onSearchChange,
  viewMode,
  onViewModeChange,
  treeExpanded,
  onTreeExpandedChange,
  latest,
}: Props) {
  const lower = search.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      lower
        ? paths.filter((p) => p.fullPath.toLowerCase().includes(lower))
        : paths,
    [paths, lower],
  );

  return (
    <div className="panel-vars">
      <div className="search">
        <input
          type="text"
          placeholder="Search variables…"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
        />
      </div>
      <div className="modeswitch">
        <button
          className={viewMode === "flat" ? "active" : ""}
          onClick={() => onViewModeChange("flat")}
        >
          Flat
        </button>
        <button
          className={viewMode === "tree" ? "active" : ""}
          onClick={() => onViewModeChange("tree")}
        >
          Tree
        </button>
      </div>
      <div className="list">
        {viewMode === "flat" ? (
          <FlatList paths={filtered} latest={latest} />
        ) : (
          <TreeList
            paths={filtered}
            pathsBySource={pathsBySource}
            expanded={treeExpanded}
            onExpandedChange={onTreeExpandedChange}
            latest={latest}
            filterActive={lower.length > 0}
          />
        )}
      </div>
    </div>
  );
}

function FlatList({
  paths,
  latest,
}: {
  paths: PathInfo[];
  latest: Record<string, Scalar>;
}) {
  if (paths.length === 0) {
    return (
      <div style={{ padding: "10px 12px", color: "var(--text-dim)" }}>
        {paths.length === 0 ? "no matches" : ""}
      </div>
    );
  }
  return (
    <>
      {paths.map((p) => (
        <VariableRow
          key={p.fullPath}
          info={p}
          label={p.fullPath}
          liveValue={latest[p.fullPath]}
        />
      ))}
    </>
  );
}

type TreeNode = {
  key: string; // unique tree key, e.g. "vt-demo|controller.pid"
  label: string; // last segment
  fullKey: string; // dotted, prefix-with-source
  children: Map<string, TreeNode>;
  vars: PathInfo[];
};

function buildTree(
  pathsBySource: Map<string, PathInfo[]>,
  filtered: PathInfo[],
): TreeNode {
  const root: TreeNode = {
    key: "",
    label: "",
    fullKey: "",
    children: new Map(),
    vars: [],
  };
  const allowed = new Set(filtered.map((p) => p.fullPath));

  for (const [source, paths] of pathsBySource.entries()) {
    const sourceNode: TreeNode = {
      key: source,
      label: source,
      fullKey: source,
      children: new Map(),
      vars: [],
    };
    for (const p of paths) {
      if (!allowed.has(p.fullPath)) continue;
      const parts = p.registryPath ? p.registryPath.split(".") : [];
      let node = sourceNode;
      let accum = source;
      for (const part of parts) {
        accum += "." + part;
        let next = node.children.get(part);
        if (!next) {
          next = {
            key: accum,
            label: part,
            fullKey: accum,
            children: new Map(),
            vars: [],
          };
          node.children.set(part, next);
        }
        node = next;
      }
      node.vars.push(p);
    }
    // Only include source if it had matches.
    if (sourceNode.children.size > 0 || sourceNode.vars.length > 0) {
      root.children.set(source, sourceNode);
    }
  }
  return root;
}

function TreeList({
  paths,
  pathsBySource,
  expanded,
  onExpandedChange,
  latest,
  filterActive,
}: {
  paths: PathInfo[];
  pathsBySource: Map<string, PathInfo[]>;
  expanded: Set<string>;
  onExpandedChange: (s: Set<string>) => void;
  latest: Record<string, Scalar>;
  filterActive: boolean;
}) {
  const root = useMemo(
    () => buildTree(pathsBySource, paths),
    [pathsBySource, paths],
  );

  // When a filter is active, expand everything.
  const isExpanded = (key: string): boolean => filterActive || expanded.has(key);
  const toggle = (key: string) => {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onExpandedChange(next);
  };

  if (root.children.size === 0) {
    return (
      <div style={{ padding: "10px 12px", color: "var(--text-dim)" }}>
        no matches
      </div>
    );
  }

  const renderNode = (node: TreeNode): React.ReactNode => {
    const open = isExpanded(node.key);
    return (
      <div className="tree-node" key={node.key}>
        <div className="label" onClick={() => toggle(node.key)}>
          <span className="caret">{open ? "▾" : "▸"}</span>
          <span>{node.label}</span>
        </div>
        {open && (
          <div className="children">
            {Array.from(node.children.values()).map(renderNode)}
            {node.vars.map((p) => (
              <VariableRow
                key={p.fullPath}
                info={p}
                label={p.meta.name}
                liveValue={latest[p.fullPath]}
              />
            ))}
          </div>
        )}
      </div>
    );
  };

  return <>{Array.from(root.children.values()).map(renderNode)}</>;
}
