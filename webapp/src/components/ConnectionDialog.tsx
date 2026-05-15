import { useState } from "react";

import type { ConnectionConfig } from "../types";

interface Props {
  initial?: ConnectionConfig;
  onConnect: (cfg: ConnectionConfig) => void;
  onCancel?: () => void;
  errorMessage?: string;
}

export function ConnectionDialog({
  initial,
  onConnect,
  onCancel,
  errorMessage,
}: Props) {
  const [host, setHost] = useState(initial?.host ?? "");
  const [keyId, setKeyId] = useState(initial?.keyId ?? "");
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? "");
  const [resource, setResource] = useState(initial?.resource ?? "vt-aggregator");
  const [mode, setMode] = useState<ConnectionConfig["mode"]>(
    initial?.mode ?? "auto",
  );

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    onConnect({ host: host.trim(), keyId: keyId.trim(), apiKey: apiKey.trim(), resource: resource.trim(), mode });
  };

  return (
    <div className="dialog-overlay">
      <form className="dialog" onSubmit={submit}>
        <h2>Connect to a Viam machine</h2>
        <div className="field">
          <label htmlFor="host">Machine address (FQDN)</label>
          <input
            id="host"
            type="text"
            placeholder="variable-tools-9000-main.pgn074cus0.viam.cloud"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            autoFocus
            required
          />
        </div>
        <div className="field">
          <label htmlFor="keyId">API key id</label>
          <input
            id="keyId"
            type="text"
            placeholder="d0551689-19fc-…"
            value={keyId}
            onChange={(e) => setKeyId(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="apiKey">API key</label>
          <input
            id="apiKey"
            type="password"
            placeholder="9ptav…"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="resource">Resource name</label>
          <input
            id="resource"
            type="text"
            placeholder="vt-aggregator"
            value={resource}
            onChange={(e) => setResource(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="mode">Mode</label>
          <select
            id="mode"
            value={mode}
            onChange={(e) => setMode(e.target.value as ConnectionConfig["mode"])}
          >
            <option value="auto">Auto (try aggregator, fall back to direct)</option>
            <option value="aggregator">Aggregator (vt.schema_all)</option>
            <option value="direct">Direct sensor (vt.schema)</option>
          </select>
        </div>
        {errorMessage && <div className="error">{errorMessage}</div>}
        <div className="actions">
          {onCancel && (
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
          )}
          <button type="submit" className="primary">
            Connect
          </button>
        </div>
      </form>
    </div>
  );
}
