/** Client-side export of buffered time-series data to common formats.
 *
 * All exporters take the same input — a list of named series (`path`,
 * `xs` timestamps in ms, `ys` numeric values) covering some window — and
 * return a Blob that can be triggered as a download. The wide-table /
 * union-of-timestamps shape is shared: each export aligns rows on a
 * union of all timestamps and forward-fills missing samples per series,
 * the same alignment uPlot does for display.
 */

import { McapWriter, IWritable } from "@mcap/core";

export type ExportFormat = "csv" | "mcap" | "mat";

export interface SeriesInput {
  /** Full dotted/separator-joined path identifying the variable. */
  path: string;
  /** Timestamps in milliseconds, ascending. */
  xs: number[];
  /** Same length as xs. */
  ys: number[];
}

interface AlignedTable {
  xs: number[]; // union of timestamps, ascending, in ms
  columns: { path: string; values: number[] }[];
}

/** Align multiple series onto a unified timestamp axis (union), with
 * forward-fill per series. NaN before the first sample for that series. */
function align(series: SeriesInput[]): AlignedTable {
  if (series.length === 0) return { xs: [], columns: [] };
  const xSet = new Set<number>();
  for (const s of series) for (const x of s.xs) xSet.add(x);
  const xs = Array.from(xSet).sort((a, b) => a - b);
  const columns: AlignedTable["columns"] = [];
  for (const s of series) {
    const values: number[] = new Array(xs.length);
    let idx = 0;
    let last = NaN;
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i];
      while (idx < s.xs.length && s.xs[idx] <= x) {
        last = s.ys[idx];
        idx += 1;
      }
      values[i] = last;
    }
    columns.push({ path: s.path, values });
  }
  return { xs, columns };
}

function csvEscape(s: string): string {
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return "";
  return String(v);
}

/** CSV: timestamp_ms, <path1>, <path2>, ... Wide-table layout. */
export function exportCsv(series: SeriesInput[]): Blob {
  const t = align(series);
  const header = ["timestamp_ms", ...t.columns.map((c) => csvEscape(c.path))];
  const rows: string[] = [header.join(",")];
  for (let i = 0; i < t.xs.length; i++) {
    const row = [String(t.xs[i])];
    for (const col of t.columns) row.push(formatNumber(col.values[i]));
    rows.push(row.join(","));
  }
  return new Blob([rows.join("\n") + "\n"], { type: "text/csv" });
}

// Blob constructor wants ArrayBuffer-backed views; cast Uint8Array slices
// through a fresh ArrayBuffer when needed to placate TypeScript's strict
// SharedArrayBuffer handling.
function toBlobPart(u8: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u8.byteLength);
  new Uint8Array(out).set(u8);
  return out;
}

/** In-memory IWritable for @mcap/core. */
class MemoryWritable implements IWritable {
  private chunks: Uint8Array[] = [];
  private pos = 0;
  async write(buffer: Uint8Array): Promise<void> {
    this.chunks.push(buffer);
    this.pos += buffer.byteLength;
  }
  position(): bigint {
    return BigInt(this.pos);
  }
  bytes(): Uint8Array {
    let total = 0;
    for (const c of this.chunks) total += c.byteLength;
    const out = new Uint8Array(total);
    let p = 0;
    for (const c of this.chunks) {
      out.set(c, p);
      p += c.byteLength;
    }
    return out;
  }
}

/** MCAP: one channel per series, JSON message schema `{value: number}`,
 * one message per sample. Timestamps are ms → ns for MCAP's log_time. */
export async function exportMcap(series: SeriesInput[]): Promise<Blob> {
  const w = new MemoryWritable();
  const writer = new McapWriter({
    writable: w,
    useStatistics: true,
    useSummaryOffsets: true,
    useChunks: true,
  });
  await writer.start({
    library: "variable-tools-scope",
    profile: "",
  });
  const schemaId = await writer.registerSchema({
    name: "Scalar",
    encoding: "jsonschema",
    data: new TextEncoder().encode(
      JSON.stringify({
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      }),
    ),
  });
  for (const s of series) {
    const channelId = await writer.registerChannel({
      schemaId,
      topic: "/" + s.path.replace(/\./g, "/").replace(/[^\w/-]/g, "_"),
      messageEncoding: "json",
      metadata: new Map([["path", s.path]]),
    });
    const enc = new TextEncoder();
    for (let i = 0; i < s.xs.length; i++) {
      const tsNs = BigInt(Math.round(s.xs[i])) * 1_000_000n;
      await writer.addMessage({
        channelId,
        sequence: i,
        logTime: tsNs,
        publishTime: tsNs,
        data: enc.encode(JSON.stringify({ value: s.ys[i] })),
      });
    }
  }
  await writer.end();
  return new Blob([toBlobPart(w.bytes())], {
    type: "application/octet-stream",
  });
}

/** MATLAB v5 .mat: encodes a struct of named 1×N double matrices.
 *
 * Format reference: MATLAB MAT-File Format manual.
 *   - 116-byte description (ASCII, padded)
 *   - 8-byte subsystem offset (zeros for our use)
 *   - 2-byte version (0x0100)
 *   - 2-byte endian indicator "MI" → little-endian, "IM" → big-endian
 *   - Then a sequence of miMATRIX data elements
 *
 * We emit a single top-level mxSTRUCT with one field per series + a
 * `timestamp_ms` field. Each field's value is a 1×N mxDOUBLE matrix.
 */
