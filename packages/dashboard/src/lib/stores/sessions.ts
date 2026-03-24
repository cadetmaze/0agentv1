import { writable } from 'svelte/store';
export const sessions = writable<any[]>([]);
export const activeSessions = writable<number>(0);
