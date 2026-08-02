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

function logJobOrchestration(message: WebSocketMessage) {
  const receivedAt = new Date().toISOString();
  const debugLog = ((window as any).__encorrOrchestrationLog ||= []);
  if (message.type === 'WEB_JOBS_UPDATE') {
    const jobs = message.payload.jobs || [];
    const counts = jobs.reduce((result: Record<string, number>, job: any) => {
      result[job.status] = (result[job.status] || 0) + 1;
      return result;
    }, {});
    const active = jobs
      .filter((job: any) => job.status === 'assigned' || job.status === 'processing')
      .map((job: any) => ({
        id: job.id,
        status: job.status,
        file: job.file_name,
        action: job.current_action,
        progress: job.progress,
        node: job.node_name || job.node_id,
      }));
    const entry = { type: 'jobs', receivedAt, counts, activeCount: active.length, active };
    debugLog.push(entry);
    console.log(`[Encorr Jobs] ${receivedAt} active=${active.length}`, JSON.stringify(entry));
  }

  if (message.type === 'WEB_NODES_UPDATE') {
    const nodes = (message.payload.nodes || []).map((node: any) => ({
      node: node.name,
      status: node.status,
      cpuWorkers: node.max_workers?.cpu || 0,
      cpuUsage: node.cpu_usage,
      activeCount: node.active_jobs?.length || 0,
      active: (node.active_jobs || []).map((job: any) => ({
        id: job.id,
        file: job.file_name,
        action: job.current_action,
        progress: job.progress,
      })),
    }));
    const nodeActiveCount = nodes.reduce((sum: number, node: any) => sum + node.activeCount, 0);
    const entry = { type: 'nodes', receivedAt, nodeActiveCount, nodes };
    debugLog.push(entry);
    console.log(`[Encorr Nodes] ${receivedAt} nodeActive=${nodeActiveCount}`, JSON.stringify(entry));
  }
  if (debugLog.length > 1000) debugLog.splice(0, debugLog.length - 1000);
}

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
      console.log('[WebSocket] Connected');
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
        logJobOrchestration(message);

        switch (message.type) {
          case 'WEB_NODES_UPDATE':
            // Only update the data, don't invalidate to prevent API refetches
            queryClient.setQueryData(['nodes'], message.payload.nodes);
            break;

          case 'WEB_JOBS_UPDATE':
            queryClient.setQueryData(['jobs'], message.payload.jobs);
            // Update library files status based on job data
            queryClient.invalidateQueries({ queryKey: ['library-files'] });
            queryClient.invalidateQueries({ queryKey: ['files'] });
            break;

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

    socket.onclose = () => {
      console.log('[WebSocket] Disconnected');
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

    socket.onerror = (error) => {
      console.error('[WebSocket] Error:', error);
    };

    return socket;
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
