<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchTraces } from '$lib/api';
  let traces: any[] = [];
  onMount(async () => { traces = await fetchTraces({ limit: 50 }).catch(() => []); });
  function signalColor(s: number | null) { if (s === null) return '#666'; return s > 0 ? '#2ecc71' : s < 0 ? '#e74c3c' : '#f39c12'; }
</script>
<h2>Traces</h2>
<div class="trace-list">
  {#each traces as trace}
    <div class="trace-card">
      <span class="signal" style="color: {signalColor(trace.outcome_signal)}">{trace.outcome_signal?.toFixed(2) ?? 'pending'}</span>
      <span class="input">{trace.input?.slice(0, 80)}</span>
      <span class="meta">{new Date(trace.created_at).toLocaleString()}</span>
      {#if trace.metadata?.skill_name}<span class="skill-badge">/{trace.metadata.skill_name}</span>{/if}
    </div>
  {/each}
  {#if traces.length === 0}<p style="color:#666">No traces yet</p>{/if}
</div>
<style>
  .trace-list { display: flex; flex-direction: column; gap: 0.5rem; }
  .trace-card { background: var(--card); border: 1px solid var(--border); padding: 1rem; border-radius: 4px; display: flex; gap: 1rem; align-items: center; }
  .signal { font-weight: bold; min-width: 50px; }
  .input { flex: 1; }
  .meta { font-size: 0.75rem; color: #666; }
  .skill-badge { font-size: 0.7rem; padding: 2px 6px; background: var(--accent); color: white; border-radius: 4px; }
</style>