export function exportMat(series: SeriesInput[]): Blob {
  const t = align(series);
  const fieldNames = ["timestamp_ms", ...t.columns.map((c) => c.path)];
  const columns: number[][] = [t.xs, ...t.columns.map((c) => c.values)];

  const chunks: number[] = [];
  const write = (bytes: ArrayLike<number>) => {
    for (let i = 0; i < bytes.length; i++) chunks.push(bytes[i]);
  };
  const writeU32 = (v: number) => write(u32(v));
  const padTo8 = () => {
    while (chunks.length % 8 !== 0) chunks.push(0);
  };

  // ---- Header (128 bytes) ----
  const desc = "MATLAB 5.0 MAT-file, generated by variable-tools-scope".padEnd(116);
  for (let i = 0; i < 116; i++) chunks.push(desc.charCodeAt(i));
  for (let i = 0; i < 8; i++) chunks.push(0); // subsystem offset = 0
  write(u16(0x0100)); // version
  write(["M".charCodeAt(0), "I".charCodeAt(0)]); // little-endian indicator

  // ---- Single top-level mxSTRUCT_CLASS miMATRIX ----
  // We'll write to a temporary buffer to compute the size, then emit the
  // outer (type, size, payload) at the end.
  const sub: number[] = [];
  const sw = (bytes: ArrayLike<number>) => {
    for (let i = 0; i < bytes.length; i++) sub.push(bytes[i]);
  };
  const subPad8 = () => {
    while (sub.length % 8 !== 0) sub.push(0);
  };

  // Sub-element: Array Flags (miUINT32, 8 bytes payload)
  sw(u32(6 /* miUINT32 */));
  sw(u32(8));
  sw(u32(2 /* mxSTRUCT_CLASS */));
  sw(u32(0));

  // Sub-element: Dimensions Array (miINT32, 8 bytes payload: 1×1 struct)
  sw(u32(5 /* miINT32 */));
  sw(u32(8));
  sw(i32(1));
  sw(i32(1));

  // Sub-element: Array Name (miINT8, "data")
  const aname = "data";
  sw(u32(1 /* miINT8 */));
  sw(u32(aname.length));
  for (let i = 0; i < aname.length; i++) sub.push(aname.charCodeAt(i));
  subPad8();

  // Sub-element: Field Name Length (miINT32, 4 bytes payload).
  // Use a fixed cell width that fits the longest name + 1 NUL terminator,
  // padded to multiple of 8.
  const fieldNameLen =
    Math.ceil((Math.max(...fieldNames.map((n) => n.length)) + 1) / 8) * 8;
  sw(u32(5 /* miINT32 */));
  sw(u32(4));
  sw(i32(fieldNameLen));
  subPad8();

  // Sub-element: Field Names (miINT8, fieldNameLen × N)
  const fieldsBytes = fieldNameLen * fieldNames.length;
  sw(u32(1 /* miINT8 */));
  sw(u32(fieldsBytes));
  for (const name of fieldNames) {
    for (let i = 0; i < fieldNameLen; i++) {
      sub.push(i < name.length ? name.charCodeAt(i) : 0);
    }
  }
  subPad8();

  // Sub-element: one miMATRIX per field, holding a 1×N mxDOUBLE.
  for (const col of columns) {
    const fld: number[] = [];
    const fw = (bytes: ArrayLike<number>) => {
      for (let i = 0; i < bytes.length; i++) fld.push(bytes[i]);
    };
    const fpad8 = () => {
      while (fld.length % 8 !== 0) fld.push(0);
    };
    // Array Flags
    fw(u32(6));
    fw(u32(8));
    fw(u32(6 /* mxDOUBLE_CLASS */));
    fw(u32(0));
    // Dimensions: 1 × N
    fw(u32(5));
    fw(u32(8));
    fw(i32(1));
    fw(i32(col.length));
    // Array Name (empty for struct fields)
    fw(u32(1));
    fw(u32(0));
    fpad8();
    // Real part: miDOUBLE, N × 8 bytes
    fw(u32(9 /* miDOUBLE */));
    fw(u32(col.length * 8));
    const f64 = new Float64Array(col);
    const u8 = new Uint8Array(f64.buffer, f64.byteOffset, f64.byteLength);
    for (let i = 0; i < u8.length; i++) fld.push(u8[i]);
    fpad8();
    // Emit outer miMATRIX tag for this field.
    sw(u32(14 /* miMATRIX */));
    sw(u32(fld.length));
    sw(fld);
  }

  // Outer miMATRIX (the struct).
  writeU32(14 /* miMATRIX */);
  writeU32(sub.length);
  write(sub);
  padTo8();

  return new Blob([toBlobPart(Uint8Array.from(chunks))], {
    type: "application/octet-stream",
  });
}

// ---- little-endian bytes helpers ----
function u16(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff];
}
function u32(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}
function i32(v: number): number[] {
  return u32(v >>> 0);
}

/** Trigger a download with the given Blob + filename. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 0);
}

export function defaultFilename(ext: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `vt-scope_${stamp}.${ext}`;
}
