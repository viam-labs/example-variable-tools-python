/** Thin wrapper around @viamrobotics/sdk that knows how to:
 *   - connect with API-key credentials,
 *   - fetch a schema (vt.schema for direct, vt.schema_all for aggregator),
 *   - issue vt.dump and vt.set DoCommands. */
import { Struct, type JsonValue } from "@bufbuild/protobuf";
import {
  createRobotClient,
  type Credential,
  type RobotClient,
  SensorClient,
} from "@viamrobotics/sdk";

import type {
  ConnectionConfig,
  PathInfo,
  SchemaTreeNode,
  Scalar,
} from "./types";
import { flattenSchema } from "./lib/schema";

export interface ConnectedSession {
  client: RobotClient;
  sensor: SensorClient;
  config: ConnectionConfig;
  paths: PathInfo[];
  /** Per-source schema tree, keyed by source name. For direct mode this is
   * `{ [resourceName]: <its schema> }`. For aggregator mode it's one entry
   * per dep that responded to vt.schema. */
  schemas: Record<string, SchemaTreeNode>;
  /** Detected actual mode after probing — "aggregator" or "direct". */
  mode: "aggregator" | "direct";
  /** Whether dump keys should be prefixed with source name. True for
   * aggregator (its dump already returns prefixed keys), false for direct
   * (a direct sensor's keys are local). */
  prefixWithSource: boolean;
}

export async function connect(
  cfg: ConnectionConfig,
): Promise<ConnectedSession> {
  const creds: Credential = {
    type: "api-key",
    payload: cfg.apiKey,
    authEntity: cfg.keyId,
  };
  const client = await createRobotClient({
    host: cfg.host,
    credentials: creds,
    signalingAddress: "https://app.viam.com:443",
    iceServers: [{ urls: "stun:global.stun.twilio.com:3478" }],
  });
  const sensor = new SensorClient(client, cfg.resource);

  const { mode, schemas, prefixWithSource } = await probeSchema(sensor, cfg);
  const paths: PathInfo[] = [];
  for (const [source, tree] of Object.entries(schemas)) {
    paths.push(...flattenSchema(source, tree, prefixWithSource));
  }
  paths.sort((a, b) => a.fullPath.localeCompare(b.fullPath));

  return { client, sensor, config: cfg, paths, schemas, mode, prefixWithSource };
}

async function probeSchema(
  sensor: SensorClient,
  cfg: ConnectionConfig,
): Promise<{
  mode: "aggregator" | "direct";
  schemas: Record<string, SchemaTreeNode>;
  prefixWithSource: boolean;
}> {
  const tryAggregator = async () => {
    const resp = await sensor.doCommand(Struct.fromJson({ command: "vt.schema_all" }));
    const obj = resp as unknown as Record<string, unknown>;
    const raw = obj?.schemas as
      | Record<string, { schema: SchemaTreeNode }>
      | undefined;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const schemas: Record<string, SchemaTreeNode> = {};
    for (const [name, entry] of Object.entries(raw)) {
      if (entry && typeof entry === "object" && "schema" in entry) {
        schemas[name] = (entry as { schema: SchemaTreeNode }).schema;
      }
    }
    if (Object.keys(schemas).length === 0) return null;
    return schemas;
  };
  const tryDirect = async () => {
    const resp = await sensor.doCommand(Struct.fromJson({ command: "vt.schema" }));
    const obj = resp as unknown as Record<string, unknown>;
    const schema = obj?.schema as SchemaTreeNode | undefined;
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
    return { [cfg.resource]: schema };
  };

  if (cfg.mode === "aggregator" || cfg.mode === "auto") {
    const agg = await tryAggregator().catch(() => null);
    if (agg) return { mode: "aggregator", schemas: agg, prefixWithSource: true };
    if (cfg.mode === "aggregator") {
      throw new Error("resource did not respond to vt.schema_all");
    }
  }
  const direct = await tryDirect().catch((e) => {
    throw new Error(`resource did not respond to vt.schema: ${e}`);
  });
  if (!direct) throw new Error("resource returned no schema");
  return { mode: "direct", schemas: direct, prefixWithSource: false };
}

/** Issue vt.dump and return a flat path → value map. For aggregator mode
 * the keys are already prefixed; for direct mode this prefixes them with
 * the resource name so the UI's PathInfo.fullPath matches. */
export async function dump(
  session: ConnectedSession,
): Promise<Record<string, Scalar>> {
  const resp = (await session.sensor.doCommand(
    Struct.fromJson({ command: "vt.dump" }),
  )) as Record<string, JsonValue>;
  const values = (resp?.values ?? {}) as Record<string, Scalar>;
  if (session.prefixWithSource) return values;
  const out: Record<string, Scalar> = {};
  for (const [k, v] of Object.entries(values)) {
    out[`${session.config.resource}.${k}`] = v;
  }
  return out;
}

/** Issue vt.set. For aggregator mode the full path is sent through; for
 * direct mode we strip the resource prefix. */
export async function setValue(
  session: ConnectedSession,
  info: PathInfo,
  value: Scalar,
): Promise<{ ok: boolean; error?: string; previous?: Scalar }> {
  const path = session.prefixWithSource
    ? `${info.source}.${info.localPath}`
    : info.localPath;
  const resp = (await session.sensor.doCommand(
    Struct.fromJson({ command: "vt.set", path, value: value as never }),
  )) as Record<string, JsonValue>;
  return {
    ok: Boolean(resp?.ok),
    error: typeof resp?.error === "string" ? resp.error : undefined,
    previous: resp?.previous as Scalar | undefined,
  };
}

export function disconnect(session: ConnectedSession | null): void {
  if (!session) return;
  try {
    session.client.disconnect();
  } catch {
    // ignore
  }
}
