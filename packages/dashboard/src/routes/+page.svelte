<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchSessions, createSession } from '$lib/api';
  let sessionList: any[] = [];
  let taskInput = '';
  let loading = false;
  onMount(async () => { sessionList = await fetchSessions().catch(() => []); });
  async function submitTask() {
    if (!taskInput.trim()) return;
    loading = true;
    try { const result = await createSession(taskInput); sessionList = [result, ...sessionList]; taskInput = ''; } catch (e) { console.error(e); }
    loading = false;
  }
</script>
<h2>Sessions</h2>
<form on:submit|preventDefault={submitTask} class="task-form">
  <input bind:value={taskInput} placeholder="Enter a task..." disabled={loading} />
  <button type="submit" disabled={loading}>{loading ? 'Running...' : 'Run'}</button>
</form>
<div class="session-list">
  {#each sessionList as session}
    <div class="session-card">
      <span class="status" class:completed={session.status === 'completed'} class:failed={session.status === 'failed'}>{session.status}</span>
      <span class="task">{session.task}</span>
    </div>
  {/each}
  {#if sessionList.length === 0}<p class="empty">No sessions yet</p>{/if}
</div>
<style>
  .task-form { display: flex; gap: 0.5rem; margin-bottom: 2rem; }
  .task-form input { flex: 1; padding: 0.75rem; background: var(--card); border: 1px solid var(--border); color: var(--fg); border-radius: 4px; }
  .task-form button { padding: 0.75rem 1.5rem; background: var(--accent); color: white; border: none; border-radius: 4px; cursor: pointer; }
  .session-list { display: flex; flex-direction: column; gap: 0.5rem; }
  .session-card { background: var(--card); border: 1px solid var(--border); padding: 1rem; border-radius: 4px; display: flex; gap: 1rem; align-items: center; }
  .status { font-size: 0.75rem; padding: 2px 8px; border-radius: 4px; background: var(--border); }
  .status.completed { background: #1a4a2a; color: #2ecc71; }
  .status.failed { background: #4a1a1a; color: #e74c3c; }
  .task { flex: 1; }
  .empty { color: #666; }
</style>
