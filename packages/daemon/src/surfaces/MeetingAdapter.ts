/**
 * MeetingAdapter — live meeting transcription and context injection for 0agent.
 *
 * Strategy (v1): System audio capture — the user joins the meeting themselves,
 * and 0agent captures the system audio output via ffmpeg.
 *
 * On macOS: requires BlackHole (free) or Loopback to route system audio.
 *   brew install blackhole-2ch
 *   Set "Multi-Output Device" in Audio MIDI Setup.
 *
 * On Linux: uses PulseAudio monitor source (no extra software needed).
 *
 * Pipeline:
 *   System audio chunks (30s) → ffmpeg → WAV → Whisper → transcript segments
 *   → rolling context → agent session on trigger phrase or end-of-meeting
 *
 * Commands available via the SurfaceRouter:
 *   "start meeting"    — begins capturing + transcribing
 *   "stop meeting"     — ends capture, generates summary
 *   "meeting status"   — shows current transcript length
 *
 * Trigger phrase detection:
 *   Messages starting with "agent," or "hey agent" fire an agent session
 *   with the last 2 minutes of transcript as context.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { SurfaceAdapter, InboundMessage, OutboundMessage } from './SurfaceAdapter.js';
import { WhisperSTT } from './WhisperSTT.js';

export interface MeetingAdapterConfig {
  whisper_model?: 'tiny' | 'base' | 'small' | 'medium' | 'large';
  /** Chunk duration in seconds. Default: 30 */
  chunk_seconds?: number;
  /** How many seconds of silence ends the meeting. Default: 60 */
  silence_timeout_seconds?: number;
  /** Trigger phrases that fire an agent query. Default: ['agent,', 'hey agent'] */
  trigger_phrases?: string[];
  /** Context window: include last N seconds of transcript on trigger. Default: 120 */
  context_window_seconds?: number;
}

interface TranscriptSegment {
  text: string;
  timestamp: number; // Unix ms
}

export class MeetingAdapter implements SurfaceAdapter {
  readonly name = 'meeting' as const;

