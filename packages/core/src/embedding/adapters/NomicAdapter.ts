import { OllamaAdapter, type EmbeddingAdapter } from './OllamaAdapter.js';

export class NomicAdapter extends OllamaAdapter implements EmbeddingAdapter {
  constructor(opts?: { baseUrl?: string }) {
    super({
      model: 'nomic-embed-text',
      dimensions: 768,
      baseUrl: opts?.baseUrl,
    });
  }
}
