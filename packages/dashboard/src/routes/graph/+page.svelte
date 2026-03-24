<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchGraphNodes, fetchGraphEdges } from '$lib/api';
  import * as d3 from 'd3';
  let svgEl: SVGSVGElement;
  const COLOR_MAP: Record<string, string> = {
    entity: '#4f9cf9', context: '#7bc67e', strategy: '#f5a623', plan: '#9b59b6',
    step: '#e74c3c', outcome: '#2ecc71', signal: '#f39c12', tool: '#1abc9c',
    constraint: '#95a5a6', hypothesis: '#e67e22',
  };
  onMount(async () => {
    const nodes = await fetchGraphNodes({ limit: 100 }).catch(() => []);
    const edges = await fetchGraphEdges().catch(() => []);
    if (!nodes.length) return;
    const width = svgEl.clientWidth, height = 600;
    const svg = d3.select(svgEl).attr('viewBox', `0 0 ${width} ${height}`);
    const nodeMap = new Map(nodes.map((n: any) => [n.id, n]));
    const links = edges.filter((e: any) => nodeMap.has(e.from_node) && nodeMap.has(e.to_node)).map((e: any) => ({ source: e.from_node, target: e.to_node, weight: e.weight ?? 0.5 }));
    const sim = d3.forceSimulation(nodes).force('link', d3.forceLink(links).id((d: any) => d.id).distance(80)).force('charge', d3.forceManyBody().strength(-200)).force('center', d3.forceCenter(width / 2, height / 2));
    const link = svg.append('g').selectAll('line').data(links).join('line').attr('stroke', '#333').attr('stroke-width', (d: any) => d.weight * 3);
    const node = svg.append('g').selectAll('circle').data(nodes).join('circle').attr('r', 8).attr('fill', (d: any) => COLOR_MAP[d.type] ?? '#666').call(d3.drag<SVGCircleElement, any>().on('start', (e, d: any) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; }).on('drag', (e, d: any) => { d.fx = e.x; d.fy = e.y; }).on('end', (e, d: any) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }) as any);
    const label = svg.append('g').selectAll('text').data(nodes).join('text').text((d: any) => d.label).attr('font-size', 10).attr('fill', '#aaa').attr('dx', 12).attr('dy', 4);
    sim.on('tick', () => { link.attr('x1', (d: any) => d.source.x).attr('y1', (d: any) => d.source.y).attr('x2', (d: any) => d.target.x).attr('y2', (d: any) => d.target.y); node.attr('cx', (d: any) => d.x).attr('cy', (d: any) => d.y); label.attr('x', (d: any) => d.x).attr('y', (d: any) => d.y); });
  });
</script>
<h2>Knowledge Graph</h2>
<svg bind:this={svgEl} width="100%" height="600" style="background: var(--card); border: 1px solid var(--border); border-radius: 4px;" />
