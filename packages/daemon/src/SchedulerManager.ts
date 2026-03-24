/**
 * SchedulerManager — persistent cron-like job scheduler.
 *
 * Jobs are stored in SQLite and survive daemon restarts.
 * Checks every minute. Fires sessions exactly like manual `0agent run`.
 * Natural language schedule parsing — no cron syntax required.
 *
 * Usage (via /schedule command in chat):
 *   /schedule add "run /retro" every Friday at 5pm
 *   /schedule add "run /review" every day at 9am
 *   /schedule add "run /security-audit" every Monday at 8am
 *   /schedule add "check the build" in 2 hours
 *   /schedule list
 *   /schedule pause abc123
 *   /schedule delete abc123
 */

import { readFileSync, existsSync } from 'node:fs';
import type { SQLiteAdapter } from '@0agent/core';
import type { IEventBus } from './WebSocketEvents.js';
import type { SessionManager } from './SessionManager.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ScheduleSpec =
  | { type: 'once';             at: number }
  | { type: 'hourly';           minute: number }
  | { type: 'daily';            hour: number; minute: number }
  | { type: 'weekly';           day: number; hour: number; minute: number }
  | { type: 'interval_minutes'; interval: number }
  | { type: 'monthly';          date: number; hour: number; minute: number };

export interface ScheduledJob {
  id: string;
  name: string;          // human label: "Friday retro"
  task: string;          // what to run: "run /retro" or "check the build"
  skill?: string;        // optional skill name
  schedule: ScheduleSpec;
  schedule_human: string; // "every Friday at 5pm"
  enabled: boolean;
  last_run_at?: number;
  next_run_at: number;
  run_count: number;
  created_at: number;
}

// ─── Natural language schedule parser ────────────────────────────────────────

const DAYS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

function parseTime(s: string): { hour: number; minute: number } {
  if (!s) return { hour: 9, minute: 0 };
  const m = s.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) throw new Error(`Cannot parse time: "${s}". Use format like "9am", "5:30pm", "14:00"`);
  let hour = parseInt(m[1], 10);
  const minute = parseInt(m[2] ?? '0', 10);
  const ampm = m[3]?.toLowerCase();
  if (ampm === 'pm' && hour !== 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  return { hour, minute };
}

export function parseSchedule(text: string): { spec: ScheduleSpec; human: string } {
  const t = text.trim().toLowerCase();

  // "in N hours" / "in N minutes"
  const inMatch = t.match(/^in\s+(\d+)\s+(hour|hours|hr|hrs|minute|minutes|min|mins)$/);
  if (inMatch) {
    const n = parseInt(inMatch[1], 10);
    const isHours = inMatch[2].startsWith('h');
    const at = Date.now() + n * (isHours ? 3_600_000 : 60_000);
    return { spec: { type: 'once', at }, human: text.trim() };
  }

  // "at TIME tomorrow" → once
  const tomorrowMatch = t.match(/^(?:tomorrow|tom)\s+at\s+(.+)$/);
  if (tomorrowMatch) {
    const { hour, minute } = parseTime(tomorrowMatch[1]);
    const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(hour, minute, 0, 0);
    return { spec: { type: 'once', at: d.getTime() }, human: text.trim() };
  }

  // "every hour"
  if (t === 'every hour') return { spec: { type: 'hourly', minute: 0 }, human: 'every hour' };

  // "every N minutes"
  const everyMinsMatch = t.match(/^every\s+(\d+)\s+minutes?$/);
  if (everyMinsMatch) {
    const interval = parseInt(everyMinsMatch[1], 10);
    return { spec: { type: 'interval_minutes', interval }, human: `every ${interval} minutes` };
  }

  // "every morning/evening/night" → daily with default times
  const DEFAULT_TIMES: Record<string, string> = {
    morning: '9am', evening: '6pm', night: '10pm', noon: '12pm', midnight: '12am',
  };

  // "every PERIOD [at TIME]"
  const dailyMatch = t.match(/^every\s+(day|daily|morning|evening|night|noon|midnight)\s*(?:at\s+(.+))?$/);
  if (dailyMatch) {
    const period = dailyMatch[1];
    const timeStr = dailyMatch[2] ?? DEFAULT_TIMES[period] ?? '9am';
    const { hour, minute } = parseTime(timeStr);
    const human = `every ${period}${dailyMatch[2] ? ' at ' + dailyMatch[2] : ''}`;
    return { spec: { type: 'daily', hour, minute }, human };
  }

  // "every WEEKDAY [at TIME]"
  const weeklyMatch = t.match(/^every\s+(\w+)\s*(?:at\s+(.+))?$/);
  if (weeklyMatch && DAYS[weeklyMatch[1]] !== undefined) {
    const day = DAYS[weeklyMatch[1]];
    const { hour, minute } = parseTime(weeklyMatch[2] ?? '9am');
    const human = `every ${weeklyMatch[1]}${weeklyMatch[2] ? ' at ' + weeklyMatch[2] : ''}`;
    return { spec: { type: 'weekly', day, hour, minute }, human };
  }

  throw new Error(
    `Could not understand schedule: "${text}"\n` +
    `Try: "every Friday at 5pm" · "every day at 9am" · "every morning" · "in 2 hours" · "every 30 minutes"`
  );
}

