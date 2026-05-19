// CLI vstupní bod pro AI worker.
// Spuštění: `npm run ai-worker` z server/ nebo `npm run --prefix server ai-worker` z rootu.
//
// Načte env (s override), připraví DB (migrace), zvaliduje config a spustí worker loop.
// SIGINT / SIGTERM provedou čistý shutdown skrz installSignalHandlers v workeru.

import '../env.js';
import { migrate, runFileMigrations } from '../db.js';
import { agentConfig, validateAgentConfig, describeAgentConfig } from './config.js';
import { runWorker } from './worker.js';

async function main() {
  console.log('[ai-worker] startup config:', JSON.stringify(describeAgentConfig(agentConfig)));

  if (!agentConfig.enabled) {
    console.error('[ai-worker] AI_AGENT_ENABLED=false. Nastav v .env a zkus znovu.');
    process.exit(2);
  }
  const v = validateAgentConfig(agentConfig);
  if (!v.ok) {
    console.error('[ai-worker] nevalidní config:');
    for (const e of v.errors) console.error('  •', e);
    process.exit(2);
  }

  // Zajistíme aktuální schéma – idempotentní, nezatěžuje
  await migrate();
  await runFileMigrations();

  // Worker zařídí signal handlery a uvolnění pool poolu sám
  await runWorker({
    repoRoot: process.env.AI_AGENT_REPO_ROOT || process.cwd(),
  });
  process.exit(0);
}

main().catch((err) => {
  console.error('[ai-worker] fatal:', err?.stack || err?.message || err);
  process.exit(1);
});
