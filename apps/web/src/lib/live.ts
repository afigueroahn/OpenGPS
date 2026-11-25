// Live channel. Keeps a WebSocket open and applies changes to the
// in-memory vehicle list. If it drops, it reconnects on its own and requests
// the full list again, so nothing is left out of date.
import type { LiveMessage, Vehicle, VehicleEvent } from "@opengps/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

export type LiveStatus = "connecting" | "online" | "offline";

const MIN_RETRY_MS = 1000;
const MAX_RETRY_MS = 15_000;

export function useLive(
  enabled: boolean,
  onPosition?: (vehicleId: string, message: Extract<LiveMessage, { type: "position" }>) => void,
  onEvent?: (event: VehicleEvent) => void,
): LiveStatus {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>("connecting");
  // The effect lives as long as the screen does; the notification callback is always read in its latest version.
  const onPositionRef = useRef(onPosition);
  onPositionRef.current = onPosition;
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
      setStatus((s) => (s === "online" ? "connecting" : s));
      socket = new WebSocket(`${location.origin.replace(/^http/, "ws")}/api/live`);

      socket.onopen = () => {
        retry = MIN_RETRY_MS;
        setStatus("online");
        // On connecting or reconnecting, the full list is requested.
        void queryClient.invalidateQueries({ queryKey: ["vehicles"] });
        void queryClient.invalidateQueries({ queryKey: ["geofences"] });
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
          onPositionRef.current?.(message.vehicleId, message);
        } else if (message.type === "device") {
          queryClient.setQueryData<Vehicle[]>(["vehicles"], (list) =>
            list?.map((v) => (v.id === message.vehicleId ? { ...v, device: message.device, state: message.device ? v.state : null } : v)),
          );
        } else if (message.type === "vehicles_changed") {
          void queryClient.invalidateQueries({ queryKey: ["vehicles"] });
          void queryClient.invalidateQueries({ queryKey: ["groups"] });
        } else if (message.type === "geofences_changed") {
          void queryClient.invalidateQueries({ queryKey: ["geofences"] });
        } else if (message.type === "incidents_changed") {
          void queryClient.invalidateQueries({ queryKey: ["incidents"] });
        } else if (message.type === "security_changed") {
          void queryClient.invalidateQueries({ queryKey: ["security", message.vehicleId] });
        } else if (message.type === "drivers_changed") {
          void queryClient.invalidateQueries({ queryKey: ["drivers"] });
          void queryClient.invalidateQueries({ queryKey: ["vehicle-driver"] });
        } else if (message.type === "event") {
          // An event changes the event list and how many vehicles are inside each geofence.
          void queryClient.invalidateQueries({ queryKey: ["events"] });
          void queryClient.invalidateQueries({ queryKey: ["geofences"] });
          onEventRef.current?.(message.event);
        }
      };

      socket.onclose = () => {
        if (closed) return;
        setStatus("offline");
        // The session may have ended: this is checked before retrying.
        void queryClient.invalidateQueries({ queryKey: ["me"] });
        timer = setTimeout(connect, retry);
        retry = Math.min(retry * 2, MAX_RETRY_MS);
      };
    };

    connect();
    const wake = () => {
      // When returning to the tab, if the channel is down it reconnects immediately.
      if (document.visibilityState === "visible" && socket?.readyState === WebSocket.CLOSED) {
        if (timer) clearTimeout(timer);
        retry = MIN_RETRY_MS;
        connect();
      }
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);

    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      socket?.close();
    };
  }, [queryClient, enabled]);

  return status;
}
