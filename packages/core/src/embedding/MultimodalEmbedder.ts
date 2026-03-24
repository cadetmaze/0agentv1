import type { EmbeddingAdapter } from './adapters/OllamaAdapter.js';
import type { NodeContent } from '../graph/GraphNode.js';
import { ContentType } from '../graph/GraphNode.js';

export class MultimodalEmbedder {
  private textAdapter: EmbeddingAdapter | null;
  private visionAdapter: EmbeddingAdapter | null;

  constructor(opts: {
    textAdapter?: EmbeddingAdapter;
    visionAdapter?: EmbeddingAdapter;
  }) {
    this.textAdapter = opts.textAdapter ?? null;
    this.visionAdapter = opts.visionAdapter ?? null;
  }

  get dimensions(): number {
    return this.textAdapter?.dimensions ?? this.visionAdapter?.dimensions ?? 0;
  }

  get isAvailable(): boolean {
    return this.textAdapter !== null || this.visionAdapter !== null;
  }

  /**
   * Compute a fused embedding from a label + content items.
   * Late fusion: average of per-modality embeddings.
   * Returns null if no adapter is available.
   */
  async embed(label: string, content: NodeContent[]): Promise<Float32Array | null> {
    if (!this.isAvailable) return null;

    const embeddings: Float32Array[] = [];

    for (const item of content) {
      switch (item.type) {
        case ContentType.TEXT:
        case ContentType.CODE:
        case ContentType.STRUCTURED:
          if (this.textAdapter) {
            embeddings.push(await this.textAdapter.embed(item.data));
          }
          break;
        case ContentType.IMAGE:
          if (this.visionAdapter) {
            embeddings.push(await this.visionAdapter.embed(item.data));
          }
          break;
        case ContentType.AUDIO: {
          // Use transcription if available
          const transcription = item.metadata?.transcription as string | undefined;
          if (transcription && this.textAdapter) {
            embeddings.push(await this.textAdapter.embed(transcription));
          }
          break;
        }
      }
    }

    // Always embed the label
    if (this.textAdapter) {
      embeddings.push(await this.textAdapter.embed(label));
    }

    if (embeddings.length === 0) return null;

    return this.averageEmbeddings(embeddings);
  }

  /**
   * Embed a single text string (convenience).
   */
  async embedText(text: string): Promise<Float32Array | null> {
    if (!this.textAdapter) return null;
    return this.textAdapter.embed(text);
  }

  private averageEmbeddings(embeddings: Float32Array[]): Float32Array {
    const dim = embeddings[0].length;
    const result = new Float32Array(dim);
    for (const emb of embeddings) {
      for (let i = 0; i < dim; i++) {
        result[i] += emb[i] / embeddings.length;
      }
    }
    return result;
  }
}
