/**
 * WhisperSTT — local speech-to-text via OpenAI Whisper CLI or faster-whisper.
 *
 * Requires one of:
 *   pip install openai-whisper        → provides `whisper` CLI
 *   pip install faster-whisper        → provides `faster-whisper` CLI
 *
 * Usage:
 *   const stt = new WhisperSTT({ model: 'base' });
 *   const text = await stt.transcribe('/path/to/audio.wav');
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';

export type WhisperModel = 'tiny' | 'base' | 'small' | 'medium' | 'large';

export interface WhisperSTTConfig {
  model?: WhisperModel;
  /** Language hint (e.g. 'en'). Default: auto-detect */
  language?: string;
  /** Path to whisper binary. Default: auto-detect */
  binary?: string;
}

export class WhisperSTT {
  private model: WhisperModel;
  private language: string | undefined;
  private binary: string | null = null;

  constructor(config: WhisperSTTConfig = {}) {
    this.model = config.model ?? 'base';
    this.language = config.language;
    this.binary = config.binary ?? WhisperSTT.detectBinary();
  }

  /** Transcribe an audio file. Returns the transcript text, or null on failure. */
  async transcribe(audioPath: string): Promise<string | null> {
    if (!this.binary) {
      console.warn('[WhisperSTT] No Whisper binary found. Install: pip install openai-whisper');
      return null;
    }

    if (!existsSync(audioPath)) {
      console.warn(`[WhisperSTT] Audio file not found: ${audioPath}`);
      return null;
    }

    const outDir = join(tmpdir(), '0agent-whisper');
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

    try {
      const langFlag = this.language ? `--language ${this.language}` : '';

      const cmd = this.binary === 'faster-whisper'
        ? `faster-whisper "${audioPath}" --model ${this.model} ${langFlag} --output_format txt --output_dir "${outDir}"`
        : `whisper "${audioPath}" --model ${this.model} ${langFlag} --output_format txt --output_dir "${outDir}" --fp16 False`;

      execSync(cmd, { timeout: 180_000, stdio: 'pipe' });

      // Whisper writes <basename>.txt in outDir
      const baseName = basename(audioPath).replace(/\.[^.]+$/, '');
      const txtPath = join(outDir, `${baseName}.txt`);

      if (existsSync(txtPath)) {
        return readFileSync(txtPath, 'utf8').trim();
      }

      return null;
    } catch (err) {
      console.error('[WhisperSTT] Transcription failed:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  /** Check if Whisper is available on this system */
  static isAvailable(): boolean {
    return WhisperSTT.detectBinary() !== null;
  }

  static detectBinary(): string | null {
    for (const bin of ['whisper', 'faster-whisper', 'whisper.cpp']) {
      try {
        const result = spawnSync(bin, ['--help'], { timeout: 3000, stdio: 'pipe' });
        if (result.status === 0 || result.status === 1) return bin; // help exits 0 or 1
      } catch {}
    }
    return null;
  }
}

/**
 * Record audio from the microphone using sox or ffmpeg.
 * Returns the path to the recorded WAV file.
 */
export async function recordAudio(durationSeconds: number): Promise<string | null> {
  const outDir = join(tmpdir(), '0agent-voice');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `recording-${Date.now()}.wav`);

  // Try sox first (simpler), then ffmpeg
  const soxResult = spawnSync(
    'sox', ['-d', '-r', '16000', '-c', '1', '-b', '16', outPath, 'trim', '0', String(durationSeconds)],
    { timeout: (durationSeconds + 5) * 1000, stdio: 'pipe' },
  );
  if (soxResult.status === 0 && existsSync(outPath)) return outPath;

  // Fallback: ffmpeg with platform-appropriate device
  const platform = process.platform;
  let ffmpegDevice: string[];
  if (platform === 'darwin') {
    ffmpegDevice = ['-f', 'avfoundation', '-i', ':0'];
  } else if (platform === 'linux') {
    ffmpegDevice = ['-f', 'alsa', '-i', 'default'];
  } else {
    return null; // Windows not yet supported
  }

  const ffmpegResult = spawnSync(
    'ffmpeg',
    ['-y', ...ffmpegDevice, '-ar', '16000', '-ac', '1', '-t', String(durationSeconds), outPath],
    { timeout: (durationSeconds + 5) * 1000, stdio: 'pipe' },
  );

  return (ffmpegResult.status === 0 && existsSync(outPath)) ? outPath : null;
}

/**
 * Record system audio (for meeting transcription).
 * Uses BlackHole/Loopback on macOS, PulseAudio monitor on Linux.
 */
export async function recordSystemAudio(durationSeconds: number): Promise<string | null> {
  const outDir = join(tmpdir(), '0agent-meeting');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `meeting-${Date.now()}.wav`);

  const platform = process.platform;
  let args: string[];

  if (platform === 'darwin') {
    // macOS: BlackHole 2ch or Loopback virtual device
    // Device index :1 is typically the BlackHole or Loopback output
    args = ['-y', '-f', 'avfoundation', '-i', ':1', '-ar', '16000', '-ac', '1', '-t', String(durationSeconds), outPath];
  } else if (platform === 'linux') {
    // Linux: PulseAudio monitor source
    args = ['-y', '-f', 'pulse', '-i', 'default.monitor', '-ar', '16000', '-ac', '1', '-t', String(durationSeconds), outPath];
  } else {
    return null;
  }

  const result = spawnSync('ffmpeg', args, { timeout: (durationSeconds + 5) * 1000, stdio: 'pipe' });
  return (result.status === 0 && existsSync(outPath)) ? outPath : null;
}
