import { writable } from 'svelte/store';
export const graphNodes = writable<any[]>([]);
export const graphEdges = writable<any[]>([]);
