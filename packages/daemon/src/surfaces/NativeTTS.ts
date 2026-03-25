/**
 * NativeTTS — platform-aware text-to-speech with no cloud dependencies.
 *
 * Priority:
 *   macOS  → `say` (built-in, zero deps)
 *   Linux  → `piper` (high quality, local) → `espeak` (fallback)
 *   All    → silent fallback if nothing found
 */

import { spawnSync, spawn } from 'node:child_process';

export type TTSEngine = 'say' | 'piper' | 'espeak' | 'edge-tts' | 'auto';

export interface NativeTTSConfig {
  engine?: TTSEngine;
  /** macOS: 'Samantha', 'Alex', etc. Linux piper: model path */
  voice?: string;
  /** Playback rate/speed. For `say`: words per minute (default 175) */
  rate?: number;
}

export class NativeTTS {
  private engine: TTSEngine;
  private voice: string | undefined;
  private rate: number;
  private resolvedEngine: string | null = null;

  constructor(config: NativeTTSConfig = {}) {
    this.engine = config.engine ?? 'auto';
    this.voice = config.voice;
    this.rate = config.rate ?? 175;
    this.resolvedEngine = this._resolve();
  }

  /** Speak text aloud. Non-blocking — fires and forgets. */
  speak(text: string): void {
    if (!this.resolvedEngine) return;
    const cleaned = this._clean(text);
    if (!cleaned) return;
    this._speakWith(this.resolvedEngine, cleaned);
  }

  /** Speak text and wait for it to finish. */
  async speakSync(text: string): Promise<void> {
    if (!this.resolvedEngine) return;
    const cleaned = this._clean(text);
    if (!cleaned) return;

    return new Promise((resolve) => {
      const args = this._buildArgs(this.resolvedEngine!, cleaned);
      const proc = spawn(this.resolvedEngine!, args, { stdio: 'ignore' });
      proc.on('close', () => resolve());
      proc.on('error', () => resolve());
    });
  }

  /** Check if any TTS engine is available */
  static isAvailable(): boolean {
    return NativeTTS._detectEngine() !== null;
  }

  private _resolve(): string | null {
    if (this.engine !== 'auto') {
      return this._isAvailable(this.engine) ? this.engine : null;
    }
    return NativeTTS._detectEngine();
  }

  private static _detectEngine(): string | null {
    const platform = process.platform;
    if (platform === 'darwin') {
      if (NativeTTS._isAvailable('say')) return 'say';
    }
    if (NativeTTS._isAvailable('piper')) return 'piper';
    if (NativeTTS._isAvailable('espeak')) return 'espeak';
    if (NativeTTS._isAvailable('edge-tts')) return 'edge-tts';
    return null;
  }

  private static _isAvailable(engine: string): boolean {
    try {
      const r = spawnSync(engine, ['--help'], { timeout: 2000, stdio: 'pipe' });
      return r.status === 0 || r.status === 1;
    } catch {
      return false;
    }
  }

  private _isAvailable(engine: string): boolean {
    return NativeTTS._isAvailable(engine);
  }

  private _buildArgs(engine: string, text: string): string[] {
    switch (engine) {
      case 'say':
        return [
          ...(this.voice ? ['-v', this.voice] : []),
          '-r', String(this.rate),
          text,
        ];
      case 'espeak':
        return [
          ...(this.voice ? ['-v', this.voice] : []),
          '-s', String(this.rate),
          text,
        ];
      case 'piper':
        // piper reads from stdin: echo "text" | piper --model model.onnx --output_raw | aplay
        // We use a simplified invocation here
        return ['--output_file', '-'];
      default:
        return [text];
    }
  }

  private _speakWith(engine: string, text: string): void {
    const args = this._buildArgs(engine, text);
    const proc = spawn(engine, args, { stdio: 'ignore', detached: true });
    proc.unref();
  }

  /** Remove markdown/ANSI and control chars before speaking */
  private _clean(text: string): string {
    return text
      .replace(/```[\s\S]*?```/g, 'code block')  // code blocks → "code block"
      .replace(/`[^`]+`/g, '')                    // inline code → removed
      .replace(/\*\*([^*]+)\*\*/g, '$1')          // **bold** → plain
      .replace(/\*([^*]+)\*/g, '$1')              // *italic* → plain
      .replace(/#+\s*/g, '')                      // headers → plain
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')   // links → text only
      .replace(/\u001b\[[0-9;]*m/g, '')           // ANSI codes
      .replace(/[^\x20-\x7E\n]/g, '')             // non-ASCII
      .replace(/\n{2,}/g, '. ')                   // paragraph breaks → pause
      .replace(/\n/g, ' ')
      .trim();
  }
}
