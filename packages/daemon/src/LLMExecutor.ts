/**
 * LLMExecutor — makes real LLM API calls using the configured provider.
 * Supports Anthropic, OpenAI, xAI, and Ollama.
 */

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResponse {
  content: string;
  tokens_used: number;
  model: string;
}

export interface LLMConfig {
  provider: string;
  model: string;
  api_key: string;
  base_url?: string;
}

export class LLMExecutor {
  constructor(private config: LLMConfig) {}

  async complete(messages: LLMMessage[], system?: string): Promise<LLMResponse> {
    switch (this.config.provider) {
      case 'anthropic': return this.callAnthropic(messages, system);
      case 'openai':    return this.callOpenAI(messages, system);
      case 'xai':       return this.callOpenAI(messages, system, 'https://api.x.ai/v1');
      case 'gemini':    return this.callOpenAI(messages, system, 'https://generativelanguage.googleapis.com/v1beta/openai');
      case 'ollama':    return this.callOllama(messages, system);
      default:          return this.callOpenAI(messages, system);
    }
  }

  private async callAnthropic(messages: LLMMessage[], system?: string): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: 8192,
      messages: messages
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role, content: m.content })),
    };
    if (system) body.system = system;
    else {
      const sysMsg = messages.find(m => m.role === 'system');
      if (sysMsg) body.system = sysMsg.content;
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.api_key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${err}`);
    }

    const data = await res.json() as {
      content: Array<{ type: string; text: string }>;
      usage: { input_tokens: number; output_tokens: number };
      model: string;
    };

    return {
      content: data.content.filter(c => c.type === 'text').map(c => c.text).join(''),
      tokens_used: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
      model: data.model,
    };
  }

  private async callOpenAI(
    messages: LLMMessage[],
    system?: string,
    baseUrl = 'https://api.openai.com/v1',
  ): Promise<LLMResponse> {
    const allMessages = [];
    const sysContent = system ?? messages.find(m => m.role === 'system')?.content;
    if (sysContent) allMessages.push({ role: 'system', content: sysContent });
    allMessages.push(...messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content })));

    const res = await fetch(`${this.config.base_url ?? baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.api_key}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: allMessages,
        max_tokens: 8192,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${err}`);
    }

    const data = await res.json() as {
      choices: Array<{ message: { content: string } }>;
      usage: { total_tokens: number };
      model: string;
    };

    return {
      content: data.choices[0]?.message?.content ?? '',
      tokens_used: data.usage?.total_tokens ?? 0,
      model: data.model,
    };
  }

  private async callOllama(messages: LLMMessage[], system?: string): Promise<LLMResponse> {
    const baseUrl = this.config.base_url ?? 'http://localhost:11434';
    const allMessages = [];
    const sysContent = system ?? messages.find(m => m.role === 'system')?.content;
    if (sysContent) allMessages.push({ role: 'system', content: sysContent });
    allMessages.push(...messages.filter(m => m.role !== 'system'));

    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.config.model, messages: allMessages, stream: false }),
    });

    if (!res.ok) throw new Error(`Ollama error ${res.status}`);
    const data = await res.json() as { message: { content: string }; eval_count?: number };
    return { content: data.message.content, tokens_used: data.eval_count ?? 0, model: this.config.model };
  }

  get isConfigured(): boolean {
    if (this.config.provider === 'ollama') return true;
    return !!(this.config.api_key?.trim());
  }
}
