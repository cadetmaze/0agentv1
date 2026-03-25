/**
 * VoiceAdapter — local voice interface for 0agent.
 *
 * Two modes:
 *   push_to_talk — press Enter to start recording, Enter again to stop
 *   always_on    — continuously listens, chunks on silence gaps
 *
 * Pipeline:
 *   Mic → recordAudio() → WhisperSTT → SurfaceRouter → agent
 *   Agent response → NativeTTS.speak()
 *
 * This adapter is designed to be used with the CLI (bin/chat.js --voice)
 * rather than from the daemon. It can also be started from the daemon
 * for always-on voice mode.
 *
 * Usage from CLI:
 *   0agent-chat --voice
 *
 * Requirements:
 *   whisper CLI (pip install openai-whisper)
 *   sox or ffmpeg for audio recording
 *   macOS: built-in `say` for TTS; Linux: piper or espeak
 */

import * as readline from 'node:readline';
import type { SurfaceAdapter, InboundMessage, OutboundMessage } from './SurfaceAdapter.js';
import { WhisperSTT, recordAudio } from './WhisperSTT.js';
import { NativeTTS } from './NativeTTS.js';

export type VoiceMode = 'push_to_talk' | 'always_on';

export interface VoiceAdapterConfig {
  mode?: VoiceMode;
  whisper_model?: 'tiny' | 'base' | 'small' | 'medium' | 'large';
  whisper_language?: string;
  tts_engine?: 'say' | 'piper' | 'espeak' | 'edge-tts' | 'auto';
  tts_voice?: string;
  /** Recording duration for always_on chunks (seconds). Default: 5 */
  chunk_seconds?: number;
  /** Silence threshold for always_on VAD — not implemented, uses fixed chunks for now */
  silence_threshold?: number;
}

export class VoiceAdapter implements SurfaceAdapter {
  readonly name = 'voice' as const;

  private messageHandler: ((msg: InboundMessage) => Promise<void>) | null = null;
  private stt: WhisperSTT;
  private tts: NativeTTS;
  private mode: VoiceMode;
  private chunkSeconds: number;
  private running = false;
  private sessionUserId = 'voice-local';
  private sessionChannelId = 'voice';

  constructor(private config: VoiceAdapterConfig = {}) {
    this.mode = config.mode ?? 'push_to_talk';
    this.chunkSeconds = config.chunk_seconds ?? 5;
    this.stt = new WhisperSTT({
      model: config.whisper_model ?? 'base',
      language: config.whisper_language,
    });
    this.tts = new NativeTTS({
      engine: config.tts_engine ?? 'auto',
      voice: config.tts_voice,
    });
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  async start(): Promise<void> {
    if (this.running) return;

    if (!WhisperSTT.isAvailable()) {
      console.warn('[voice] Whisper not found. Install: pip install openai-whisper');
      return;
    }

    this.running = true;
    console.log(`[0agent] Voice: started (${this.mode})`);

    if (this.mode === 'push_to_talk') {
      await this._runPushToTalk();
    } else {
      await this._runAlwaysOn();
    }
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  async send(msg: OutboundMessage): Promise<void> {
    // Voice surface: speak final responses, ignore progress updates
    if (!msg.is_progress) {
      process.stdout.write(`\n🤖 ${msg.text}\n\n`);
      this.tts.speak(msg.text);
    }
  }

  // ── Push to talk ─────────────────────────────────────────────────────────

  private async _runPushToTalk(): Promise<void> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    console.log('\n🎙️  Voice mode ready. Press Enter to start recording, Enter again to stop.\n');

    // Re-enable raw mode isn't needed for simple Enter-to-start flow
    rl.on('line', async () => {
      if (!this.running) { rl.close(); return; }
      await this._recordAndDispatch();
    });

    rl.on('close', () => { this.running = false; });
  }

  private async _recordAndDispatch(): Promise<void> {
    console.log('🔴 Recording… press Ctrl+C or Enter when done.');

    // Record a fixed chunk — for push to talk, we record for the chunk duration
    // A more polished implementation would detect key release
    const audioPath = await recordAudio(this.chunkSeconds);
    if (!audioPath) {
      console.log('⚠️  Could not record audio. Check microphone and sox/ffmpeg installation.');
      return;
    }

    console.log('⏳ Transcribing…');
    const transcript = await this.stt.transcribe(audioPath);
    if (!transcript) {
      console.log('⚠️  Could not transcribe. Is your microphone working?');
      return;
    }

    console.log(`🎤 "${transcript}"`);
    await this._dispatch(transcript);
  }

  // ── Always on ────────────────────────────────────────────────────────────

  private async _runAlwaysOn(): Promise<void> {
    console.log('\n🎙️  Voice mode: always-on. Listening continuously…\n');

    while (this.running) {
      const audioPath = await recordAudio(this.chunkSeconds);
      if (!audioPath) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }

      const transcript = await this.stt.transcribe(audioPath);
      if (!transcript || transcript.length < 3) continue; // Skip silence/noise

      console.log(`🎤 "${transcript}"`);
      await this._dispatch(transcript);

      // Brief pause after dispatching a task before recording again
      await new Promise(r => setTimeout(r, 500));
    }
  }

  private async _dispatch(text: string): Promise<void> {
    if (!this.messageHandler) return;

    await this.messageHandler({
      surface: 'voice',
      surface_user_id: this.sessionUserId,
      surface_channel_id: this.sessionChannelId,
      text,
      display_name: 'Voice user',
    });
  }

  static isAvailable(): boolean {
    return WhisperSTT.isAvailable();
  }
}
