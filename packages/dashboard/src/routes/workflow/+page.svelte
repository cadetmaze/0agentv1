<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchGraphNodes, fetchGraphEdges } from '$lib/api';
  import * as d3 from 'd3';
  let svgEl: SVGSVGElement;
  onMount(async () => {
    const allNodes = await fetchGraphNodes({ limit: 200 }).catch(() => []);
    const allEdges = await fetchGraphEdges().catch(() => []);
    const skillNodes = allNodes.filter((n: any) => n.metadata?.is_skill);
    if (!skillNodes.length) return;
    const skillIds = new Set(skillNodes.map((n: any) => n.id));
    const edges = allEdges.filter((e: any) => skillIds.has(e.from_node) && skillIds.has(e.to_node));
    const width = svgEl.clientWidth, height = 500;
    const svg = d3.select(svgEl).attr('viewBox', `0 0 ${width} ${height}`);
    svg.append('defs').append('marker').attr('id', 'arrowhead').attr('viewBox', '0 -5 10 10').attr('refX', 20).attr('refY', 0).attr('markerWidth', 6).attr('markerHeight', 6).attr('orient', 'auto').append('path').attr('d', 'M0,-5L10,0L0,5').attr('fill', '#666');
    const links = edges.map((e: any) => ({ source: e.from_node, target: e.to_node, weight: e.weight ?? 0.5 }));
    const sim = d3.forceSimulation(skillNodes).force('link', d3.forceLink(links).id((d: any) => d.id).distance(120)).force('charge', d3.forceManyBody().strength(-300)).force('center', d3.forceCenter(width / 2, height / 2));
    const link = svg.append('g').selectAll('line').data(links).join('line').attr('stroke', '#555').attr('stroke-width', (d: any) => Math.max(1, d.weight * 4)).attr('marker-end', 'url(#arrowhead)');
    const node = svg.append('g').selectAll('circle').data(skillNodes).join('circle').attr('r', 12).attr('fill', '#4f9cf9').attr('stroke', '#fff').attr('stroke-width', 1.5);
    const label = svg.append('g').selectAll('text').data(skillNodes).join('text').text((d: any) => `/${d.label}`).attr('font-size', 11).attr('fill', '#ddd').attr('text-anchor', 'middle').attr('dy', -18);
    sim.on('tick', () => { link.attr('x1', (d: any) => d.source.x).attr('y1', (d: any) => d.source.y).attr('x2', (d: any) => d.target.x).attr('y2', (d: any) => d.target.y); node.attr('cx', (d: any) => d.x).attr('cy', (d: any) => d.y); label.attr('x', (d: any) => d.x).attr('y', (d: any) => d.y); });
  });
</script>
<h2>Sprint Workflow</h2>
<p style="color:#666;margin-bottom:1rem">Edge thickness = learned weight. Thicker edges = stronger learned preference.</p>
<svg bind:this={svgEl} width="100%" height="500" style="background:var(--card);border:1px solid var(--border);border-radius:4px" />
