/**
 * TTY-aware progress reporter for CLI commands.
 *
 * - When stderr is a TTY: overwrites the current line with \r
 * - When piped/CI: prints one line per phase
 */
export class ProgressReporter {
  private isTTY: boolean;
  private startTime: number;

  constructor() {
    this.isTTY = process.stderr.isTTY === true;
    this.startTime = Date.now();
  }

  phase(label: string, done?: number, total?: number): void {
    const suffix = done != null && total != null && total > 0
      ? `  (${done.toLocaleString()}/${total.toLocaleString()})`
      : done != null
      ? `  (${done.toLocaleString()})`
      : "";

    const line = `  ${label}${suffix}`;

    if (this.isTTY) {
      process.stderr.write(`\r${line.padEnd(72)}`);
    } else {
      process.stderr.write(line + "\n");
    }
  }

  progress(label: string, done: number, total: number): void {
    if (total === 0) return;
    const pct = Math.floor((done / total) * 20);
    const bar = "=".repeat(pct) + " ".repeat(20 - pct);
    const line = `  ${label}  [${bar}] ${done}/${total}`;

    if (this.isTTY) {
      process.stderr.write(`\r${line.padEnd(72)}`);
    } else if (done === total) {
      process.stderr.write(`  ${label}  done (${total})\n`);
    }
  }

  done(message: string): void {
    if (this.isTTY) process.stderr.write("\n");
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    process.stderr.write(`\n  ${message}  (${elapsed}s)\n\n`);
  }

  error(message: string): void {
    if (this.isTTY) process.stderr.write("\n");
    process.stderr.write(`\nError: ${message}\n`);
  }
}
