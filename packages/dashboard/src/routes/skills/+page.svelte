<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchSkills } from '$lib/api';
  let skillList: any[] = [];
  onMount(async () => { skillList = await fetchSkills().catch(() => []); });
</script>
<h2>Skills</h2>
<div class="skill-list">
  {#each skillList as skill}
    <a href="/skills/{skill.name}" class="skill-card">
      <span class="name">/{skill.name}</span>
      <span class="category">{skill.category}</span>
      <span class="desc">{skill.description}</span>
    </a>
  {/each}
</div>
<style>.skill-list{display:flex;flex-direction:column;gap:0.5rem}.skill-card{background:var(--card);border:1px solid var(--border);padding:1rem;border-radius:4px;display:flex;gap:1rem;text-decoration:none;color:var(--fg)}.skill-card:hover{border-color:var(--accent)}.name{color:var(--accent);font-weight:bold;min-width:120px}.category{color:#666;font-size:0.85rem;min-width:60px}.desc{flex:1;color:#aaa}</style>
