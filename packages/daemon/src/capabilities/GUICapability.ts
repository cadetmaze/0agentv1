/**
 * GUICapability — desktop GUI automation via PyAutoGUI.
 *
 * The agent can take screenshots, click on elements, type text,
 * press hotkeys, scroll, and find UI elements by their on-screen text.
 *
 * PyAutoGUI + Pillow + pytesseract are auto-installed on first use.
 *
 * Supported actions:
 *   screenshot      — capture screen, return OCR text + dimensions
 *   click           — click at (x, y)
 *   double_click    — double-click at (x, y)
 *   right_click     — right-click at (x, y)
 *   move            — move mouse to (x, y) without clicking
 *   type            — type text at current cursor position
 *   hotkey          — press a keyboard shortcut e.g. "cmd+c"
 *   scroll          — scroll at (x, y) up/down/left/right
 *   drag            — drag from (x,y) to (to_x, to_y)
 *   find_and_click  — OCR-find text on screen and click it
 *   get_screen_size — return screen width × height
 *   get_cursor_pos  — return current mouse cursor position (x, y)
 *   wait            — pause for N seconds to let UI / page load before next action
 *   open_url        — open a URL in the existing browser window (no new window), launch browser if needed
 *   open_app        — open an application by name (macOS/Linux)
 *   exec_js         — run JavaScript in the current Chrome tab via AppleScript (no Screen Recording needed)
 *   browser_state   — get current Chrome tab URL + title (no Screen Recording needed)
 */

import type { Capability, CapabilityResult, ToolDefinition } from './types.js';
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir, platform } from 'node:os';

export class GUICapability implements Capability {
  readonly name = 'gui_automation';
  readonly description = 'Automate desktop GUI — click, type, screenshot, hotkeys, find text on screen.';

