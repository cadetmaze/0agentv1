import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import type { MCPServerConfig } from './types.js';

export interface DiscoveryResult {
  servers: MCPServerConfig[];
  source: '.mcp.json' | '.0agent/mcp.yaml' | '.cursor/mcp.json' | 'package.json';
  found_at: string;
}

interface RawServerEntry {
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

type RawServersMap = Record<string, RawServerEntry>;

export class MCPDiscovery {
  /**
   * Scan the project directory for MCP server configs from 4 sources.
   * Returns all found results (does not stop at first match).
   */
  discover(cwd: string): DiscoveryResult[] {
    const results: DiscoveryResult[] = [];

    // 1. .mcp.json
    const mcpJsonPath = join(cwd, '.mcp.json');
    this.tryParseJsonSource(mcpJsonPath, '.mcp.json', results);

    // 2. .0agent/mcp.yaml
    const yamlPath = join(cwd, '.0agent', 'mcp.yaml');
    this.tryParseYamlSource(yamlPath, results);

    // 3. .cursor/mcp.json
    const cursorPath = join(cwd, '.cursor', 'mcp.json');
    this.tryParseJsonSource(cursorPath, '.cursor/mcp.json', results);

    // 4. package.json → mcpServers field
    const pkgPath = join(cwd, 'package.json');
    this.tryParsePackageJson(pkgPath, results);

    return results;
  }

  private tryParseJsonSource(
    filePath: string,
    source: '.mcp.json' | '.cursor/mcp.json',
    results: DiscoveryResult[],
  ): void {
    if (!existsSync(filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8'));
      const servers = this.parseServersMap(raw?.mcpServers as RawServersMap | undefined);
      if (servers.length > 0) {
        results.push({ servers, source, found_at: filePath });
      }
    } catch (err) {
      console.warn(`[MCPDiscovery] Failed to parse ${filePath}: ${(err as Error).message}`);
    }
  }

  private tryParseYamlSource(filePath: string, results: DiscoveryResult[]): void {
    if (!existsSync(filePath)) return;
    try {
      const raw = YAML.parse(readFileSync(filePath, 'utf8'));
      const servers = this.parseServersMap(raw?.mcpServers as RawServersMap | undefined);
      if (servers.length > 0) {
        results.push({ servers, source: '.0agent/mcp.yaml', found_at: filePath });
      }
    } catch (err) {
      console.warn(`[MCPDiscovery] Failed to parse ${filePath}: ${(err as Error).message}`);
    }
  }

  private tryParsePackageJson(filePath: string, results: DiscoveryResult[]): void {
    if (!existsSync(filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8'));
      const servers = this.parseServersMap(raw?.mcpServers as RawServersMap | undefined);
      if (servers.length > 0) {
        results.push({ servers, source: 'package.json', found_at: filePath });
      }
    } catch (err) {
      console.warn(`[MCPDiscovery] Failed to parse ${filePath}: ${(err as Error).message}`);
    }
  }

  private parseServersMap(map: RawServersMap | undefined): MCPServerConfig[] {
    if (!map || typeof map !== 'object') return [];
    const configs: MCPServerConfig[] = [];
    for (const [name, entry] of Object.entries(map)) {
      if (!entry || typeof entry !== 'object') continue;
      configs.push({
        name,
        command: entry.command,
        args: entry.args,
        url: entry.url,
        env: entry.env,
        enabled: true,
      });
    }
    return configs;
  }
}
