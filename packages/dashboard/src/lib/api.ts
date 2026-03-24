const BASE = '';  // same origin in production, proxied in dev

export async function fetchHealth() { return fetch(`${BASE}/api/health`).then(r => r.json()); }
export async function fetchSessions() { return fetch(`${BASE}/api/sessions`).then(r => r.json()); }
export async function fetchSession(id: string) { return fetch(`${BASE}/api/sessions/${id}`).then(r => r.json()); }
export async function createSession(task: string, skill?: string) {
  return fetch(`${BASE}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task, skill }) }).then(r => r.json());
}
export async function fetchGraphNodes(opts?: { type?: string; limit?: number }) {
  const params = new URLSearchParams();
  if (opts?.type) params.set('type', opts.type);
  if (opts?.limit) params.set('limit', String(opts.limit));
  return fetch(`${BASE}/api/graph/nodes?${params}`).then(r => r.json());
}
export async function fetchGraphEdges(opts?: { from_node?: string }) {
  const params = new URLSearchParams();
  if (opts?.from_node) params.set('from_node', opts.from_node);
  return fetch(`${BASE}/api/graph/edges?${params}`).then(r => r.json());
}
export async function fetchEntities() { return fetch(`${BASE}/api/entities`).then(r => r.json()); }
export async function fetchEntity(id: string) { return fetch(`${BASE}/api/entities/${id}`).then(r => r.json()); }
export async function fetchTraces(opts?: { limit?: number; skill?: string }) {
  const params = new URLSearchParams();
  if (opts?.limit) params.set('limit', String(opts.limit));
  return fetch(`${BASE}/api/traces?${params}`).then(r => r.json());
}
export async function fetchSkills() { return fetch(`${BASE}/api/skills`).then(r => r.json()); }
export async function fetchSkill(name: string) { return fetch(`${BASE}/api/skills/${name}`).then(r => r.json()); }
export async function fetchSubagents() { return fetch(`${BASE}/api/subagents`).then(r => r.json()); }
