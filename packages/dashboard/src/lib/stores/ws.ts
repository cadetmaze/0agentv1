import { writable } from 'svelte/store';
export type DaemonEvent = { type: string; [key: string]: unknown };
export const wsStatus = writable<'connecting' | 'connected' | 'disconnected'>('disconnected');
export const lastEvent = writable<DaemonEvent | null>(null);
export const graphEvents = writable<DaemonEvent[]>([]);
let ws: WebSocket | null = null;
export function connectWS() {
  const url = `ws://${window.location.host}/ws`;
  ws = new WebSocket(url);
  wsStatus.set('connecting');
  ws.onopen = () => { wsStatus.set('connected'); ws!.send(JSON.stringify({ type: 'subscribe', topics: ['sessions', 'graph', 'subagents', 'skills', 'stats'] })); };
  ws.onmessage = (e) => { const event = JSON.parse(e.data); lastEvent.set(event); if (event.type?.startsWith('graph.')) graphEvents.update(evts => [...evts.slice(-99), event]); };
  ws.onclose = () => { wsStatus.set('disconnected'); setTimeout(connectWS, 3000); };
  ws.onerror = () => { ws?.close(); };
}
export function disconnectWS() { ws?.close(); ws = null; }
