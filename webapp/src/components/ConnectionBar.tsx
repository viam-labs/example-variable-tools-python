import type { ConnectionStatus } from "../types";

interface Props {
  status: ConnectionStatus;
  host?: string;
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
}: Props) {
  const ageMs = lastDumpAt ? Date.now() - lastDumpAt : null;
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
      <span className={`status-dot ${dotClass}`} title={status.state} />
      {host ? (
        <>
          <span className="crumb">
            <b>{host}</b>
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
          value={windowSec}
          onChange={(e) => onWindowSecChange(Number(e.target.value))}
          title="How much history to keep in each variable's buffer"
        >
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