export function scheduleToHuman(spec: ScheduleSpec): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const hhmm = (h: number, m: number) => {
    const ampm = h >= 12 ? 'pm' : 'am';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return m === 0 ? `${h12}${ampm}` : `${h12}:${pad(m)}${ampm}`;
  };
  const DAYS_REV = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  switch (spec.type) {
    case 'once':             return `once at ${new Date(spec.at).toLocaleString()}`;
    case 'hourly':           return `every hour`;
    case 'interval_minutes': return `every ${spec.interval} minutes`;
    case 'daily':            return `every day at ${hhmm(spec.hour, spec.minute)}`;
    case 'weekly':           return `every ${DAYS_REV[spec.day]} at ${hhmm(spec.hour, spec.minute)}`;
    case 'monthly':          return `monthly on the ${spec.date}th at ${hhmm(spec.hour, spec.minute)}`;
    default:                 return 'unknown schedule';
  }
}

export function nextRunAt(spec: ScheduleSpec, now = Date.now()): number {
  const d = new Date(now);
  const next = new Date(now);

  switch (spec.type) {
    case 'once':
      return spec.at;

    case 'hourly': {
      next.setMinutes(spec.minute, 0, 0);
      if (next.getTime() <= now) next.setTime(next.getTime() + 3_600_000);
      return next.getTime();
    }

    case 'interval_minutes': {
      const minsUntil = spec.interval - (d.getMinutes() % spec.interval);
      return now + minsUntil * 60_000;
    }

    case 'daily': {
      next.setHours(spec.hour, spec.minute, 0, 0);
      if (next.getTime() <= now) next.setDate(next.getDate() + 1);
      return next.getTime();
    }

    case 'weekly': {
      const daysUntil = (spec.day - d.getDay() + 7) % 7 || 7;
      next.setDate(d.getDate() + daysUntil);
      next.setHours(spec.hour, spec.minute, 0, 0);
      if (next.getTime() <= now) next.setDate(next.getDate() + 7);
      return next.getTime();
    }

    case 'monthly': {
      next.setDate(spec.date);
      next.setHours(spec.hour, spec.minute, 0, 0);
      if (next.getTime() <= now) next.setMonth(next.getMonth() + 1);
      return next.getTime();
    }
  }
}

// ─── SchedulerStore (SQLite-backed) ──────────────────────────────────────────

const DDL = `
  CREATE TABLE IF NOT EXISTS scheduled_jobs (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    task          TEXT NOT NULL,
    skill         TEXT,
    schedule_json TEXT NOT NULL,
    schedule_human TEXT NOT NULL,
    enabled       INTEGER NOT NULL DEFAULT 1,
    last_run_at   INTEGER,
    next_run_at   INTEGER NOT NULL,
    run_count     INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_next ON scheduled_jobs(next_run_at, enabled);
`;

export class SchedulerStore {
  private initialised = false;

  constructor(private adapter: SQLiteAdapter) {}

  init(): void {
    if (this.initialised) return;
    const db = (this.adapter as unknown as { db: { exec: (s: string) => void } }).db;
    db.exec(DDL);
    this.initialised = true;
  }

