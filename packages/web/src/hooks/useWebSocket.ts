import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

interface WebSocketMessage {
  type: string;
  payload: any;
  id?: string;
  timestamp?: number;
}

interface UseWebSocketOptions {
  url?: string;
  channels?: ('nodes' | 'jobs')[];
  enabled?: boolean;
}

// Singleton WebSocket connection
let sharedWebSocket: WebSocket | null = null;
let connectionCount = 0;
let reconnectTimeout: NodeJS.Timeout | null = null;
const subscribers = new Set<(message: WebSocketMessage) => void>();

function getWebSocketUrl(): string {
  // Use the same host as the page, but with the backend port
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.hostname}:8101/ws`;
}

function connectWebSocket(url: string, queryClient: ReturnType<typeof useQueryClient>): WebSocket | null {
  if (sharedWebSocket?.readyState === WebSocket.OPEN) {
    return sharedWebSocket;
  }

  if (sharedWebSocket?.readyState === WebSocket.CONNECTING) {
    return sharedWebSocket;
  }

  try {
    sharedWebSocket = new WebSocket(url);

    sharedWebSocket.onopen = () => {
      console.log('[WebSocket] Connected');
      // Subscribe to all channels
      const subscribeMessage: WebSocketMessage = {
        type: 'WEB_SUBSCRIBE',
        payload: { channels: ['nodes', 'jobs'] },
      };
      sharedWebSocket?.send(JSON.stringify(subscribeMessage));
    };

    sharedWebSocket.onmessage = (event) => {
      try {
        const message: WebSocketMessage = JSON.parse(event.data);

        switch (message.type) {
          case 'WEB_NODES_UPDATE':
            console.log('[WebSocket] NODES_UPDATE received:', message.payload.nodes?.[0]?.system_info?.gpus);
            // Force update the cache and trigger re-render
            queryClient.setQueryData(['nodes'], message.payload.nodes);
            // Also invalidate to ensure fresh data
            queryClient.invalidateQueries({ queryKey: ['nodes'] });
            break;

          case 'WEB_JOBS_UPDATE':
            queryClient.setQueryData(['jobs'], message.payload.jobs);
            queryClient.invalidateQueries({ queryKey: ['library-files'] });
            break;

          case 'ACK':
            console.debug('[WebSocket] ACK:', message.payload);
            break;

          case 'ERROR':
            console.error('[WebSocket] Error:', message.payload);
            break;

          default:
            console.debug('[WebSocket] Unknown message type:', message.type);
            break;
        }

        // Notify all subscribers
        subscribers.forEach(callback => callback(message));
      } catch (error) {
        console.error('[WebSocket] Failed to parse message:', error);
      }
    };

    sharedWebSocket.onclose = () => {
      console.log('[WebSocket] Disconnected');
      sharedWebSocket = null;

      // Attempt to reconnect after 3 seconds if there are still subscribers
      if (subscribers.size > 0) {
        reconnectTimeout = setTimeout(() => {
          if (subscribers.size > 0) {
            connectWebSocket(url, queryClient);
          }
        }, 3000);
      }
    };

    sharedWebSocket.onerror = (error) => {
      console.error('[WebSocket] Error:', error);
    };

    return sharedWebSocket;
  } catch (error) {
    console.error('[WebSocket] Failed to connect:', error);
    return null;
  }
}

function disconnectWebSocket() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  if (sharedWebSocket) {
    sharedWebSocket.close();
    sharedWebSocket = null;
  }
}

export function useWebSocket(options: UseWebSocketOptions = {}) {
  const { enabled = true } = options;
  const queryClient = useQueryClient();
  const [isConnected, setIsConnected] = useState(false);
  const callbackRef = useRef<(message: WebSocketMessage) => void>();

  useEffect(() => {
    if (!enabled) return;

    connectionCount++;

    // Create a callback for this subscriber
    const callback = (message: WebSocketMessage) => {
      if (message.type === 'WEB_NODES_UPDATE' || message.type === 'WEB_JOBS_UPDATE') {
        setIsConnected(true);
      }
    };
    callbackRef.current = callback;
    subscribers.add(callback);

    // Connect if not already connected
    const url = getWebSocketUrl();
    const ws = connectWebSocket(url, queryClient);
    if (ws) {
      setIsConnected(ws.readyState === WebSocket.OPEN);
    }

    // Check connection status periodically
    const checkInterval = setInterval(() => {
      if (sharedWebSocket?.readyState === WebSocket.OPEN) {
        setIsConnected(true);
      } else {
        setIsConnected(false);
      }
    }, 1000);

    return () => {
      connectionCount--;
      subscribers.delete(callback);

      // Only disconnect if no more subscribers
      if (connectionCount === 0) {
        disconnectWebSocket();
      }

      clearInterval(checkInterval);
    };
  }, [enabled, queryClient]);

  return { isConnected };
}
