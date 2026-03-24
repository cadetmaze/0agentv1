import { Hono } from 'hono';
import type { RuntimeSelfHeal } from '../RuntimeSelfHeal.js';
import type { HealProposal } from '../RuntimeSelfHeal.js';

// Store pending proposals by ID (they expire after 10 minutes)
const pendingProposals = new Map<string, { proposal: HealProposal; expires: number }>();

export function runtimeRoutes(deps: { healer: RuntimeSelfHeal | null }): Hono {
  const app = new Hono();

  // Store a proposal for later approval
  app.post('/proposals', async (c) => {
    const proposal = await c.req.json() as HealProposal;
    pendingProposals.set(proposal.proposal_id, {
      proposal,
      expires: Date.now() + 10 * 60_000,
    });
    return c.json({ ok: true, proposal_id: proposal.proposal_id });
  });

  // Human approves a proposal — apply the patch
  app.post('/proposals/:id/approve', async (c) => {
    if (!deps.healer) return c.json({ ok: false, error: 'Self-heal not available' }, 503);

    const id = c.req.param('id');
    const entry = pendingProposals.get(id);
    if (!entry) return c.json({ ok: false, error: 'Proposal not found or expired' }, 404);
    if (Date.now() > entry.expires) {
      pendingProposals.delete(id);
      return c.json({ ok: false, error: 'Proposal expired' }, 410);
    }

    pendingProposals.delete(id);
    const result = await deps.healer.applyPatch(entry.proposal);
    return c.json(result);
  });

  // Human rejects a proposal
  app.delete('/proposals/:id', (c) => {
    pendingProposals.delete(c.req.param('id'));
    return c.json({ ok: true });
  });

  // List pending proposals
  app.get('/proposals', (c) => {
    const now = Date.now();
    const active = [...pendingProposals.entries()]
      .filter(([, v]) => v.expires > now)
      .map(([, v]) => v.proposal);
    return c.json(active);
  });

  return app;
}
