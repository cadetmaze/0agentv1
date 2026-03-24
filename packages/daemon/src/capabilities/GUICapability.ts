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
 *   open_app        — open an application by name (macOS/Linux)
 */

import type { Capability, CapabilityResult, ToolDefinition } from './types.js';
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir, platform } from 'node:os';

export class GUICapability implements Capability {
  readonly name = 'gui_automation';
  readonly description = 'Automate desktop GUI — click, type, screenshot, hotkeys, find text on screen.';

  readonly toolDefinition: ToolDefinition = {
    name: 'gui_automation',
    description:
      'Automate desktop GUI interactions. ' +
      'Take screenshots to see the current screen state, click on buttons/links/fields, ' +
      'type text, press keyboard shortcuts, scroll, open apps. ' +
      'IMPORTANT: Limit screenshots to at most 3 per task — avoid re-screenshotting if you already know the layout. ' +
      'Prefer targeted actions (click, find_and_click, hotkey) over repeated screenshots. ' +
      'Use get_cursor_pos to check cursor position without a full screenshot.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description:
            '"screenshot" | "click" | "double_click" | "right_click" | "move" | ' +
            '"type" | "hotkey" | "scroll" | "drag" | "find_and_click" | ' +
            '"get_screen_size" | "get_cursor_pos" | "open_app"',
        },
        x:         { type: 'number',  description: 'X coordinate (pixels from left)' },
        y:         { type: 'number',  description: 'Y coordinate (pixels from top)' },
        to_x:      { type: 'number',  description: 'End X for drag' },
        to_y:      { type: 'number',  description: 'End Y for drag' },
        text:      { type: 'string',  description: 'Text to type, or text to search for (find_and_click)' },
        keys:      { type: 'string',  description: 'Hotkey combo e.g. "cmd+c", "ctrl+z", "alt+tab", "enter"' },
        direction: { type: 'string',  description: '"up" | "down" | "left" | "right" for scroll' },
        amount:    { type: 'number',  description: 'Scroll clicks (default 3)' },
        app:       { type: 'string',  description: 'App name to open e.g. "Safari", "Terminal", "Chrome"' },
        interval:  { type: 'number',  description: 'Seconds to wait between actions (default 0.05)' },
        duration:  { type: 'number',  description: 'Seconds for mouse movement animation (default 0.2)' },
      },
      required: ['action'],
    },
  };

  async execute(input: Record<string, unknown>, _cwd: string): Promise<CapabilityResult> {
    const action = String(input.action ?? '').toLowerCase().trim();
    const start  = Date.now();

    const script = this._buildScript(action, input);
    if (!script) {
      return { success: false, output: `Unknown GUI action: "${action}". Valid: screenshot, click, double_click, right_click, move, type, hotkey, scroll, drag, find_and_click, get_screen_size, get_cursor_pos, open_app`, duration_ms: 0 };
    }

    // Write to a temp file so we don't hit inline quoting limits
    const tmpFile = resolve(tmpdir(), `0agent_gui_${Date.now()}.py`);
    writeFileSync(tmpFile, script, 'utf8');

    const result = spawnSync('python3', [tmpFile], { timeout: 30_000, encoding: 'utf8' });
    try { unlinkSync(tmpFile); } catch {}

    if (result.status !== 0) {
      const err = String(result.stderr ?? '').trim();

      // Auto-install pyautogui on first use
      if (err.includes('No module named') || err.includes("ModuleNotFoundError")) {
        const missing = err.includes('pyautogui') ? 'pyautogui pillow pytesseract'
          : err.includes('PIL')        ? 'pillow'
          : err.includes('tesseract')  ? 'pytesseract'
          : 'pyautogui pillow';

        const install = spawnSync('pip3', ['install', ...missing.split(' '), '-q'], {
          timeout: 60_000, encoding: 'utf8',
        });
        if (install.status !== 0) {
          return { success: false, output: `Auto-install failed: ${install.stderr?.slice(0, 200)}. Run: pip3 install ${missing}`, duration_ms: Date.now() - start };
        }
        // Retry after install
        const retry = spawnSync('python3', [tmpFile], { timeout: 30_000, encoding: 'utf8' });
        // tmpFile was already deleted; rewrite
        writeFileSync(tmpFile, script, 'utf8');
        const retry2 = spawnSync('python3', [tmpFile], { timeout: 30_000, encoding: 'utf8' });
        try { unlinkSync(tmpFile); } catch {}
        if (retry2.status === 0) {
          return { success: true, output: retry2.stdout.trim() || 'Done', duration_ms: Date.now() - start };
        }
        return { success: false, output: retry2.stderr?.trim() || 'Unknown error after install', duration_ms: Date.now() - start };
      }

      // macOS accessibility permission error
      if (err.includes('accessibility') || err.includes('permission') || err.includes('AXIsProcessTrusted')) {
        return {
          success: false,
          output: 'macOS accessibility permission required. Go to: System Preferences → Privacy & Security → Accessibility → add Terminal (or the app running 0agent)',
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
        // Escape special chars for Python string
        const escaped = text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
        return header + `
pyautogui.write(${JSON.stringify(text)}, interval=${interval})
print(f"Typed: ${JSON.stringify(text.slice(0, 40))}...")
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

try:
    if found:
        cx, cy, word = found[0]
        pyautogui.click(cx, cy, duration=${duration})
        print(f"Found '{word}' at ({cx},{cy}) — clicked")
    else:
        print(f"Text '${safeText}' not found on screen. Take a screenshot to see current state.")
        sys.exit(1)
finally:
    try:
        os.remove(shot_path)
    except Exception:
        pass
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

      default:
        return null;
    }
  }
}
