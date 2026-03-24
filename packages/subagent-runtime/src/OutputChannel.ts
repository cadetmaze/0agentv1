const OUTPUT_SENTINEL = '__OUTPUT_END__';

/**
 * Writes structured JSON output to stdout with a sentinel marker.
 *
 * The parent orchestrator reads stdout and splits on the sentinel
 * to extract the subagent's result payload.
 */
export class OutputChannel {
  write(data: Record<string, unknown>): void {
    const json = JSON.stringify(data);
    process.stdout.write(json + '\n' + OUTPUT_SENTINEL + '\n');
  }
}
