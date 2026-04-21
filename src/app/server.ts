/**
 * GitHub App webhook server — Phase 4.
 * This is a stub that will be implemented in Phase 4.
 */

export interface AppServerOptions {
  port: number;
  secret: string;
  appId: string;
  privateKeyPath: string;
}

export async function startAppServer(opts: AppServerOptions): Promise<void> {
  // Phase 4 implementation: Hono webhook server
  console.error(`GitHub App server is not yet implemented (Phase 4).`);
  console.error(`Port: ${opts.port}`);
  process.exit(1);
}
