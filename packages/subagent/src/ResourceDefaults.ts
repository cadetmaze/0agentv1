import type { TaskType } from './CapabilityToken.js';

export interface ResourceConfig {
  max_duration_ms: number;
  max_llm_calls: number;
  max_llm_tokens: number;
  max_tool_calls: number;
  allowed_tools: string[];
  network_access: 'none' | 'allowlist' | 'full';
  filesystem_access: 'none' | 'readonly' | 'scoped';
  has_browser?: boolean;
  has_display?: boolean;
  memory_mb: number;
  cpus: number;
}

export const RESOURCE_DEFAULTS: Record<TaskType, ResourceConfig> = {
  web_research: {
    max_duration_ms: 5 * 60 * 1000,
    max_llm_calls: 20,
    max_llm_tokens: 50_000,
    max_tool_calls: 50,
    allowed_tools: ['web_search', 'web_fetch', 'read_url', 'summarize'],
    network_access: 'full',
    filesystem_access: 'none',
    has_browser: false,
    has_display: false,
    memory_mb: 512,
    cpus: 1,
  },
  code_execution: {
    max_duration_ms: 2 * 60 * 1000,
    max_llm_calls: 10,
    max_llm_tokens: 20_000,
    max_tool_calls: 20,
    allowed_tools: ['run_code', 'read_file', 'write_file', 'list_files'],
    network_access: 'none',
    filesystem_access: 'scoped',
    has_browser: false,
    has_display: false,
    memory_mb: 512,
    cpus: 1,
  },
  browser_task: {
    max_duration_ms: 10 * 60 * 1000,
    max_llm_calls: 30,
    max_llm_tokens: 80_000,
    max_tool_calls: 100,
    allowed_tools: ['browser_navigate', 'browser_click', 'browser_type', 'browser_screenshot', 'browser_eval'],
    network_access: 'full',
    filesystem_access: 'none',
    has_browser: true,
    has_display: true,
    memory_mb: 1024,
    cpus: 2,
  },
  file_editing: {
    max_duration_ms: 3 * 60 * 1000,
    max_llm_calls: 15,
    max_llm_tokens: 30_000,
    max_tool_calls: 40,
    allowed_tools: ['read_file', 'write_file', 'edit_file', 'list_files', 'search_files'],
    network_access: 'none',
    filesystem_access: 'scoped',
    has_browser: false,
    has_display: false,
    memory_mb: 256,
    cpus: 1,
  },
  send_message: {
    max_duration_ms: 1 * 60 * 1000,
    max_llm_calls: 5,
    max_llm_tokens: 5_000,
    max_tool_calls: 5,
    allowed_tools: ['send_email', 'send_slack', 'send_sms'],
    network_access: 'allowlist',
    filesystem_access: 'none',
    has_browser: false,
    has_display: false,
    memory_mb: 128,
    cpus: 1,
  },
};
