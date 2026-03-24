<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchSubagents } from '$lib/api';
  let subagents: any[] = [];
  onMount(async () => { subagents = await fetchSubagents().catch(() => []); });
</script>
<h2>Active Subagents</h2>
{#if subagents.length === 0}<p style="color:#666">No active subagents</p>{:else}
  {#each subagents as sa}
    <div class="sa-card"><strong>{sa.id}</strong> — tools: {sa.tools?.join(', ')}</div>
  {/each}
{/if}
<style>.sa-card{background:var(--card);border:1px solid var(--border);padding:1rem;border-radius:4px;margin-bottom:0.5rem}</style>
