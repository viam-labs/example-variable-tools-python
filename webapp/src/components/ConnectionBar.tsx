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
}

const RATES = [1, 2, 5, 10, 20, 30];

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
}: Props) {
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
      <span style={{ flex: 1 }} />
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
      <button onClick={onThemeToggle} title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
        {theme === "dark" ? "☀" : "☾"}
      </button>
      <button onClick={onEditConnection}>Connection…</button>
      {status.state === "connected" && (
        <button onClick={onDisconnect}>Disconnect</button>
      )}
    </div>
  );
}
