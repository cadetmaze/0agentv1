<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchEntities } from '$lib/api';
  let entities: any[] = [];
  onMount(async () => { entities = await fetchEntities().catch(() => []); });
</script>
<h2>Entities</h2>
<div class="entity-list">
  {#each entities as entity}
    <div class="entity-card"><strong>{entity.label}</strong><span class="type">{entity.type}</span></div>
  {/each}
  {#if entities.length === 0}<p style="color:#666">No entities yet</p>{/if}
</div>
<style>.entity-list{display:flex;flex-direction:column;gap:0.5rem}.entity-card{background:var(--card);border:1px solid var(--border);padding:1rem;border-radius:4px;display:flex;justify-content:space-between}.type{color:#666;font-size:0.85rem}</style>
