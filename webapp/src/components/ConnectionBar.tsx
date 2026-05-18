import type { ConnectionStatus } from "../types";

// Injected by Vite at build time from the repo's VERSION file.
declare const __APP_VERSION__: string;

interface Props {
  status: ConnectionStatus;
  host?: string;
  machineId?: string;
  resource?: string;
  mode?: "aggregator" | "direct";
  pollRateHz: number;
  onPollRateChange: (hz: number) => void;
  onEditConnection: () => void;
  onDisconnect: () => void;
  theme: "dark" | "light";
  onThemeToggle: () => void;
  tickCount: number;
  latestKeys: number;
  pathCount: number;
  lastDumpAt: number | null;
  windowSec: number;
  onWindowSecChange: (sec: number) => void;
  paused: boolean;
  /** When trim is active, the duration in seconds (rounded to 2 decimal
   * places for the dropdown display). null when no trim is in effect. */
  trimDurationSec: number | null;
  onClearTrim: () => void;
}

const RATES = [1, 2, 5, 10, 20, 30];
const WINDOWS = [
  { sec: 10, label: "10s" },
  { sec: 30, label: "30s" },
  { sec: 60, label: "1min" },
  { sec: 300, label: "5min" },
  { sec: 900, label: "15min" },
];

export function ConnectionBar({
  status,
  host,
  machineId,
  resource,
  mode,
  pollRateHz,
  onPollRateChange,
  onEditConnection,
  onDisconnect,
  theme,
  onThemeToggle,
  tickCount,
  latestKeys,
  pathCount,
  lastDumpAt,
  windowSec,
  onWindowSecChange,
  paused,
  trimDurationSec,
  onClearTrim,
}: Props) {
  const ageMs = lastDumpAt ? Date.now() - lastDumpAt : null;
  const machineHref = machineId
    ? `https://app.viam.com/machine/${encodeURIComponent(machineId)}`
    : undefined;
  const dotClass =
    status.state === "connected"
      ? "connected"
      : status.state === "connecting"
        ? "connecting"
        : status.state === "error"
          ? "error"
          : "disconnected";
  return (
    <div className="connbar">
      <span
        className="crumb"
        style={{ color: "var(--text-dim)" }}
        title="Webapp version (synced to the module's VERSION file at build time)"
      >
        v{__APP_VERSION__}
      </span>
      <span className={`status-dot ${dotClass}`} title={status.state} />
      {host ? (
        <>
          <span className="crumb">
            {machineHref ? (
              <a
                href={machineHref}
                target="_blank"
                rel="noopener noreferrer"
                title="Open this machine's config in the Viam app"
                style={{ color: "var(--accent)" }}
              >
                <b>{host}</b>
              </a>
            ) : (
              <b>{host}</b>
            )}
          </span>
          <span className="crumb">•</span>
          <span className="crumb">
            <b>{resource}</b>
            {mode ? ` (${mode})` : ""}
          </span>
        </>
      ) : (
        <span className="crumb">not connected</span>
      )}
      {status.state === "error" && (
        <span className="crumb" style={{ color: "var(--danger)" }}>
          {status.message}
        </span>
      )}
      {status.state === "connected" && (
        <span className="crumb" title="polls / values returned / paths in schema / age of last dump">
          polls: <b>{tickCount}</b> • values: <b>{latestKeys}/{pathCount}</b>
          {ageMs !== null && (
            <>
              {" "}• last: <b>{ageMs < 1000 ? `${ageMs}ms` : `${(ageMs / 1000).toFixed(1)}s`}</b> ago
            </>
          )}
        </span>
      )}
      {paused && (
        <span
          className="crumb"
          style={{ color: "var(--warn)", fontWeight: 600 }}
        >
          ⏸ PAUSED
        </span>
      )}
      <span style={{ flex: 1 }} />
      <label className="crumb">
        Window:&nbsp;
        <select
          value={trimDurationSec !== null ? -1 : windowSec}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (v === -1) return; // can't pick "trimmed" manually
            // Selecting any standard window while trimmed clears the trim.
            if (trimDurationSec !== null) onClearTrim();
            onWindowSecChange(v);
          }}
          title={
            trimDurationSec !== null
              ? "Currently showing a trimmed range — pick a window value to clear the trim"
              : "How much history to keep in each variable's buffer"
          }
        >
          {trimDurationSec !== null && (
            <option value={-1}>trimmed {trimDurationSec.toFixed(2)}s</option>
          )}
          {WINDOWS.map((w) => (
            <option key={w.sec} value={w.sec}>
              {w.label}
            </option>
          ))}
        </select>
      </label>
      <label className="crumb">
        Poll:&nbsp;
        <select
          value={pollRateHz}
          onChange={(e) => onPollRateChange(Number(e.target.value))}
        >
          {RATES.map((r) => (
            <option key={r} value={r}>
              {r} Hz
            </option>
          ))}
        </select>
      </label>
      <button
        onClick={onThemeToggle}
        title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
      >
        {theme === "dark" ? "☀" : "☾"}
      </button>
      <button onClick={onEditConnection}>Connection…</button>
      {status.state === "connected" && (
        <button onClick={onDisconnect}>Disconnect</button>
      )}
    </div>
  );
}
