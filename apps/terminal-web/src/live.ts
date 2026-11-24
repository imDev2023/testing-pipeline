"use client";

// Adapted from Top-pad b833a7b, apps/web/src/components/coin/useLiveRoom.ts; owned here since.
// A live room's events (docs/spec/pipescope-architecture.md, Live rooms), over a WebSocket that
// joins again on its own, waiting LIVE_RECONNECT_FIRST_MS, then twice as long each time up to LIVE_RECONNECT_MAX_MS. `onOpen` runs
// on every connection, the first included, so a page resyncs through the API from the last trade it
// saw: whatever landed while it was away, or between its first read and the room.
import { useEffect, useRef } from "react";
import { LiveMessage, type LiveEvent } from "terminal-api/contract";
import { API_URL, LIVE_RECONNECT_FIRST_MS, LIVE_RECONNECT_MAX_MS } from "./config";

/** A live room's address: the API's, over WebSocket. */
export const liveUrl = (path: string) => `${API_URL.replace(/^http/, "ws")}${path}`;

export const LIVE_ROOMS = {
  feed: "/v1/live/feed",
  market: (address: string) => `/v1/live/markets/${encodeURIComponent(address)}`,
};

/** Joins a live room for as long as the page is open, handing on each message's events. */
export function useLiveRoom(path: string, handlers: { onEvents: (events: LiveEvent[]) => void; onOpen: () => void }): void {
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let stopped = false;
    const open = () => {
      socket = new WebSocket(liveUrl(path));
      socket.onopen = () => {
        attempts = 0;
        latest.current.onOpen();
      };
      socket.onmessage = (event) => {
        try {
          const message = LiveMessage.safeParse(JSON.parse(String(event.data)));
          if (message.success) latest.current.onEvents(message.data.events);
        } catch {
          // Not a message of the room's: nothing to show.
        }
      };
      socket.onclose = () => {
        if (stopped) return;
        retry = setTimeout(open, Math.min(LIVE_RECONNECT_FIRST_MS * 2 ** attempts++, LIVE_RECONNECT_MAX_MS));
      };
    };
    open();
    return () => {
      stopped = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, [path]);
}
