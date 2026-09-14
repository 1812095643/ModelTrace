import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Offline evaluation only: no collection, training, threshold fitting or bank
// mutations. Ground truth must come from the evaluation operator, not predictions.
export function evaluateCalibration(rows) {
  if (!Array.isArray(rows) || !rows.length) return { calibrated: false, reason: 'No independent held-out fork evaluation records supplied', groups: [] };
  const groups = new Map(), seen = new Set();
  for (const row of rows) {
    if (row.split !== 'holdout' || row.mode !== 'ephemeral_fork' || row.groundTruthSource !== 'controlled_endpoint'
      || !row.groundTruthModel || !row.expectedModel || !row.prediction || !row.language || !row.snapshotId || !row.bankSha256 || !row.sampleId
      || !Number.isInteger(row.retryIndex) || row.retryIndex < 0 || !Number.isInteger(row.retryTarget) || row.retryTarget < 1 || row.retryIndex > row.retryTarget) throw new Error('Each evaluation row needs independent holdout provenance, fork context, labels and retry metadata');
    if (seen.has(row.sampleId)) throw new Error('Duplicate evaluation sample'); seen.add(row.sampleId);
    const key = JSON.stringify([row.groundTruthModel, row.expectedModel, row.language, row.bankSha256]);
    if (!groups.has(key)) groups.set(key, { truth: row.groundTruthModel, expected: row.expectedModel, language: row.language, bankSha256: row.bankSha256, samples: 0, differentCandidate: 0, batches: new Map() });
    const group = groups.get(key); group.samples++; group.differentCandidate += Number(row.prediction !== row.expectedModel);
    let batch = group.batches.get(row.snapshotId);
    if (!batch) { batch = { target: row.retryTarget, rows: new Map() }; group.batches.set(row.snapshotId, batch); }
    if (batch.target !== row.retryTarget || batch.rows.has(row.retryIndex)) throw new Error('Conflicting or repeated retry within a snapshot');
    batch.rows.set(row.retryIndex, row);
  }
  return {
    calibrated: false, evaluationOnly: true,
    note: 'Observed held-out rates, grouped by frozen context; not an independence assumption, certification or fitted threshold.',
    groups: [...groups.values()].map(({ batches, ...group }) => {
      const complete = [...batches.values()].filter((b) => b.rows.size === b.target + 1);
      const halted = complete.filter((b) => b.rows.get(0).prediction !== group.expected && [...b.rows.values()].filter((r) => r.retryIndex > 0).every((r) => r.prediction !== group.expected));
      const same = group.truth === group.expected;
      return { ...group, mismatchRate: group.differentCandidate / group.samples, completeBatches: complete.length,
        incompleteBatches: batches.size - complete.length, allRetriesMismatchRate: complete.length ? halted.length / complete.length : null,
        rateMeaning: same ? 'observed_false_alert_and_false_halt_rates' : 'observed_detection_and_halt_rates' };
    }),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rows = process.argv[2] ? (await readFile(process.argv[2], 'utf8')).split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line)) : [];
  process.stdout.write(JSON.stringify(evaluateCalibration(rows), null, 2) + '\n');
}
