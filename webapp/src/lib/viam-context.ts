import type { ConnectionConfig } from "../types";

/** Try to derive a connection config from the Viam-app embed context.
 *
 * When the scope is opened as a `single_machine` application from the Viam
 * app, the page is served at a URL whose first path segment is the
 * machine's hostname/key. The Viam app sets a cookie keyed by that same
 * value containing a JSON blob of credentials:
 *   { hostname, apiKey, apiKeyId, machineId, ... }
 *
 * We parse those, slot them into our ConnectionConfig, and let the rest
 * of App auto-connect on mount as if the user had filled the dialog.
 *
 * Returns null if any of: no machine key in URL, no cookie, malformed
 * cookie payload, missing apiKey/apiKeyId. Caller falls back to
 * localStorage (returning user) or shows the dialog (first-time).
 *
 * URL parameters can override the defaults:
 *   ?resource=<name>     — which sensor to query (default vt-aggregator)
 *   ?mode=<auto|aggregator|direct>
 */
export function tryViamAppContext(): ConnectionConfig | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  const segments = url.pathname.split("/").filter(Boolean);
  // Pallet-webapp precedent uses segments[1] || segments[0] — the
  // machine key may live at depth 0 or 1 depending on app routing.
  const machineKey = segments[1] || segments[0];
  if (!machineKey) return null;

  const raw = getCookie(machineKey);
  if (!raw) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(decodeURIComponent(raw));
  } catch {
    return null;
  }
  const apiKey = (parsed.apiKey ?? parsed.api_key) as string | undefined;
  const apiKeyId = (parsed.apiKeyId ?? parsed.api_key_id) as string | undefined;
  if (!apiKey || !apiKeyId) return null;

  const host =
    (parsed.hostname as string | undefined) ??
    (parsed.host as string | undefined) ??
    machineKey;

  const params = url.searchParams;
  const resource =
    params.get("resource") || params.get("component") || "vt-aggregator";
  const modeParam = params.get("mode");
  const mode: ConnectionConfig["mode"] =
    modeParam === "aggregator" || modeParam === "direct" ? modeParam : "auto";

  return { host, keyId: apiKeyId, apiKey, resource, mode };
}

function getCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const all = document.cookie.split("; ");
  for (const c of all) {
    const eq = c.indexOf("=");
    const k = eq < 0 ? c : c.slice(0, eq);
    if (k === name) return eq < 0 ? "" : c.slice(eq + 1);
  }
  return null;
}
