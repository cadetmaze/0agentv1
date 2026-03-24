<script lang="ts">
  import { onMount } from 'svelte';
  import { connectWS, wsStatus } from '$lib/stores/ws';
  onMount(() => { connectWS(); });
  const navItems = [
    { href: '/', label: 'Sessions' },
    { href: '/graph', label: 'Graph' },
    { href: '/traces', label: 'Traces' },
    { href: '/entities', label: 'Entities' },
    { href: '/skills', label: 'Skills' },
    { href: '/workflow', label: 'Workflow' },
    { href: '/subagents', label: 'Subagents' },
    { href: '/settings', label: 'Settings' },
  ];
</script>
<div class="layout">
  <nav class="sidebar">
    <h1 class="logo">0agent</h1>
    <div class="ws-status" class:connected={$wsStatus === 'connected'}>{$wsStatus}</div>
    {#each navItems as item}
      <a href={item.href}>{item.label}</a>
    {/each}
  </nav>
  <main class="content"><slot /></main>
</div>
<style>
  .layout { display: flex; min-height: 100vh; }
  .sidebar { width: 200px; background: var(--card); border-right: 1px solid var(--border); padding: 1rem; display: flex; flex-direction: column; gap: 0.5rem; }
  .logo { color: var(--accent); font-size: 1.5rem; margin-bottom: 1rem; }
  .ws-status { font-size: 0.75rem; color: #666; margin-bottom: 1rem; }
  .ws-status.connected { color: #2ecc71; }
  .sidebar a { color: var(--fg); text-decoration: none; padding: 0.5rem; border-radius: 4px; }
  .sidebar a:hover { background: var(--border); }
  .content { flex: 1; padding: 2rem; overflow-y: auto; }
</style>
