// Test-only adapter for deterministic scoring/control fixtures. It never calls
// a real model and is not an installed CLI entry point or a monitoring receipt.
import { run as command, submitForkResult } from '../scripts/guard.mjs';
export async function run(args, env = {}) {
  if (args[0] !== 'submit') return command(args, env);
  const flags = Object.fromEntries(Array.from({ length: (args.length - 1) / 2 }, (_, i) => [args[1 + i * 2], args[2 + i * 2]]));
  return submitForkResult(flags['--data-dir'], flags['--session'], flags['--challenge'], flags['--numbers'], {
    mode: 'ephemeral_fork', cleanedUp: true, fixture: true,
    snapshot: { sha256: 'synthetic-fixture-snapshot' },
  });
}
