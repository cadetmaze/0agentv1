import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteAdapter } from '../../../packages/core/src/storage/adapters/SQLiteAdapter';
import { AliasIndex } from '../../../packages/core/src/entity/AliasIndex';
import { createNode, NodeType } from '../../../packages/core/src/graph/GraphNode';

describe('AliasIndex', () => {
  let adapter: SQLiteAdapter;
  let aliasIndex: AliasIndex;

  beforeEach(() => {
    adapter = new SQLiteAdapter({ db_path: ':memory:' });
    aliasIndex = new AliasIndex(adapter);
  });

  afterEach(() => {
    adapter.close();
  });

  /** Helper: insert a node so FK constraints are satisfied. */
  function insertNode(id: string): void {
    const node = createNode({ id, graph_id: 'g1', label: id, type: NodeType.ENTITY });
    adapter.insertNode(node);
  }

  it('should add an alias and find it by exact match', () => {
    insertNode('node-1');
    aliasIndex.add('Test Alias', 'node-1', 0.95);

    const results = aliasIndex.findExact('test alias');
    expect(results).toHaveLength(1);
    expect(results[0].node_id).toBe('node-1');
    expect(results[0].confidence).toBe(0.95);
  });

  it('generateAbbreviations: "Acme Corp" produces ["acme corp", "acme", "ac"]', () => {
    const abbrs = aliasIndex.generateAbbreviations('Acme Corp');
    expect(abbrs).toEqual(['acme corp', 'acme', 'ac']);
  });

  it('generateAbbreviations: single word produces just the word', () => {
    const abbrs = aliasIndex.generateAbbreviations('Singleton');
    expect(abbrs).toEqual(['singleton']);
  });

  it('registerNode creates all abbreviations as aliases', () => {
    insertNode('node-2');
    aliasIndex.registerNode('node-2', 'Acme Corp');

    const aliases = aliasIndex.getAliases('node-2');
    const aliasNames = aliases.map((a) => a.alias).sort();

    expect(aliasNames).toContain('acme corp');
    expect(aliasNames).toContain('acme');
    expect(aliasNames).toContain('ac');

    // Full label alias has confidence 1.0
    const fullLabel = aliases.find((a) => a.alias === 'acme corp');
    expect(fullLabel!.confidence).toBe(1.0);

    // Abbreviations have confidence 0.9
    const abbr = aliases.find((a) => a.alias === 'ac');
    expect(abbr!.confidence).toBe(0.9);
  });

  it('should delete an alias', () => {
    insertNode('node-3');
    aliasIndex.add('removeme', 'node-3');

    expect(aliasIndex.findExact('removeme')).toHaveLength(1);

    aliasIndex.remove('removeme', 'node-3');

    expect(aliasIndex.findExact('removeme')).toHaveLength(0);
  });
});
