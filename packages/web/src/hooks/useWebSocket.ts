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
  channels?: ('nodes' | 'jobs' | 'library')[];
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
    const socket = new WebSocket(url);
    sharedWebSocket = socket;

    socket.onopen = () => {
      // Subscribe to all channels
      const subscribeMessage: WebSocketMessage = {
        type: 'WEB_SUBSCRIBE',
        payload: { channels: ['nodes', 'jobs', 'library'] },
      };
      socket.send(JSON.stringify(subscribeMessage));
    };

    socket.onmessage = (event) => {
      try {
        const message: WebSocketMessage = JSON.parse(event.data);

        switch (message.type) {
          case 'WEB_NODES_UPDATE':
            // Only update the data, don't invalidate to prevent API refetches
            queryClient.setQueryData(['nodes'], message.payload.nodes);
            break;

          case 'WEB_JOBS_UPDATE': {
            const nextJobs = message.payload.jobs || [];
            const previousJobs = queryClient.getQueryData<any[]>(['jobs']) || [];
            const previousOperations = new Map(previousJobs
              .filter(job => job.file_operation)
              .map(job => [job.id, `${job.status}:${job.progress}:${job.current_action || ''}`]));
            const nextOperations = nextJobs.filter((job: any) => job.file_operation);
            const storageOperationChanged = previousOperations.size !== nextOperations.length
              || nextOperations.some((job: any) => previousOperations.get(job.id) !== `${job.status}:${job.progress}:${job.current_action || ''}`);
            queryClient.setQueryData(['jobs'], nextJobs);
            if (storageOperationChanged) {
              queryClient.invalidateQueries({ queryKey: ['storage-reclaims'] });
              queryClient.invalidateQueries({ queryKey: ['stats'] });
            }
            // Update library files status based on job data
            queryClient.invalidateQueries({ queryKey: ['library-files'] });
            queryClient.invalidateQueries({ queryKey: ['files'] });
            break;
          }

          case 'WEB_LIBRARY_SCAN_UPDATE': {
            const progress = message.payload;
            queryClient.setQueryData(['library-scans'], (current: Record<string, any> = {}) => ({
              ...current,
              [progress.library_id]: progress,
            }));
            queryClient.setQueryData(['libraries'], (current: any[] | undefined) =>
              current?.map(library => library.id === progress.library_id
                ? { ...library, file_count: progress.file_count }
                : library),
            );
            if (progress.status === 'completed') {
              queryClient.invalidateQueries({ queryKey: ['library-files', progress.library_id] });
            }
            break;
          }

          case 'ACK':
          case 'ERROR':
          default:
            break;
        }

        // Notify all subscribers
        subscribers.forEach(callback => callback(message));
      } catch {}
    };

    socket.onclose = () => {
      // An older socket may close after a replacement has already connected.
      // Never clear or reconnect over the newer singleton.
      if (sharedWebSocket !== socket) return;
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

    socket.onerror = () => {};

    return socket;
  } catch {
    return null;
  }
}

function disconnectWebSocket() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  if (sharedWebSocket) {
    const socket = sharedWebSocket;
    sharedWebSocket = null;
    socket.close();
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
      if (
        message.type === 'WEB_NODES_UPDATE'
        || message.type === 'WEB_JOBS_UPDATE'
        || message.type === 'WEB_LIBRARY_SCAN_UPDATE'
      ) {
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