  private messageHandler: ((msg: InboundMessage) => Promise<void>) | null = null;
  private stt: WhisperSTT;
  private config: MeetingAdapterConfig;
  private running = false;
  private inMeeting = false;
  private transcript: TranscriptSegment[] = [];
  private ffmpegProcess: ChildProcess | null = null;
  private chunkTimer: ReturnType<typeof setTimeout> | null = null;
  private tmpDir: string;
  private chunkSeconds: number;
  private silenceTimeoutSeconds: number;
  private triggerPhrases: string[];
  private contextWindowSeconds: number;
  private lastAudioTime = 0;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: MeetingAdapterConfig = {}) {
    this.config = config;
    this.chunkSeconds = config.chunk_seconds ?? 30;
    this.silenceTimeoutSeconds = config.silence_timeout_seconds ?? 60;
    this.triggerPhrases = config.trigger_phrases ?? ['agent,', 'hey agent', 'ok agent'];
    this.contextWindowSeconds = config.context_window_seconds ?? 120;
    this.tmpDir = join(tmpdir(), '0agent-meeting');
    if (!existsSync(this.tmpDir)) mkdirSync(this.tmpDir, { recursive: true });

    this.stt = new WhisperSTT({ model: config.whisper_model ?? 'base' });
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  async start(): Promise<void> {
    this.running = true;
    console.log('[0agent] Meeting: adapter ready. Say "start meeting" to begin transcription.');
  }

  async stop(): Promise<void> {
    this.running = false;
    await this._stopMeeting();
  }

  async send(msg: OutboundMessage): Promise<void> {
    // Meeting adapter doesn't have a UI surface — log to console
    if (!msg.is_progress) {
      console.log(`\n📋 Meeting agent:\n${msg.text}\n`);
    }
  }

  /**
   * Handle control commands routed from the SurfaceRouter.
   * The router calls messageHandler; we accept special commands here.
   */
  private async _handleControl(text: string, channelId: string): Promise<void> {
    const lower = text.toLowerCase().trim();

    if (lower === 'start meeting' || lower === 'begin meeting') {
      await this._startMeeting(channelId);
    } else if (lower === 'stop meeting' || lower === 'end meeting') {
      await this._stopMeeting();
      await this._generateSummary(channelId);
    } else if (lower === 'meeting status' || lower === 'status') {
      const segments = this.transcript.length;
      const words = this.transcript.map(s => s.text).join(' ').split(/\s+/).length;
      console.log(`📊 Meeting: ${segments} segments, ~${words} words transcribed`);
    } else if (this.inMeeting) {
      // During a meeting, any message is a direct query with meeting context
      await this._dispatchWithContext(text, channelId);
    }
  }

  // ── Meeting control ──────────────────────────────────────────────────────

  private async _startMeeting(channelId: string): Promise<void> {
    if (this.inMeeting) {
      console.log('[meeting] Already in a meeting.');
      return;
    }

    if (!WhisperSTT.isAvailable()) {
      console.warn('[meeting] Whisper not found. Install: pip install openai-whisper');
      return;
    }

    this.inMeeting = true;
    this.transcript = [];
    this.lastAudioTime = Date.now();
    console.log('\n🎙️  Meeting transcription started. System audio is being captured.\n');

    // Start periodic chunked recording
    this._scheduleChunk(channelId);

    // Silence detection timer
    this._resetSilenceTimer(channelId);
  }

  private async _stopMeeting(): Promise<void> {
    if (!this.inMeeting) return;
    this.inMeeting = false;

    if (this.chunkTimer) { clearTimeout(this.chunkTimer); this.chunkTimer = null; }
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
    if (this.ffmpegProcess) {
      this.ffmpegProcess.kill('SIGTERM');
      this.ffmpegProcess = null;
    }

    console.log('\n⏹️  Meeting transcription stopped.\n');
  }

  private _scheduleChunk(channelId: string): void {
    if (!this.inMeeting) return;

    this.chunkTimer = setTimeout(async () => {
      await this._captureAndTranscribeChunk(channelId);
      this._scheduleChunk(channelId);
    }, this.chunkSeconds * 1000);
  }

  private async _captureAndTranscribeChunk(channelId: string): Promise<void> {
    const chunkPath = join(this.tmpDir, `chunk-${Date.now()}.wav`);

    // Capture system audio
    const captured = await this._captureSystemAudio(chunkPath, this.chunkSeconds);
    if (!captured || !existsSync(chunkPath)) return;

    // Transcribe the chunk
    const text = await this.stt.transcribe(chunkPath);
    if (!text || text.trim().length < 3) return;

    const segment: TranscriptSegment = { text: text.trim(), timestamp: Date.now() };
    this.transcript.push(segment);
    this.lastAudioTime = Date.now();
    this._resetSilenceTimer(channelId);

    console.log(`📝 [${new Date().toLocaleTimeString()}] ${text.trim()}`);

    // Check for trigger phrases
    const lower = text.toLowerCase();
    for (const phrase of this.triggerPhrases) {
      if (lower.includes(phrase.toLowerCase())) {
        // Extract the question part after the trigger phrase
        const triggerIdx = lower.indexOf(phrase.toLowerCase());
        const question = text.slice(triggerIdx + phrase.length).trim();
        if (question.length > 3) {
          await this._dispatchWithContext(question, channelId);
        }
        break;
      }
    }
  }

  private async _captureSystemAudio(outPath: string, seconds: number): Promise<boolean> {
    return new Promise((resolve) => {
      const platform = process.platform;
      let args: string[];

      if (platform === 'darwin') {
        // macOS: BlackHole 2ch appears as device index :1 for input
        // Use avfoundation with audio input from virtual device
        args = ['-y', '-f', 'avfoundation', '-i', ':1', '-ar', '16000', '-ac', '1', '-t', String(seconds), outPath];
      } else if (platform === 'linux') {
        // Linux: PulseAudio monitor source
        args = ['-y', '-f', 'pulse', '-i', 'default.monitor', '-ar', '16000', '-ac', '1', '-t', String(seconds), outPath];
      } else {
        resolve(false);
        return;
      }

      const proc = spawn('ffmpeg', args, { stdio: 'pipe' });
      this.ffmpegProcess = proc;

      proc.on('close', (code) => {
        this.ffmpegProcess = null;
        resolve(code === 0);
      });

      proc.on('error', () => {
        this.ffmpegProcess = null;
        resolve(false);
      });
    });
  }

  private _resetSilenceTimer(channelId: string): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);

    this.silenceTimer = setTimeout(async () => {
      if (!this.inMeeting) return;
      console.log('\n🔇 Meeting ended (silence detected). Generating summary…\n');
      await this._stopMeeting();
      await this._generateSummary(channelId);
    }, this.silenceTimeoutSeconds * 1000);
  }

  // ── Context-aware dispatch ──────────────────────────────────────────────

  private async _dispatchWithContext(question: string, channelId: string): Promise<void> {
    if (!this.messageHandler) return;

    const contextWindowMs = this.contextWindowSeconds * 1000;
    const cutoff = Date.now() - contextWindowMs;
    const recentSegments = this.transcript
      .filter(s => s.timestamp >= cutoff)
      .map(s => s.text)
      .join(' ');

    const task = recentSegments.length > 20
      ? `Meeting context (last ${this.contextWindowSeconds}s):\n${recentSegments}\n\nQuestion: ${question}`
      : question;

    await this.messageHandler({
      surface: 'meeting',
      surface_user_id: 'meeting-host',
      surface_channel_id: channelId,
      text: task,
      display_name: 'Meeting host',
    });
  }

  private async _generateSummary(channelId: string): Promise<void> {
    if (!this.messageHandler || this.transcript.length === 0) return;

    const fullTranscript = this.transcript.map(s => s.text).join(' ');
    const wordCount = fullTranscript.split(/\s+/).length;

    if (wordCount < 20) {
      console.log('[meeting] Transcript too short for summary.');
      return;
    }

    await this.messageHandler({
      surface: 'meeting',
      surface_user_id: 'meeting-host',
      surface_channel_id: channelId,
      text: `Please summarize this meeting transcript and extract action items:\n\n${fullTranscript}`,
      display_name: 'Meeting host',
    });
  }

  /** Get the current transcript as a string */
  getTranscript(): string {
    return this.transcript.map(s => `[${new Date(s.timestamp).toLocaleTimeString()}] ${s.text}`).join('\n');
  }

  /** Export transcript to a file */
  saveTranscript(path?: string): string {
    const outPath = path ?? join(this.tmpDir, `meeting-${Date.now()}.txt`);
    const content = `Meeting Transcript\n${'='.repeat(40)}\n${this.getTranscript()}`;
    writeFileSync(outPath, content, 'utf8');
    return outPath;
  }

  static isAvailable(): boolean {
    try {
      const { spawnSync } = require('node:child_process');
      const r = spawnSync('ffmpeg', ['-version'], { timeout: 2000, stdio: 'pipe' });
      return r.status === 0;
    } catch {
      return false;
    }
  }
}
