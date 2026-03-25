/**
 * UserEntityMapper — maps surface-specific user IDs to stable entity identifiers.
 *
 * Uses a deterministic label as the entity ID since KnowledgeGraph's
 * node-creation API varies. The label is stable across restarts and surfaces.
 */

import type { SurfaceType } from './SurfaceAdapter.js';

export class UserEntityMapper {
  private cache = new Map<string, string>(); // "surface:user_id" → stable entity id

  // graph parameter reserved for future use when KnowledgeGraph exposes upsertNode
  constructor(_graph?: unknown) {}

  /**
   * Get or create the entity node ID for a surface user.
   * Returns a stable identifier string that can be used as entity_id in sessions.
   */
  async getOrCreate(
    surface: SurfaceType,
    surfaceUserId: string,
    _displayName?: string,
  ): Promise<string> {
    const cacheKey = `${surface}:${surfaceUserId}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    // Deterministic label as stable entity identifier
    const entityId = `surface_user:${surface}:${surfaceUserId}`;
    this.cache.set(cacheKey, entityId);
    return entityId;
  }
}