  readonly toolDefinition: ToolDefinition = {
    name: 'gui_automation',
    description:
      'GUI automation + comprehensive browser control. ' +
      'BROWSER (no Screen Recording needed): ' +
      'click_text — click any element by its visible text; ' +
      'type_in — fill a form field by placeholder/label; ' +
      'get_elements — list all interactive elements on the page; ' +
      'read_element — read text of an element by CSS selector; ' +
      'get_media_state — check if video is playing/paused/current time; ' +
      'scroll_to — scroll page or scroll to specific element; ' +
      'exec_js — run arbitrary JavaScript in Chrome tab; ' +
      'browser_state — get current URL + title; ' +
      'cdp_screenshot — screenshot via CDP (needs --remote-debugging-port=9222) with OCR. ' +
      'NATIVE APPS: accessibility_click — click button in macOS app (WhatsApp, Finder) via Accessibility API. ' +
      'NAVIGATION: open_url — navigate Chrome tab, returns URL+title+video state. ' +
      'MOUSE/KEYBOARD: click, type, hotkey (use app param to target Chrome vs Terminal), screenshot (needs Screen Recording).',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description:
            'Browser (no Screen Recording): "click_text"|"type_in"|"get_elements"|"read_element"|"get_media_state"|"scroll_to"|"exec_js"|"browser_state"|"cdp_screenshot" | ' +
            'Native apps (no Screen Recording): "app_type"|"accessibility_click" | ' +
            'Navigation: "open_url"|"open_app" | ' +
            'Mouse/KB (Screen Recording for screenshots): "screenshot"|"click"|"double_click"|"right_click"|"move"|"type"|"hotkey"|"scroll"|"drag"|"find_and_click"|"get_screen_size"|"get_cursor_pos"|"wait"',
        },
        js: { type: 'string', description: 'JavaScript to execute in Chrome tab (use with exec_js). Example: "document.querySelector(\'video\').paused"' },
        selector: { type: 'string', description: 'CSS selector for read_element, type_in, scroll_to (e.g. "input[type=search]", ".title", "video")' },
        x:         { type: 'number',  description: 'X coordinate (pixels from left)' },
        y:         { type: 'number',  description: 'Y coordinate (pixels from top)' },
        to_x:      { type: 'number',  description: 'End X for drag' },
        to_y:      { type: 'number',  description: 'End Y for drag' },
        text:      { type: 'string',  description: 'Text to type, or text to search for (find_and_click)' },
        keys:      { type: 'string',  description: 'Hotkey combo e.g. "cmd+c", "ctrl+z", "alt+tab", "enter"' },
        direction: { type: 'string',  description: '"up" | "down" | "left" | "right" for scroll' },
        amount:    { type: 'number',  description: 'Scroll clicks (default 3)' },
        app:       { type: 'string',  description: 'App name to open e.g. "Safari", "Terminal", "Chrome"' },
        url:       { type: 'string',  description: 'URL to open e.g. "https://example.com" (use with open_url)' },
        seconds:   { type: 'number',  description: 'Seconds to wait (use with wait action, default 2)' },
        interval:  { type: 'number',  description: 'Seconds to wait between actions (default 0.05)' },
        duration:  { type: 'number',  description: 'Seconds for mouse movement animation (default 0.2)' },
      },
      required: ['action'],
    },
  };

  async execute(input: Record<string, unknown>, _cwd: string, signal?: AbortSignal): Promise<CapabilityResult> {
    const action = String(input.action ?? '').toLowerCase().trim();
    const start  = Date.now();

    const script = this._buildScript(action, input);
    if (!script) {
      return { success: false, output: `Unknown GUI action: "${action}". Valid: screenshot, click, double_click, right_click, move, type, hotkey, scroll, drag, find_and_click, get_screen_size, get_cursor_pos, wait, open_url, open_app, exec_js, browser_state`, duration_ms: 0 };
    }

    if (signal?.aborted) {
      return { success: false, output: 'Cancelled.', duration_ms: 0 };
    }

    const tmpFile = resolve(tmpdir(), `0agent_gui_${Date.now()}.py`);
    writeFileSync(tmpFile, script, 'utf8');

    // Run python3 asynchronously so ESC (AbortSignal) can kill the process
    const runPy = (file: string): Promise<{ stdout: string; stderr: string; code: number | null }> =>
      new Promise((res) => {
        const proc = spawn('python3', [file], { env: process.env });
        const out: string[] = [];
        const err: string[] = [];
        let settled = false;

        const finish = (code: number | null) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          clearTimeout(timer);
          res({ stdout: out.join(''), stderr: err.join(''), code });
        };

        const onAbort = () => {
          try { proc.kill('SIGKILL'); } catch {}
          finish(null);
        };

        signal?.addEventListener('abort', onAbort, { once: true });
        proc.stdout.on('data', (d: Buffer) => out.push(d.toString()));
        proc.stderr.on('data', (d: Buffer) => err.push(d.toString()));
        proc.on('exit', finish);
        proc.on('error', () => finish(-1));

        const timer = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch {}
          finish(null);
        }, 30_000);
      });

    let result = await runPy(tmpFile);
    try { unlinkSync(tmpFile); } catch {}

    if (signal?.aborted) {
      return { success: false, output: 'Cancelled.', duration_ms: Date.now() - start };
    }

    if (result.code !== 0 && result.code !== null) {
      const err = result.stderr.trim();

      // Auto-install pyautogui on first use
      if (err.includes('No module named') || err.includes('ModuleNotFoundError')) {
        const missing = err.includes('pyautogui') ? 'pyautogui pillow pytesseract'
          : err.includes('PIL')       ? 'pillow'
          : err.includes('tesseract') ? 'pytesseract'
          : 'pyautogui pillow';

        const install = spawnSync('pip3', ['install', ...missing.split(' '), '-q'], {
          timeout: 60_000, encoding: 'utf8',
        });
        if (install.status !== 0) {
          return { success: false, output: `Auto-install failed: ${install.stderr?.slice(0, 200)}. Run: pip3 install ${missing}`, duration_ms: Date.now() - start };
        }

        // Retry after install
        writeFileSync(tmpFile, script, 'utf8');
        result = await runPy(tmpFile);
        try { unlinkSync(tmpFile); } catch {}

        if (signal?.aborted) return { success: false, output: 'Cancelled.', duration_ms: Date.now() - start };
        if (result.code === 0) return { success: true, output: result.stdout.trim() || 'Done', duration_ms: Date.now() - start };
        return { success: false, output: result.stderr.trim() || 'Unknown error after install', duration_ms: Date.now() - start };
      }

      // macOS Screen Recording permission denied — try browser state as fallback
      const isScreenRecordingDenied =
        err.includes('could not create image from display') ||
        err.includes('screen capture failed') ||
        err.includes('screencapture') ||
        err.includes('CGDisplayStream') ||
        err.includes('Operation not permitted') ||
        (err.includes('OSError') && err.includes('display')) ||
        result.stdout.includes('could not create image from display');

      if (isScreenRecordingDenied) {
        if (platform() === 'darwin') {
          // Auto-open System Settings to fix the permission
          spawnSync('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'], { timeout: 3000 });

          // Fallback: get browser state via AppleScript (no Screen Recording needed)
          const fallbackScript = `
import subprocess
as_script = '''tell application "Google Chrome"
  tell front window
    tell active tab
      set tabURL to URL
      set tabTitle to title
      set videoSt to execute javascript "try{let v=document.querySelector('video');v?(v.paused?'PAUSED':'PLAYING:'+v.currentTime.toFixed(1)+'s'):'no-video'}catch(e){'?'}"
      return tabURL & "|||" & tabTitle & "|||" & videoSt
    end tell
  end tell
end tell'''
r = subprocess.run(['osascript', '-e', as_script], capture_output=True, text=True)
out = r.stdout.strip()
parts = out.split('|||') if '|||' in out else []
if len(parts) >= 3:
    print(f"[No screenshot — Screen Recording permission needed]")
    print(f"Browser URL: {parts[0]}")
    print(f"Page title:  {parts[1]}")
    print(f"Video state: {parts[2]}")
    print(f"To enable screenshots: System Settings → Privacy & Security → Screen Recording → enable Terminal")
else:
    print("[No screenshot — Screen Recording permission needed]")
    print("To fix: System Settings → Privacy & Security → Screen Recording → enable Terminal (or iTerm2)")
`;
          const fallbackTmp = resolve(tmpdir(), `0agent_scfb_${Date.now()}.py`);
          writeFileSync(fallbackTmp, fallbackScript, 'utf8');
          const fbResult = await runPy(fallbackTmp);
          try { unlinkSync(fallbackTmp); } catch {}
          if (fbResult.code === 0 && fbResult.stdout.trim()) {
            return { success: false, output: fbResult.stdout.trim(), duration_ms: Date.now() - start };
          }
        }
        return {
          success: false,
          output:
            'macOS Screen Recording permission required for screenshots.\n' +
            'System Settings opened → Privacy & Security → Screen Recording → enable Terminal/iTerm2.\n' +
            'For browser content, use exec_js instead: {action:"exec_js",js:"document.title"} or ' +
            '{action:"browser_state"} — these work without Screen Recording.',
          duration_ms: Date.now() - start,
        };
      }

      // macOS accessibility permission error — auto-open System Settings
      if (err.includes('accessibility') || err.includes('permission') || err.includes('AXIsProcessTrusted')) {
        if (platform() === 'darwin') {
          spawnSync('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'], { timeout: 3000 });
        }
        return {
          success: false,
          output: 'macOS Accessibility permission required for GUI automation.\n' +
            '→ System Settings has been opened automatically.\n' +
            '→ Go to: Privacy & Security → Accessibility → enable Terminal (or iTerm2 / the app running 0agent)\n' +
            '→ Then re-run your task.',
          duration_ms: Date.now() - start,
        };
      }

      return { success: false, output: `GUI error: ${err.slice(0, 300)}`, duration_ms: Date.now() - start };
    }

    return { success: true, output: result.stdout.trim() || 'Done', duration_ms: Date.now() - start };
  }

  private _buildScript(action: string, input: Record<string, unknown>): string | null {
    const x        = input.x         != null ? Number(input.x)       : null;
    const y        = input.y         != null ? Number(input.y)       : null;
    const toX      = input.to_x      != null ? Number(input.to_x)    : null;
    const toY      = input.to_y      != null ? Number(input.to_y)    : null;
    const text     = input.text      != null ? String(input.text)    : '';
    const keys     = input.keys      != null ? String(input.keys)    : '';
    const dir      = input.direction != null ? String(input.direction): 'down';
    const amount   = input.amount    != null ? Number(input.amount)  : 3;
    const app      = input.app       != null ? String(input.app)     : '';
    const url      = input.url       != null ? String(input.url)     : '';
    const seconds  = input.seconds   != null ? Number(input.seconds) : 2;
    const interval = input.interval  != null ? Number(input.interval): 0.05;
    const duration = input.duration  != null ? Number(input.duration): 0.2;

    const header = `
import pyautogui
import time
import sys
pyautogui.FAILSAFE = False
pyautogui.PAUSE = ${interval}
`;

    switch (action) {
      case 'get_screen_size':
        return header + `
w, h = pyautogui.size()
print(f"Screen size: {w} x {h}")
`;

      case 'get_cursor_pos':
        return header + `
x, y = pyautogui.position()
print(f"Cursor position: ({x}, {y})")
`;

      case 'wait':
        return header + `
time.sleep(${seconds})
print(f"Waited ${seconds}s")
`;

      case 'screenshot': {
        // Take screenshot and OCR it to return what's on screen
        return header + `
import os, tempfile
from PIL import Image

# Take screenshot
shot_path = os.path.join(tempfile.gettempdir(), "0agent_screen.png")
img = pyautogui.screenshot(shot_path)

w, h = img.size
print(f"Screen: {w}x{h}")

# Try OCR with pytesseract
try:
    import pytesseract
    # Resize for faster OCR if screen is large
    scale = min(1.0, 1920 / w)
    small = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    text = pytesseract.image_to_string(small, config='--psm 11')
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    print("\\nOn-screen text (OCR):")
    print("\\n".join(lines[:80]))

    # Also get bounding boxes for clickable text
    data = pytesseract.image_to_data(small, output_type=pytesseract.Output.DICT)
    hits = []
    for i, word in enumerate(data['text']):
        if word.strip() and int(data['conf'][i]) > 50:
            bx = int(data['left'][i] / scale)
            by = int(data['top'][i] / scale)
            bw = int(data['width'][i] / scale)
            bh = int(data['height'][i] / scale)
            hits.append(f"  '{word}' at ({bx + bw//2}, {by + bh//2})")
    if hits:
        print("\\nClickable words with center coordinates:")
        print("\\n".join(hits[:40]))
except ImportError:
    print("(pytesseract not installed — install it for OCR: pip3 install pytesseract)")
except Exception as e:
    print(f"OCR failed: {e}")
finally:
    try:
        os.remove(shot_path)
    except Exception:
        pass
`;
      }

      case 'click':
        if (x == null || y == null) return null;
        return header + `
pyautogui.click(${x}, ${y}, duration=${duration})
print(f"Clicked at ({${x}}, {${y}})")
`;

      case 'double_click':
        if (x == null || y == null) return null;
        return header + `
pyautogui.doubleClick(${x}, ${y}, duration=${duration})
print(f"Double-clicked at ({${x}}, {${y}})")
`;

      case 'right_click':
        if (x == null || y == null) return null;
        return header + `
pyautogui.rightClick(${x}, ${y}, duration=${duration})
print(f"Right-clicked at ({${x}}, {${y}})")
`;

      case 'move':
        if (x == null || y == null) return null;
        return header + `
pyautogui.moveTo(${x}, ${y}, duration=${duration})
print(f"Moved to ({${x}}, {${y}})")
`;

      case 'type': {
        if (!text) return null;
        // typewrite is the backward-compatible name (write() was added later)
        return header + `
pyautogui.typewrite(${JSON.stringify(text)}, interval=${interval})
print("Typed successfully")
`;
      }

      case 'hotkey': {
        if (!keys) return null;
        const targetApp = input.app ? String(input.app) : '';
        // Parse "cmd+c" → ["command", "c"],  "ctrl+shift+t" → ["ctrl","shift","t"]
        const parts = keys.toLowerCase()
          .replace(/cmd|command|meta/g, 'command')
          .replace(/ctrl|control/g, 'ctrl')
          .replace(/opt|option/g, 'option')
          .split(/[+\-]/)
          .map(k => k.trim())
          .filter(Boolean);
        const pyKeys = JSON.stringify(parts);
        // If target app specified, send via AppleScript (guarantees delivery to that app, not Terminal)
        if (targetApp && platform() === 'darwin') {
          const safeApp = targetApp.replace(/'/g, "\\'");
          const mainKey = parts[parts.length - 1] ?? '';
          const modParts = parts.slice(0, -1);

          // Special keys that MUST use `key code` — `keystroke "down"` types literal text "down"
          const KEY_CODES: Record<string, number> = {
            down: 125, up: 126, left: 123, right: 124,
            enter: 36, return: 36, escape: 53, esc: 53,
            tab: 48, delete: 51, backspace: 51, 'delete-forward': 117,
            space: 49, home: 115, end: 119, pageup: 116, pagedown: 121,
            f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100,
            f9: 101, f10: 109, f11: 103, f12: 111,
          };

          const keyCode = KEY_CODES[mainKey];
          const modifiers = modParts.map(k => {
            if (k === 'command') return 'command down';
            if (k === 'ctrl') return 'control down';
            if (k === 'shift') return 'shift down';
            if (k === 'option') return 'option down';
            return '';
          }).filter(Boolean).join(', ');
          const usingClause = modifiers ? ` using {${modifiers}}` : '';

          // Use key code for special keys, keystroke for regular characters
          const keyStatement = keyCode !== undefined
            ? `key code ${keyCode}${usingClause}`
            : `keystroke "${mainKey}"${usingClause}`;

          return header + `
import subprocess, time
subprocess.run(['osascript', '-e', 'tell application "${safeApp}" to activate'], capture_output=True)
time.sleep(0.3)
as_script = """tell application "System Events"
  tell process "${safeApp}"
    ${keyStatement}
  end tell
end tell"""
r = subprocess.run(['osascript', '-e', as_script], capture_output=True, text=True)
if r.returncode == 0:
    print(f"Sent ${parts.join('+')} to ${safeApp}")
else:
    print(f"Keystroke error: {r.stderr.strip()[:200]}")
`;
        }
        return header + `
keys = ${pyKeys}
pyautogui.hotkey(*keys)
print(f"Pressed: {'+'.join(keys)}")
`;
      }

      case 'scroll': {
        const clicksVal = dir === 'up' ? amount : dir === 'down' ? -amount : 0;
        const hVal      = dir === 'left' ? -amount : dir === 'right' ? amount : 0;
        const sx = x ?? 'pyautogui.size()[0]//2';
        const sy = y ?? 'pyautogui.size()[1]//2';
        return header + `
${hVal !== 0
  ? `pyautogui.hscroll(${hVal}, x=${sx}, y=${sy})`
  : `pyautogui.scroll(${clicksVal}, x=${sx}, y=${sy})`}
print(f"Scrolled ${dir} by ${amount}")
`;
      }

      case 'drag':
        if (x == null || y == null || toX == null || toY == null) return null;
        return header + `
pyautogui.moveTo(${x}, ${y}, duration=${duration})
pyautogui.dragTo(${toX}, ${toY}, duration=${duration * 2}, button='left')
print(f"Dragged from ({${x}},{${y}}) to ({${toX}},{${toY}})")
`;

      case 'find_and_click': {
        if (!text) return null;
        const safeText = text.replace(/'/g, "\\'");
        return header + `
from PIL import Image
import pytesseract, os, tempfile

shot_path = os.path.join(tempfile.gettempdir(), "0agent_screen.png")
img = pyautogui.screenshot(shot_path)
w, h = img.size

data = pytesseract.image_to_data(img, output_type=pytesseract.Output.DICT)
target = '${safeText}'.lower()
found = []
for i, word in enumerate(data['text']):
    if target in word.lower() and int(data['conf'][i]) > 40:
        cx = data['left'][i] + data['width'][i] // 2
        cy = data['top'][i] + data['height'][i] // 2
        found.append((cx, cy, word))

if found:
    cx, cy, word = found[0]
    pyautogui.click(cx, cy, duration=${duration})
    print(f"Found '{word}' at ({cx},{cy}) — clicked")
else:
    # Retry once after a brief wait (element may still be loading)
    time.sleep(1.5)
    img2 = pyautogui.screenshot()
    data2 = pytesseract.image_to_data(img2, output_type=pytesseract.Output.DICT)
    found2 = []
    for i, word in enumerate(data2['text']):
        if target in word.lower() and int(data2['conf'][i]) > 40:
            cx2 = data2['left'][i] + data2['width'][i] // 2
            cy2 = data2['top'][i] + data2['height'][i] // 2
            found2.append((cx2, cy2, word))
    if found2:
        cx2, cy2, word2 = found2[0]
        pyautogui.click(cx2, cy2, duration=${duration})
        print(f"Found '{word2}' at ({cx2},{cy2}) after retry — clicked")
    else:
        print(f"Text '${safeText}' not found on screen after retry. Take a screenshot to see what changed.")
        sys.exit(1)
try:
    os.remove(shot_path)
except Exception:
    pass
`;
      }

      case 'open_url': {
        if (!url) return null;
        // For YouTube video pages, always add autoplay=1 so the video starts
        let finalUrl = url;
        if (/youtube\.com\/watch/i.test(url) && !url.includes('autoplay')) {
          finalUrl = url + (url.includes('?') ? '&' : '?') + 'autoplay=1';
        }
        const safeUrl = finalUrl.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const isYouTubeVideo = /youtube\.com\/watch/i.test(finalUrl);
        const osName = platform();
        if (osName === 'darwin') {
          return header + `
import subprocess
import time

url = '${safeUrl}'
is_youtube_video = ${isYouTubeVideo ? 'True' : 'False'}

# Check if Chrome is running
chrome_running = subprocess.run(['pgrep', '-x', 'Google Chrome'], capture_output=True).returncode == 0
firefox_running = subprocess.run(['pgrep', '-x', 'firefox'], capture_output=True).returncode == 0
safari_running  = subprocess.run(['pgrep', '-x', 'Safari'], capture_output=True).returncode == 0

import urllib.parse
domain = urllib.parse.urlparse(url).netloc

if chrome_running:
    if is_youtube_video:
        # Navigate the CURRENT active tab directly to avoid domain-matching a wrong/stale tab
        nav_script = f"""tell application "Google Chrome"
  tell front window
    tell active tab
      set URL to "{url}"
    end tell
  end tell
  activate
end tell"""
        subprocess.run(['osascript', '-e', nav_script], capture_output=True)
        time.sleep(3)
        # Unmute + play via JS (handles autoplay policy blocks)
        play_script = """tell application "Google Chrome"
  tell front window
    tell active tab
      execute javascript "try{let v=document.querySelector('video');if(v){v.muted=false;v.volume=1.0;v.play();}}catch(e){}"
    end tell
  end tell
end tell"""
        subprocess.run(['osascript', '-e', play_script], capture_output=True)
        time.sleep(1)
        # Verify: get URL, title, video state — all via AppleScript, no Screen Recording needed
        verify_script = """tell application "Google Chrome"
  tell front window
    tell active tab
      set tabURL to URL
      set tabTitle to title
      set videoSt to execute javascript "try{let v=document.querySelector('video');v?(v.paused?'PAUSED':'PLAYING:'+v.currentTime.toFixed(1)+'s'):'no-video'}catch(e){'err'}"
      return tabURL & "|||" & tabTitle & "|||" & videoSt
    end tell
  end tell
end tell"""
        vr = subprocess.run(['osascript', '-e', verify_script], capture_output=True, text=True)
        parts = vr.stdout.strip().split('|||')
        if len(parts) >= 3:
            print(f"URL: {parts[0]}")
            print(f"Title: {parts[1]}")
            st = parts[2].strip()
            if 'PLAYING' in st:
                print(f"Video: {st} ✓")
            elif st == 'PAUSED':
                # Send play() one more time
                subprocess.run(['osascript', '-e', play_script], capture_output=True)
                time.sleep(0.5)
                print("Video: was PAUSED — sent play() again, should be playing now")
            else:
                print(f"Video state: {st} (page may still be loading)")
        else:
            print(f"Navigated to: {url}")
            print(f"(Verification unavailable: {vr.stdout.strip() or vr.stderr.strip()[:100]})")
    else:
        # Non-video: switch to existing same-domain tab or open new tab
        check_script = f"""tell application "Google Chrome"
  set foundTab to false
  repeat with w in every window
    set tabIdx to 1
    repeat with t in every tab of w
      if URL of t contains "{domain}" then
        set active tab index of w to tabIdx
        set index of w to 1
        set foundTab to true
        exit repeat
      end if
      set tabIdx to tabIdx + 1
    end repeat
    if foundTab then exit repeat
  end repeat
  if foundTab then
    activate
    return "switched"
  else
    tell front window to make new tab with properties {{URL:"{url}"}}
    activate
    return "new-tab"
  end if
end tell"""
        r = subprocess.run(['osascript', '-e', check_script], capture_output=True, text=True)
        switched = r.stdout.strip() == "switched"
        # Verify actual URL and title loaded (catches wrong-domain tab issues)
        state_script = """tell application "Google Chrome"
  tell front window
    tell active tab
      return URL & "|||" & title
    end tell
  end tell
end tell"""
        sr = subprocess.run(['osascript', '-e', state_script], capture_output=True, text=True)
        sp = sr.stdout.strip().split('|||')
        if len(sp) >= 2:
            print(f"{'Switched to' if switched else 'Opened'}: {sp[0]}")
            print(f"Title: {sp[1]}")
        else:
            print(f"{'Switched to existing' if switched else 'Opened new'} Chrome tab: {url}")
elif firefox_running:
    script = f'tell application "Firefox" to open location "{url}"'
    subprocess.run(['osascript', '-e', script])
    subprocess.run(['osascript', '-e', 'tell application "Firefox" to activate'])
    print(f"Navigated Firefox to: {url}")
elif safari_running:
    script = f'tell application "Safari" to open location "{url}"'
    subprocess.run(['osascript', '-e', script])
    subprocess.run(['osascript', '-e', 'tell application "Safari" to activate'])
    print(f"Navigated Safari to: {url}")
else:
    # No browser open — launch default browser with the URL
    subprocess.run(['open', url])
    print(f"Launched browser with: {url}")
time.sleep(1.0)
`;
        }
        // Linux
        return header + `
import subprocess

url = '${safeUrl}'

# Try to reuse existing browser via wmctrl/xdotool, fall back to xdg-open
chrome_pid = subprocess.run(['pgrep', '-x', 'chrome'], capture_output=True)
firefox_pid = subprocess.run(['pgrep', '-x', 'firefox'], capture_output=True)

if chrome_pid.returncode == 0:
    subprocess.Popen(['google-chrome', '--new-tab', url])
    print(f"Opened in Chrome tab: {url}")
elif firefox_pid.returncode == 0:
    subprocess.Popen(['firefox', '--new-tab', url])
    print(f"Opened in Firefox tab: {url}")
else:
    subprocess.Popen(['xdg-open', url])
    print(f"Opened with default browser: {url}")
time.sleep(1.0)
`;
      }

      case 'open_app': {
        if (!app) return null;
        const safeApp = app.replace(/'/g, "\\'");
        const os = platform();
        if (os === 'darwin') {
          return header + `
import subprocess
result = subprocess.run(['open', '-a', '${safeApp}'], capture_output=True, text=True)
if result.returncode == 0:
    print(f"Opened: ${safeApp}")
    time.sleep(1.5)  # wait for app to launch
else:
    # Try spotlight
    pyautogui.hotkey('command', 'space')
    time.sleep(0.5)
    pyautogui.write('${safeApp}', interval=0.05)
    time.sleep(0.5)
    pyautogui.press('enter')
    print(f"Opened via Spotlight: ${safeApp}")
    time.sleep(1.5)
`;
        }
        return header + `
import subprocess
subprocess.Popen(['${safeApp}'])
print(f"Launched: ${safeApp}")
time.sleep(1.5)
`;
      }

      // ── New high-level browser actions — no Screen Recording needed ───────────

      case 'app_type': {
        // Type text into a specific macOS app via clipboard paste.
        // HOW: copies text to clipboard (pbcopy), activates app, pastes with cmd+v via AppleScript.
        // WHY THIS WORKS: cmd+v goes to the target process regardless of OS keyboard focus.
        // Works for WhatsApp, iMessage, Notes, Finder — any native app.
        // No Screen Recording needed. Requires Accessibility permission.
        const appName = String(input.app ?? '').trim();
        const typeText = String(input.text ?? text ?? '').trim();
        if (!appName || !typeText) return null;
        const osName = platform();
        if (osName !== 'darwin') return header + `print("app_type requires macOS")`;
        const safeApp = appName.replace(/'/g, "\\'");
        const textJson = JSON.stringify(typeText);
        return header + `
import subprocess, time, json

text_to_type = json.loads(${textJson})

# Step 1: copy to clipboard (handles unicode, special chars, long text)
cp = subprocess.run(['pbcopy'], input=text_to_type.encode('utf-8'), capture_output=True)
if cp.returncode != 0:
    print(f"Clipboard copy failed: {cp.stderr.decode()[:100]}")
    sys.exit(1)

# Step 2: bring app to front
subprocess.run(['osascript', '-e', 'tell application "${safeApp}" to activate'], capture_output=True)
time.sleep(0.4)

# Step 3: paste via AppleScript System Events (targets the specific process, not OS focus)
paste_script = """tell application "System Events"
  tell process "${safeApp}"
    keystroke "v" using command down
  end tell
end tell"""
r = subprocess.run(['osascript', '-e', paste_script], capture_output=True, text=True)
if r.returncode == 0:
    print(f"Typed in ${safeApp}: {text_to_type[:60]}")
else:
    # Accessibility permission might be needed
    err = r.stderr.strip()
    if 'not allowed' in err.lower() or 'accessibility' in err.lower():
        subprocess.run(['open', 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'], capture_output=True)
        print(f"Accessibility permission needed for ${safeApp}. System Settings opened — Privacy & Security → Accessibility → enable Terminal.")
    else:
        print(f"app_type error: {err[:200]}")
`;
      }

      case 'click_text': {
        // Click a visible element by its text content — no coordinates, no OCR, no Screen Recording.
        // Works on buttons, links, list items, tabs — anything with visible text.
        if (!text) return null;
        if (platform() !== 'darwin') return header + `print("click_text requires macOS + Chrome")`;
        return this._chromeJs(JSON.stringify(text), `
(function(t) {
  t = t.toLowerCase().trim();
  // Pass 1: interactive elements (buttons, links, roles)
  var candidates = Array.from(document.querySelectorAll(
    'button,a,[role="button"],[role="link"],[role="menuitem"],[role="option"],[role="tab"],[tabindex="0"],label'
  ));
  var match = candidates.find(el => {
    var txt = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().toLowerCase();
    return txt === t || txt.startsWith(t) || (t.length > 3 && txt.includes(t));
  });
  // Pass 2: any visible leaf element with matching text
  if (!match) {
    match = Array.from(document.querySelectorAll('*')).find(el => {
      if (!el.offsetParent && el !== document.body) return false;
      if (el.children.length > 0) return false;
      var txt = (el.textContent || '').trim().toLowerCase();
      return txt === t || (t.length > 4 && txt.includes(t) && txt.length < t.length * 3);
    });
  }
  if (!match) return 'NOT_FOUND: ' + t;
  match.scrollIntoView({behavior:'instant', block:'center'});
  match.focus();
  ['mousedown','mouseup','click'].forEach(e =>
    match.dispatchEvent(new MouseEvent(e, {bubbles:true, cancelable:true}))
  );
  return 'CLICKED: ' + (match.textContent || match.getAttribute('aria-label') || match.tagName).trim().slice(0,80);
})(JSARG)
`);
      }

      case 'type_in': {
        // Type text into a form field located by placeholder, aria-label, or CSS selector.
        // Dispatches React/Vue-compatible synthetic events so frameworks pick up the change.
        if (!text) return null;
        if (platform() !== 'darwin') return header + `print("type_in requires macOS + Chrome")`;
        const query = String(input.selector ?? input.query ?? '').trim() || 'active';
        const args = JSON.stringify([query, text]);
        return this._chromeJs(args, `
(function(query, value) {
  var el = query === 'active' ? document.activeElement :
    document.querySelector('input[placeholder*="'+query+'" i]') ||
    document.querySelector('input[aria-label*="'+query+'" i]') ||
    document.querySelector('textarea[placeholder*="'+query+'" i]') ||
    document.querySelector('[role="textbox"][aria-label*="'+query+'" i]') ||
    document.querySelector('[contenteditable="true"]') ||
    document.querySelector('input[type="text"],input[type="search"],input:not([type])');
  if (!el) return 'NOT_FOUND: ' + query;
  el.focus();
  if (el.getAttribute('contenteditable') !== null) {
    el.textContent = '';
    document.execCommand('insertText', false, value);
  } else {
    var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    ['input','change'].forEach(t => el.dispatchEvent(new Event(t, {bubbles:true})));
  }
  return 'TYPED "'+value.slice(0,40)+'" in '+(el.placeholder||el.getAttribute('aria-label')||el.tagName);
})(JSARG[0], JSARG[1])
`);
      }

      case 'read_element': {
        // Read visible text content of an element by CSS selector.
        // Use selector="" to read the full page body text.
        if (platform() !== 'darwin') return header + `print("read_element requires macOS + Chrome")`;
        const sel = String(input.selector ?? '').trim();
        return this._chromeJs(JSON.stringify(sel || 'body'), `
(function(sel) {
  var el = sel ? document.querySelector(sel) : document.body;
  if (!el) return 'NOT_FOUND: ' + sel;
  return (el.textContent || el.innerText || el.value || '').trim().replace(/\\s+/g,' ').slice(0, 800);
})(JSARG)
`);
      }

      case 'get_elements': {
        // List all interactive elements on the current page (buttons, links, inputs, headings, video).
        // Use this to discover what's available before using click_text or type_in.
        if (platform() !== 'darwin') return header + `print("get_elements requires macOS + Chrome")`;
        return this._chromeJs(JSON.stringify(''), `
(function() {
  var seen = new Set(), els = [];
  document.querySelectorAll('button,a,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="option"],h1,h2,h3,video,audio').forEach(function(el,i) {
    if (i > 80 || !el.offsetParent) return;
    var label = (el.textContent || el.getAttribute('aria-label') || el.placeholder || el.getAttribute('title') || el.value || '').trim().slice(0,80);
    if (!label || seen.has(label)) return;
    seen.add(label);
    els.push(el.tagName.toLowerCase()+': '+label);
  });
  return els.length ? els.join('\\n') : 'No interactive elements found';
})()
`);
      }

      case 'get_media_state': {
        // Get the current state of any video/audio element on the page.
        // Returns: state (PLAYING/PAUSED), current time, duration, volume, source.
        if (platform() !== 'darwin') return header + `print("get_media_state requires macOS + Chrome")`;
        return this._chromeJs(JSON.stringify(''), `
(function() {
  var v = document.querySelector('video,audio');
  if (!v) return 'No media on this page';
  return JSON.stringify({
    state: v.paused ? 'PAUSED' : 'PLAYING',
    time: v.currentTime.toFixed(1)+'s',
    duration: isFinite(v.duration) ? v.duration.toFixed(1)+'s' : 'live/unknown',
    muted: v.muted,
    volume: Math.round(v.volume*100)+'%',
    title: document.title.slice(0,80)
  });
})()
`);
      }

      case 'scroll_to': {
        // Scroll the page to a specific element by CSS selector, or scroll by direction + amount.
        if (platform() !== 'darwin') return header + `print("scroll_to requires macOS + Chrome")`;
        const sel = String(input.selector ?? '').trim();
        const scrollDir = String(input.direction ?? 'down').toLowerCase();
        const scrollAmt = input.amount != null ? Number(input.amount) : 400;
        if (sel) {
          return this._chromeJs(JSON.stringify(sel), `
(function(s){var el=document.querySelector(s);if(!el)return 'NOT_FOUND: '+s;el.scrollIntoView({behavior:'instant',block:'center'});return 'Scrolled to: '+s;})(JSARG)
`);
        }
        const scrollY = scrollDir === 'up' ? -scrollAmt : scrollDir === 'down' ? scrollAmt : 0;
        const scrollX = scrollDir === 'left' ? -scrollAmt : scrollDir === 'right' ? scrollAmt : 0;
        return this._chromeJs(JSON.stringify([scrollX, scrollY]), `
(function(xy){window.scrollBy(xy[0],xy[1]);return 'Scrolled';} )(JSARG)
`);
      }

      case 'accessibility_click': {
        // Click a button/element in a native macOS app (WhatsApp, Finder, etc.)
        // using the Accessibility API — NO Screen Recording needed, just Accessibility permission.
        const appName = String(input.app ?? '').trim();
        const elemLabel = String(input.element ?? text ?? '').trim();
        if (!appName || !elemLabel) return null;
        const osName = platform();
        if (osName !== 'darwin') return header + `print("accessibility_click is macOS only")`;
        const safeApp = appName.replace(/'/g, "\\'");
        const safeElem = elemLabel.replace(/'/g, "\\'");
        return header + `
import subprocess, time

# Bring app to foreground
subprocess.run(['osascript', '-e', 'tell application "${safeApp}" to activate'], capture_output=True)
time.sleep(0.5)

# Try clicking by name, then by description, then by value
attempts = [
    f'''tell application "System Events" to tell process "${safeApp}" to click (first UI element of front window whose name contains "${safeElem}")''',
    f'''tell application "System Events" to tell process "${safeApp}" to click (first button whose description contains "${safeElem}")''',
    f'''tell application "System Events" to tell process "${safeApp}" to click (first UI element whose value contains "${safeElem}")''',
]

success = False
for script in attempts:
    r = subprocess.run(['osascript', '-e', script], capture_output=True, text=True)
    if r.returncode == 0:
        print(f"Clicked '{${JSON.stringify(elemLabel)}}' in ${safeApp}")
        success = True
        break

if not success:
    # Last resort: try clicking the front window element matching description
    list_script = f"""tell application "System Events"
  tell process "${safeApp}"
    return name of every UI element of front window
  end tell
end tell"""
    lr = subprocess.run(['osascript', '-e', list_script], capture_output=True, text=True)
    print(f"Could not find element '${safeElem}' in ${safeApp}")
    print(f"Available elements: {lr.stdout.strip()[:300] or 'could not list'}")
`;
      }

      case 'cdp_screenshot': {
        // Take a screenshot via Chrome DevTools Protocol — does NOT need Screen Recording.
        // Requires Chrome to be running with --remote-debugging-port=9222.
        // If CDP is unavailable, falls back to browser state (URL + title + media state).
        if (platform() !== 'darwin') return header + `print("cdp_screenshot is macOS only for now")`;
        return header + `
import urllib.request, json, base64, os, tempfile, subprocess

def get_browser_state():
    simple_scr = """tell application "Google Chrome"
  tell front window
    tell active tab
      return URL & "|||" & title
    end tell
  end tell
end tell"""
    r = subprocess.run(['osascript', '-e', simple_scr], capture_output=True, text=True)
    parts = r.stdout.strip().split('|||')
    if len(parts) >= 2:
        print(f"[No CDP screenshot] Tab: {parts[1]}")
        print(f"URL: {parts[0]}")
    else:
        print("[No CDP screenshot — Chrome not running or no active tab]")
    print("To enable screenshots without Screen Recording, start Chrome with:")
    print("  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222")

try:
    tabs_raw = urllib.request.urlopen('http://localhost:9222/json', timeout=2).read()
    tabs = json.loads(tabs_raw)
    if not tabs:
        raise Exception("No tabs available")
    ws_url = tabs[0].get('webSocketDebuggerUrl', '')
    if not ws_url:
        raise Exception("No WebSocket URL")

    # Auto-install websockets if needed
    try:
        import websockets
    except ImportError:
        subprocess.run(['pip3', 'install', 'websockets', '-q'], capture_output=True, timeout=60)
        import websockets

    import asyncio

    async def capture():
        async with websockets.connect(ws_url) as ws:
            await ws.send(json.dumps({'id':1,'method':'Page.captureScreenshot','params':{'format':'jpeg','quality':75}}))
            resp = json.loads(await ws.recv())
            return resp.get('result', {}).get('data')

    img_b64 = asyncio.run(capture())
    if not img_b64:
        raise Exception("No screenshot data returned")

    out_path = os.path.join(tempfile.gettempdir(), '0agent_cdp_shot.jpg')
    with open(out_path, 'wb') as f:
        f.write(base64.b64decode(img_b64))

    print(f"Screenshot: {out_path}")
    print(f"Tab: {tabs[0].get('title','?')} — {tabs[0].get('url','?')[:80]}")

    try:
        import pytesseract
        from PIL import Image
        img = Image.open(out_path)
        text = pytesseract.image_to_string(img, config='--psm 11')
        lines = [l.strip() for l in text.splitlines() if l.strip()]
        if lines:
            print("On-screen text (OCR):\\n" + "\\n".join(lines[:50]))
    except Exception:
        print("(OCR not available — install pytesseract for text extraction)")

except Exception as e:
    get_browser_state()
`;
      }

      case 'exec_js': {
        // Run arbitrary JavaScript in the current Chrome tab via AppleScript.
        // Does NOT require Screen Recording permission — works for any web page.
        const js = String(input.js ?? '').trim();
        if (!js) return null;
        const osName = platform();
        if (osName !== 'darwin') {
          return header + `print("exec_js requires macOS + Google Chrome")`;
        }
        // JSON-encode the JS so Python can safely decode it (handles all special chars)
        const jsJson = JSON.stringify(js);
        return header + `
import subprocess, json, os, tempfile

js = json.loads(${jsJson})
tmpjs = os.path.join(tempfile.gettempdir(), f"0agent_execjs_{os.getpid()}.js")
with open(tmpjs, 'w') as f:
    f.write(js)

as_script = f'''tell application "Google Chrome"
  tell front window
    tell active tab
      set jsCode to do shell script "cat '{tmpjs}'"
      return execute javascript jsCode
    end tell
  end tell
end tell'''

r = subprocess.run(['osascript', '-e', as_script], capture_output=True, text=True)
try: os.remove(tmpjs)
except: pass

if r.returncode == 0:
    print(r.stdout.strip() if r.stdout.strip() else "(no return value)")
else:
    print(f"JS error: {r.stderr.strip()[:300]}")
`;
      }

      case 'browser_state': {
        // Get current Chrome tab URL + title via AppleScript.
        // No Screen Recording needed. Use after any browser action to verify state.
        const osName = platform();
        if (osName !== 'darwin') {
          return header + `print("browser_state requires macOS + Google Chrome")`;
        }
        return header + `
import subprocess

as_script = '''tell application "Google Chrome"
  tell front window
    tell active tab
      return URL & "|||" & title
    end tell
  end tell
end tell'''

r = subprocess.run(['osascript', '-e', as_script], capture_output=True, text=True)
out = r.stdout.strip()
if '|||' in out:
    parts = out.split('|||', 1)
    print(f"URL: {parts[0]}")
    print(f"Title: {parts[1]}")
else:
    print(out or r.stderr.strip() or "Chrome not running or no active tab")
`;
      }

      default:
        return null;
    }
  }

  /**
   * Generate a Python script that runs JS in the current Chrome tab via AppleScript.
   * jsArgJson is passed as variable JSARG inside the JS template.
   * No Screen Recording needed — uses Chrome's built-in execute javascript.
   */
  private _chromeJs(jsArgJson: string, jsTemplate: string): string {
    const finalJs = `var JSARG = ${jsArgJson};\n${jsTemplate.trim()}`;
    const jsJson = JSON.stringify(finalJs);
    return `
import subprocess, json, os, tempfile

js = json.loads(${jsJson})
tmpjs = os.path.join(tempfile.gettempdir(), f"0agent_cjs_{os.getpid()}.js")
with open(tmpjs, 'w') as f:
    f.write(js)
as_script = f"""tell application "Google Chrome"
  tell front window
    tell active tab
      set jsCode to do shell script "cat '{tmpjs}'"
      return execute javascript jsCode
    end tell
  end tell
end tell"""
r = subprocess.run(['osascript', '-e', as_script], capture_output=True, text=True)
try: os.remove(tmpjs)
except: pass
result = r.stdout.strip()
if r.returncode != 0:
    print(f"JS error: {r.stderr.strip()[:300]}")
elif result.startswith('NOT_FOUND:'):
    print(f"Not found: {result[10:]} — call get_elements to see available elements")
elif result.startswith('CLICKED:') or result.startswith('TYPED'):
    print(f"OK {result}")
else:
    print(result if result else "(no return value)")
`;
  }
}
