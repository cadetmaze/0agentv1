export interface EmbeddingAdapter {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  readonly dimensions: number;
  readonly modelName: string;
}

export class OllamaAdapter implements EmbeddingAdapter {
  readonly dimensions: number;
  readonly modelName: string;
  private baseUrl: string;

  constructor(opts: { model: string; dimensions: number; baseUrl?: string }) {
    this.modelName = opts.model;
    this.dimensions = opts.dimensions;
    this.baseUrl = opts.baseUrl ?? 'http://localhost:11434';
  }

  async embed(text: string): Promise<Float32Array> {
    const resp = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.modelName, prompt: text }),
    });
    if (!resp.ok) {
      throw new Error(`Ollama embedding failed: ${resp.status} ${await resp.text()}`);
    }
    const data = (await resp.json()) as { embedding: number[] };
    return new Float32Array(data.embedding);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    // Ollama doesn't have a batch endpoint — run sequentially
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}
