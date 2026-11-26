// Live channel. Keeps a WebSocket open and applies changes to the in-memory
// vehicle list. If it drops, it reconnects on its own and requests the full
// list again, so nothing is left out of date. Same messages as the web app's
// (apps/web/src/lib/live.ts).
import type { LiveMessage, Vehicle, VehicleEvent } from "@opengps/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { liveUrl } from "./address";
import { getSaved } from "./storage";

export type LiveStatus = "connecting" | "online" | "offline";

const MIN_RETRY_MS = 1000;
const MAX_RETRY_MS = 15_000;
/** The platform closes with this code when the person's access changed. */
const ACCESS_CHANGED = 4001;

/** React Native's WebSocket takes headers as a third argument: the session cookie goes there. */
type NativeWebSocket = new (url: string, protocols: string | string[] | undefined, options: { headers: Record<string, string> }) => WebSocket;

export function useLive(enabled: boolean, onEvent?: (event: VehicleEvent) => void): LiveStatus {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>("connecting");
  // The effect lives as long as the screen does; the event callback is always read in its latest version.
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!enabled) return;
    let socket: WebSocket | null = null;
    let retry = MIN_RETRY_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      if (closed) return;
      const { server, cookie } = getSaved();
      if (!server || !cookie) return;
      setStatus((s) => (s === "online" ? "connecting" : s));
      socket = new (WebSocket as unknown as NativeWebSocket)(liveUrl(server), undefined, { headers: { Cookie: cookie } });

      socket.onopen = () => {
        retry = MIN_RETRY_MS;
        setStatus("online");
        // On connecting or reconnecting, the full list is requested.
        void queryClient.invalidateQueries({ queryKey: ["vehicles"] });
      };

      socket.onmessage = (event) => {
        let message: LiveMessage;
        try {
          message = JSON.parse(String(event.data)) as LiveMessage;
        } catch {
          return;
        }
        if (message.type === "position") {
          queryClient.setQueryData<Vehicle[]>(["vehicles"], (list) =>
            list?.map((v) => (v.id === message.vehicleId ? { ...v, state: message.state } : v)),
          );
        } else if (message.type === "device") {
          queryClient.setQueryData<Vehicle[]>(["vehicles"], (list) =>
            list?.map((v) => (v.id === message.vehicleId ? { ...v, device: message.device, state: message.device ? v.state : null } : v)),
          );
        } else if (message.type === "vehicles_changed") {
          void queryClient.invalidateQueries({ queryKey: ["vehicles"] });
          void queryClient.invalidateQueries({ queryKey: ["groups"] });
        } else if (message.type === "incidents_changed") {
          void queryClient.invalidateQueries({ queryKey: ["incidents"] });
        } else if (message.type === "drivers_changed") {
          void queryClient.invalidateQueries({ queryKey: ["drivers"] });
          void queryClient.invalidateQueries({ queryKey: ["vehicle-driver"] });
        } else if (message.type === "security_changed") {
          void queryClient.invalidateQueries({ queryKey: ["security", message.vehicleId] });
        } else if (message.type === "event") {
          void queryClient.invalidateQueries({ queryKey: ["events"] });
          onEventRef.current?.(message.event);
        }
      };

      socket.onclose = (event) => {
        if (closed) return;
        setStatus("offline");
        // The session may have ended, or the person's access changed: this is checked before retrying.
        void queryClient.invalidateQueries({ queryKey: ["me"] });
        if (event.code === ACCESS_CHANGED) void queryClient.invalidateQueries({ queryKey: ["vehicles"] });
        timer = setTimeout(connect, retry);
        retry = Math.min(retry * 2, MAX_RETRY_MS);
      };
    };

    connect();
    // Coming back to the app, if the channel is down it reconnects immediately.
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && (socket === null || socket.readyState === WebSocket.CLOSED)) {
        if (timer) clearTimeout(timer);
        retry = MIN_RETRY_MS;
        connect();
      }
    });

    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      subscription.remove();
      socket?.close();
    };
  }, [queryClient, enabled]);

  return status;
}
