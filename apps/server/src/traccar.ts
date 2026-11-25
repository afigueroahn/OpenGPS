// Traccar API client. The platform uses it to add and remove
// authorized devices: Traccar ignores any device that is not in its list.
import type { Config } from "./config";
import { tr } from "./i18n";

export interface TraccarDevice {
  id: number;
  uniqueId: string;
  name: string;
}

export interface Traccar {
  /** Checks administration access; on a freshly installed Traccar, creates it. */
  bootstrap(): Promise<void>;
  /** Registers a device. If it already existed with that identifier, returns the existing one. */
  createDevice(uniqueId: string, name: string): Promise<TraccarDevice>;
  deleteDevice(id: number): Promise<void>;
  /** Commands the device accepts according to its protocol ("engineStop", "custom"…). Empty if unknown. */
  commandTypes(id: number): Promise<string[]>;
  /**
   * Sends a command to the device. It only arrives if the device is connected at that
   * moment: a command is never left waiting inside Traccar, because it
   * would arrive later, without knowing the vehicle's situation.
   */
  sendCommand(id: number, type: string, attributes?: Record<string, unknown>): Promise<void>;
}

export class TraccarError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "TraccarError";
  }
}

export function createTraccar(config: Config): Traccar {
  const { apiUrl, adminEmail, adminPassword } = config.traccar;
  const basic = `Basic ${Buffer.from(`${adminEmail}:${adminPassword}`).toString("base64")}`;

  async function call(method: string, path: string, body?: unknown, authenticated = true): Promise<Response> {
    try {
      return await fetch(`${apiUrl}${path}`, {
        method,
        headers: {
          Accept: "application/json",
          ...(authenticated ? { Authorization: basic } : {}),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      // It can end up in a command's note, which people read: the internal address and the network error stay in the log.
      console.error(`[traccar] no answer from ${apiUrl}:`, (err as Error).message);
      throw new TraccarError(tr(config.defaultLanguage, "api.traccar.unreachable")); // i18n: stored text
    }
  }

  async function findDevice(uniqueId: string): Promise<TraccarDevice | null> {
    const res = await call("GET", `/api/devices?uniqueId=${encodeURIComponent(uniqueId)}`);
    if (!res.ok) throw new TraccarError("Traccar refused the device lookup", res.status);
    const list = (await res.json()) as TraccarDevice[];
    return list.find((d) => d.uniqueId === uniqueId) ?? null;
  }

  return {
    async bootstrap() {
      const probe = await call("GET", "/api/devices?uniqueId=__comprobacion__");
      if (probe.ok) return;
      if (probe.status !== 401) throw new TraccarError("Traccar answered with an unexpected error", probe.status);

      // No access: on a new installation, the first registered user is the administrator.
      const created = await call("POST", "/api/users", { name: "Plataforma", email: adminEmail, password: adminPassword }, false);
      if (!created.ok) {
        throw new TraccarError(
          "Traccar's admin user is not valid and could not be created. Check TRACCAR_ADMIN_EMAIL and TRACCAR_ADMIN_PASSWORD.",
          created.status,
        );
      }
      const user = (await created.json()) as { administrator?: boolean };
      if (!user.administrator) throw new TraccarError("The user created in Traccar is not an administrator");
      console.log("[traccar] admin user created");
    },

    async createDevice(uniqueId, name) {
      const res = await call("POST", "/api/devices", { uniqueId, name });
      if (res.ok) return (await res.json()) as TraccarDevice;
      // Most likely it already exists: it is reused instead of failing.
      const existing = await findDevice(uniqueId);
      if (existing) return existing;
      throw new TraccarError("Traccar did not accept the device", res.status);
    },

    async deleteDevice(id) {
      const res = await call("DELETE", `/api/devices/${id}`);
      if (!res.ok && res.status !== 404) {
        // Traccar responds 400 when the device no longer exists.
        const stillThere = await call("GET", `/api/devices?id=${id}`);
        if (stillThere.ok && ((await stillThere.json()) as unknown[]).length === 0) return;
        throw new TraccarError("Traccar did not accept removing the device", res.status);
      }
    },

    async commandTypes(id) {
      const res = await call("GET", `/api/commands/types?deviceId=${id}`);
      if (!res.ok) return [];
      return ((await res.json()) as { type: string }[]).map((t) => t.type);
    },

    async sendCommand(id, type, attributes = {}) {
      const status = await call("GET", `/api/devices?id=${id}`);
      const device = status.ok ? ((await status.json()) as { status?: string }[])[0] : undefined;
      // What fails here ends up in the command's note, which people read.
      if (device?.status !== "online") throw new TraccarError(tr(config.defaultLanguage, "api.traccar.offline")); // i18n: stored text
      // `noQueue`: if there is no connection to the device right now, Traccar rejects the
      // command instead of saving it to deliver when the device comes back.
      const res = await call("POST", "/api/commands/send", { deviceId: id, type, attributes: { ...attributes, noQueue: true } });
      if (res.status !== 200) throw new TraccarError(tr(config.defaultLanguage, "api.traccar.offline"), res.status); // i18n: stored text
    },
  };
}
