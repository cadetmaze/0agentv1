import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import YAML from "yaml";
import { DaemonConfigSchema, type DaemonConfig } from "./ConfigSchema.js";

const DEFAULT_CONFIG_PATH = resolve(homedir(), ".0agent", "config.yaml");

const DEFAULT_GRAPH_CONFIG = {
  db_path: resolve(homedir(), ".0agent", "graph.db"),
  hnsw_path: resolve(homedir(), ".0agent", "hnsw.bin"),
  object_store_path: resolve(homedir(), ".0agent", "objects"),
};

export async function loadConfig(
  configPath: string = DEFAULT_CONFIG_PATH,
): Promise<DaemonConfig> {
  if (!existsSync(configPath)) {
    throw new Error(
      `Config file not found: ${configPath}\nRun '0agent init' to create one.`,
    );
  }

  const raw = readFileSync(configPath, "utf8");
  const parsed = YAML.parse(raw);

  // Apply defaults for graph paths if not specified
  if (!parsed.graph) {
    parsed.graph = DEFAULT_GRAPH_CONFIG;
  }

  const result = DaemonConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid config:\n${issues}`);
  }

  return result.data;
}

export function getDefaultLLM(config: DaemonConfig) {
  return (
    config.llm_providers.find((p) => p.is_default) ?? config.llm_providers[0]
  );
}
