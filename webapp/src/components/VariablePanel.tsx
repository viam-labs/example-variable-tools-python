import { useCallback, useMemo, useRef, useState } from "react";

import type { PathInfo, Scalar } from "../types";
import { VariableRow } from "./VariableRow";

interface Props {
  paths: PathInfo[];
  pathsBySource: Map<string, PathInfo[]>;
  search: string;
  onSearchChange: (s: string) => void;
  treeExpanded: Set<string>;
  onTreeExpandedChange: (s: Set<string>) => void;
  latest: Record<string, Scalar>;
  width: number;
  onWidthChange: (px: number) => void;
}

export function VariablePanel({
  paths,
  pathsBySource,
  search,
  onSearchChange,
  treeExpanded,
  onTreeExpandedChange,
  latest,
  width,
  onWidthChange,
}: Props) {
  const dragStart = useRef<{ x: number; w: number } | null>(null);
  const onResizeDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragStart.current = { x: e.clientX, w: width };
  };
  const onResizeMove = (e: React.PointerEvent) => {
    if (!dragStart.current) return;
    const { x, w } = dragStart.current;
    onWidthChange(w + (e.clientX - x));
  };
  const onResizeUp = (e: React.PointerEvent) => {
    if (dragStart.current) {
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      dragStart.current = null;
    }
  };
  const lower = search.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      lower
        ? paths.filter((p) => p.fullPath.toLowerCase().includes(lower))
        : paths,
    [paths, lower],
  );

  // Selection state for shift/ctrl multi-select.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchorRef = useRef<string | null>(null);

  /** Linear order of currently-visible variable paths, computed in the same
   * order TreeList renders them — required for shift+click range selection. */
  const visibleOrder = useMemo(() => {
    const out: string[] = [];
    const filteredSet = new Set(filtered.map((p) => p.fullPath));
    for (const [, sourcePaths] of pathsBySource.entries()) {
      for (const p of sourcePaths) {
        if (filteredSet.has(p.fullPath)) out.push(p.fullPath);
      }
    }
    return out;
  }, [filtered, pathsBySource]);

  const handleSelect = useCallback(
    (path: string, e: React.MouseEvent) => {
      if (e.shiftKey && anchorRef.current) {
        const i1 = visibleOrder.indexOf(anchorRef.current);
        const i2 = visibleOrder.indexOf(path);
        if (i1 >= 0 && i2 >= 0) {
          const lo = Math.min(i1, i2);
          const hi = Math.max(i1, i2);
          setSelected(new Set(visibleOrder.slice(lo, hi + 1)));
        }
      } else if (e.metaKey || e.ctrlKey) {
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          return next;
        });
        anchorRef.current = path;
      } else {
        setSelected(new Set([path]));
        anchorRef.current = path;
      }
    },
    [visibleOrder],
  );

  return (
    <div className="panel-vars" style={{ width }}>
      <div
        className="panel-resize-handle"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={onResizeUp}
        title="Drag to resize sidebar"
      />
      <div className="search">
        <input
          type="text"
          placeholder="Search variables…"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
        />
      </div>
      {selected.size > 1 && (
        <div className="selection-hint">
          {selected.size} selected — drag onto a plot to add all
          <button className="ghost" onClick={() => setSelected(new Set())}>
            clear
          </button>
        </div>
      )}
      <div className="list">
        <TreeList
          paths={filtered}
          pathsBySource={pathsBySource}
          expanded={treeExpanded}
          onExpandedChange={onTreeExpandedChange}
          latest={latest}
          filterActive={lower.length > 0}
          selected={selected}
          onSelect={handleSelect}
        />
      </div>
    </div>
  );
}

type TreeNode = {
  key: string;
  label: string;
  fullKey: string;
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
  selected,
  onSelect,
}: {
  paths: PathInfo[];
  pathsBySource: Map<string, PathInfo[]>;
  expanded: Set<string>;
  onExpandedChange: (s: Set<string>) => void;
  latest: Record<string, Scalar>;
  filterActive: boolean;
  selected: Set<string>;
  onSelect: (path: string, e: React.MouseEvent) => void;
}) {
  const root = useMemo(
    () => buildTree(pathsBySource, paths),
    [pathsBySource, paths],
  );

  const isExpanded = (key: string): boolean =>
    filterActive || expanded.has(key);
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
                selected={selected.has(p.fullPath)}
                onSelect={onSelect}
                selectedPaths={selected}
              />
            ))}
          </div>
        )}
      </div>
    );
  };

  return <>{Array.from(root.children.values()).map(renderNode)}</>;
}
