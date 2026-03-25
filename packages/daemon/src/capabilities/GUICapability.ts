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
      'Desktop GUI automation — click, type, hotkeys, open URLs/apps. ' +
      'exec_js: run JavaScript in the current Chrome tab — use this to interact with web pages ' +
      '(click buttons, fill inputs, check state) WITHOUT needing Screen Recording permission. ' +
      'browser_state: get current Chrome tab URL + title — verify navigation without Screen Recording. ' +
      'open_url: for video pages (YouTube/YTM) navigates current tab and returns actual playing state. ' +
      'ALWAYS call browser_state or exec_js after open_url to verify the page loaded correctly.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description:
            '"screenshot" | "click" | "double_click" | "right_click" | "move" | ' +
            '"type" | "hotkey" | "scroll" | "drag" | "find_and_click" | ' +
            '"get_screen_size" | "get_cursor_pos" | "wait" | "open_url" | "open_app" | ' +
            '"exec_js" | "browser_state"',
        },
        js: { type: 'string', description: 'JavaScript to run in current Chrome tab (use with exec_js action). Returns the result. Example: "document.querySelector(\'video\').paused"' },
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

      // macOS Screen Recording permission error (screenshot/find_and_click)
      if (err.includes('could not create image from display') || err.includes('screencapture') || err.includes('CGDisplayStream')) {
        if (platform() === 'darwin') {
          spawnSync('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'], { timeout: 3000 });
        }
        return {
          success: false,
          output:
            'macOS Screen Recording permission required for screenshots.\n' +
            '→ System Settings has been opened automatically.\n' +
            '→ Go to: Privacy & Security → Screen Recording → enable Terminal (or iTerm2)\n' +
            '→ Then re-run your task.',
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
        return header + `
pyautogui.write(${JSON.stringify(text)}, interval=${interval})
print("Typed successfully")
`;
      }

      case 'hotkey': {
        if (!keys) return null;
        // Parse "cmd+c" → ["command", "c"],  "ctrl+shift+t" → ["ctrl","shift","t"]
        const parts = keys.toLowerCase()
          .replace(/cmd|command|meta/g, 'command')
          .replace(/ctrl|control/g, 'ctrl')
          .replace(/opt|option/g, 'option')
          .split(/[+\-]/)
          .map(k => k.trim())
          .filter(Boolean);
        const pyKeys = JSON.stringify(parts);
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
}
