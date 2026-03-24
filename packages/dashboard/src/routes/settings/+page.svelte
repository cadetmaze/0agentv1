<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchHealth } from '$lib/api';
  let health: any = null;
  onMount(async () => { health = await fetchHealth().catch(() => null); });
</script>
<h2>Settings</h2>
{#if health}
  <div class="info"><p>Version: {health.version}</p><p>Uptime: {Math.round((health.uptime_ms ?? 0) / 1000)}s</p><p>Graph: {health.graph_nodes} nodes, {health.graph_edges} edges</p><p>Sandbox: {health.sandbox_backend}</p><p>MCP servers: {health.mcp_servers_connected}</p></div>
{:else}<p style="color:#666">Loading...</p>{/if}
<style>.info{background:var(--card);border:1px solid var(--border);padding:1.5rem;border-radius:4px}.info p{margin:0.5rem 0;color:#aaa}</style>
