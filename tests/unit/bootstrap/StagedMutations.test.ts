import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StagedMutationStore } from '../../../packages/core/src/bootstrap/StagedMutations';

describe('StagedMutationStore', () => {
  let store: StagedMutationStore;

  beforeEach(() => {
    store = new StagedMutationStore();
  });

  it('should stage a mutation and get it back', () => {
    const mutation = store.stage({
      id: 'm1',
      trace_id: 't1',
      proposed_nodes: [],
      proposed_edges: [],
    });

    expect(mutation.id).toBe('m1');
    expect(mutation.trace_id).toBe('t1');
    expect(mutation.committed).toBe(false);
    expect(mutation.discarded).toBe(false);

    const fetched = store.get('m1');
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe('m1');
  });

  it('should commit a mutation (committed=true)', () => {
    store.stage({ id: 'm1', trace_id: 't1', proposed_nodes: [], proposed_edges: [] });

    const committed = store.commit('m1');
    expect(committed).not.toBeNull();
    expect(committed!.committed).toBe(true);

    const fetched = store.get('m1');
    expect(fetched!.committed).toBe(true);
  });

  it('should discard a mutation (discarded=true)', () => {
    store.stage({ id: 'm1', trace_id: 't1', proposed_nodes: [], proposed_edges: [] });

    store.discard('m1');

    const fetched = store.get('m1');
    expect(fetched!.discarded).toBe(true);
  });

  it('cannot commit an already-committed mutation', () => {
    store.stage({ id: 'm1', trace_id: 't1', proposed_nodes: [], proposed_edges: [] });
    store.commit('m1');

    const result = store.commit('m1');
    expect(result).toBeNull();
  });

  it('cannot commit an already-discarded mutation', () => {
    store.stage({ id: 'm1', trace_id: 't1', proposed_nodes: [], proposed_edges: [] });
    store.discard('m1');

    const result = store.commit('m1');
    expect(result).toBeNull();
  });

  it('pruneExpired: expired mutations get discarded', () => {
    // Stage a mutation, then simulate time passing beyond TTL (14 days)
    const mutation = store.stage({ id: 'm1', trace_id: 't1', proposed_nodes: [], proposed_edges: [] });

    // Move expires_at into the past
    (mutation as any).expires_at = Date.now() - 1000;

    const count = store.pruneExpired();
    expect(count).toBe(1);
    expect(store.get('m1')!.discarded).toBe(true);
  });

  it('TTL is 14 days', () => {
    const before = Date.now();
    const mutation = store.stage({ id: 'm1', trace_id: 't1', proposed_nodes: [], proposed_edges: [] });
    const after = Date.now();

    const fourteenDays = 14 * 24 * 60 * 60 * 1000;
    // expires_at should be created_at + 14 days
    expect(mutation.expires_at).toBeGreaterThanOrEqual(before + fourteenDays);
    expect(mutation.expires_at).toBeLessThanOrEqual(after + fourteenDays);
  });
});