  save(job: ScheduledJob): void {
    this.init();
    const db = (this.adapter as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db;
    db.prepare(`
      INSERT OR REPLACE INTO scheduled_jobs
        (id, name, task, skill, schedule_json, schedule_human, enabled, last_run_at, next_run_at, run_count, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      job.id, job.name, job.task, job.skill ?? null,
      JSON.stringify(job.schedule), job.schedule_human,
      job.enabled ? 1 : 0, job.last_run_at ?? null,
      job.next_run_at, job.run_count, job.created_at,
    );
  }

  delete(id: string): void {
    this.init();
    const db = (this.adapter as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db;
    db.prepare('DELETE FROM scheduled_jobs WHERE id = ?').run(id);
  }

  list(): ScheduledJob[] {
    this.init();
    const db = (this.adapter as unknown as { db: { prepare: (s: string) => { all: () => unknown[] } } }).db;
    const rows = db.prepare('SELECT * FROM scheduled_jobs ORDER BY next_run_at ASC').all() as Array<Record<string, unknown>>;
    return rows.map(this.rowToJob);
  }

  getDue(now: number): ScheduledJob[] {
    this.init();
    const db = (this.adapter as unknown as { db: { prepare: (s: string) => { all: (...a: unknown[]) => unknown[] } } }).db;
    const rows = db.prepare(
      'SELECT * FROM scheduled_jobs WHERE enabled = 1 AND next_run_at <= ?'
    ).all(now) as Array<Record<string, unknown>>;
    return rows.map(this.rowToJob);
  }

  private rowToJob(row: Record<string, unknown>): ScheduledJob {
    return {
      id: row.id as string,
      name: row.name as string,
      task: row.task as string,
      skill: row.skill as string | undefined,
      schedule: JSON.parse(row.schedule_json as string) as ScheduleSpec,
      schedule_human: row.schedule_human as string,
      enabled: (row.enabled as number) === 1,
      last_run_at: row.last_run_at as number | undefined,
      next_run_at: row.next_run_at as number,
      run_count: row.run_count as number,
      created_at: row.created_at as number,
    };
  }
}

// ─── SchedulerManager ─────────────────────────────────────────────────────────

export class SchedulerManager {
  private store: SchedulerStore;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    adapter: SQLiteAdapter,
    private sessions: SessionManager,
    private eventBus: IEventBus,
  ) {
    this.store = new SchedulerStore(adapter);
    this.store.init();
  }

  start(): void {
    if (this.timer) return;
    // Check every 30s — catches all minute-boundary jobs reliably
    this.timer = setInterval(() => this.tick(), 30_000);
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      (this.timer as unknown as { unref: () => void }).unref();
    }
    // Initial check 5s after start
    const init = setTimeout(() => this.tick(), 5_000);
    if (typeof init === 'object' && 'unref' in init) (init as unknown as { unref: () => void }).unref();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Add a new scheduled job. */
  add(params: { task: string; schedule: string; name?: string; skill?: string }): ScheduledJob {
    const { spec, human } = parseSchedule(params.schedule);
    const now = Date.now();
    const job: ScheduledJob = {
      id: crypto.randomUUID().slice(0, 8), // short ID for easy reference
      name: params.name ?? params.task.slice(0, 40),
      task: params.task,
      skill: params.skill,
      schedule: spec,
      schedule_human: human,
      enabled: true,
      next_run_at: nextRunAt(spec, now),
      run_count: 0,
      created_at: now,
    };
    this.store.save(job);
    return job;
  }

  /** Pause/resume a job. */
  setPaused(id: string, paused: boolean): boolean {
    const jobs = this.store.list();
    const job = jobs.find(j => j.id === id);
    if (!job) return false;
    job.enabled = !paused;
    this.store.save(job);
    return true;
  }

  /** Delete a job. */
  remove(id: string): boolean {
    const jobs = this.store.list();
    const exists = jobs.some(j => j.id === id);
    if (!exists) return false;
    this.store.delete(id);
    return true;
  }

  /** List all jobs. */
  list(): ScheduledJob[] {
    return this.store.list();
  }

  // ─── Tick ─────────────────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    const now = Date.now();
    const due = this.store.getDue(now);

    for (const job of due) {
      // Guard: don't re-fire within 50s of last run
      if (job.last_run_at && now - job.last_run_at < 50_000) continue;

      await this.fire(job);
    }
  }

  private async fire(job: ScheduledJob): Promise<void> {
    // Update state immediately (prevent double-fire)
    job.last_run_at = Date.now();
    job.run_count++;

    if (job.schedule.type === 'once') {
      job.enabled = false; // one-shot: disable after firing
    } else {
      job.next_run_at = nextRunAt(job.schedule, Date.now() + 60_000); // next occurrence
    }
    this.store.save(job);

    // Notify WS clients
    this.eventBus.emit({
      type: 'schedule.fired',
      job_id: job.id,
      job_name: job.name,
      task: job.task,
      run_count: job.run_count,
    });

    // Run as a session
    try {
      const session = this.sessions.createSession({ task: job.task, skill: job.skill });
      this.sessions.runExistingSession(session.id, { task: job.task, skill: job.skill })
        .then(() => {
          this.eventBus.emit({ type: 'schedule.completed', job_id: job.id, session_id: session.id });
        })
        .catch((err) => {
          this.eventBus.emit({ type: 'schedule.error', job_id: job.id, error: String(err) });
        });
    } catch (err) {
      this.eventBus.emit({ type: 'schedule.error', job_id: job.id, error: String(err) });
    }
  }
}
