import type { EmbeddingAdapter } from './OllamaAdapter.js';

export class OpenAIAdapter implements EmbeddingAdapter {
  readonly dimensions = 1536;
  readonly modelName = 'text-embedding-3-small';
  private apiKey: string;
  private baseUrl: string;

  constructor(opts: { apiKey: string; baseUrl?: string }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? 'https://api.openai.com/v1';
  }

  async embed(text: string): Promise<Float32Array> {
    const resp = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.modelName,
        input: text,
      }),
    });
    if (!resp.ok) {
      throw new Error(`OpenAI embedding failed: ${resp.status}`);
    }
    const data = (await resp.json()) as { data: Array<{ embedding: number[] }> };
    return new Float32Array(data.data[0].embedding);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    // OpenAI supports batch in a single request
    const resp = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.modelName,
        input: texts,
      }),
    });
    if (!resp.ok) {
      throw new Error(`OpenAI embedding batch failed: ${resp.status}`);
    }
    const data = (await resp.json()) as { data: Array<{ embedding: number[] }> };
    return data.data.map((d) => new Float32Array(d.embedding));
  }
}
