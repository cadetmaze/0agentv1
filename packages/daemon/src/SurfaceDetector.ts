export type SurfaceType = 'terminal' | 'slack' | 'api' | 'chat';
export type FormatType = 'ansi' | 'markdown' | 'json' | 'prose';

export interface Surface {
  type: SurfaceType;
  format: FormatType;
  context: Record<string, string>;
}

export class SurfaceDetector {
  static detect(requestContext?: Record<string, unknown>): Surface {
    // Explicit surface from request context (set by Slack MCP, API clients, etc.)
    if (requestContext?.surface) {
      return SurfaceDetector.fromType(String(requestContext.surface) as SurfaceType);
    }
    // Slack MCP sets this env var
    if (process.env['SLACK_BOT_TOKEN'] || requestContext?.slack_channel) {
      return { type: 'slack', format: 'markdown', context: {} };
    }
    // Called from a non-TTY (piped, CI, API) → structured JSON
    if (!process.stdout.isTTY && !requestContext?.is_chat) {
      return { type: 'api', format: 'json', context: {} };
    }
    // Interactive chat mode
    if (requestContext?.is_chat) {
      return { type: 'chat', format: 'prose', context: {} };
    }
    // Default: terminal
    return { type: 'terminal', format: 'ansi', context: {} };
  }

  static fromType(type: SurfaceType): Surface {
    const formats: Record<SurfaceType, FormatType> = {
      terminal: 'ansi', slack: 'markdown', api: 'json', chat: 'prose',
    };
    return { type, format: formats[type], context: {} };
  }

  /**
   * Build surface-aware system prompt suffix.
   * Tells the LLM how to format its response.
   */
  static buildPromptSuffix(surface: Surface): string {
    switch (surface.format) {
      case 'ansi':
        return 'Format your response for a terminal. Be concise. Use plain text.';
      case 'markdown':
        return 'Format your response as Markdown. Use headers, bullets, and code blocks where appropriate.';
      case 'json':
        return 'Respond in structured JSON with fields: output (string), files_created (array), commands_run (array).';
      case 'prose':
        return 'Respond in natural prose. Be conversational but precise.';
    }
  }
}
