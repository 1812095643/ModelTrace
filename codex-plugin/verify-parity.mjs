// Offline regression against real previously collected references, not new monitoring accuracy.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadArtifacts } from './modeltrace-guard/scripts/guard.mjs';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const rows = (await readFile(path.join(repo, 'data', 'gpt_reference.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
const { bank, analyzeGlobalOutputs } = await loadArtifacts();
const models = bank.models.filter((model) => model.family === 'gpt').map((model) => model.id);
assert.ok(models.length > 0, 'Packaged bank has no GPT models');
const cases = models.flatMap((model) => {
  const selected = rows.filter((row) => row.model_id === model && row.strict_valid).slice(0, 3);
  assert.equal(selected.length, 3, `Missing saved references for ${model}`);
  return [1, 3].map((k) => ({ model, outputs: selected.slice(0, k).map((row) => ({ text: row.text, expected_count: row.requested_count })) }));
});
const python = spawnSync(process.env.MODELTRACE_PYTHON || 'python', ['-c',
  'import json,sys; from fingerprint import analyze_global_outputs; bank=json.load(open("data/unified_bank.json",encoding="utf-8")); print(json.dumps([analyze_global_outputs(case["outputs"],bank) for case in json.load(sys.stdin)]))',
], { cwd: repo, input: JSON.stringify(cases), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30000 });
assert.equal(python.status, 0, python.stderr);
const expected = JSON.parse(python.stdout);
let largestError = 0;
for (const [index, item] of cases.entries()) {
  const actual = analyzeGlobalOutputs(item.outputs, bank);
  assert.equal(actual.prediction, expected[index].prediction);
  for (const result of actual.results) {
    const reference = expected[index].results.find((candidate) => candidate.model === result.model);
    const error = Math.abs(reference.probability - result.probability);
    largestError = Math.max(largestError, error);
    assert.ok(error < 1e-10, `${item.model}: ${error}`);
  }
}
process.stdout.write(JSON.stringify({ cases: cases.length, passed: true, largestProbabilityDifference: largestError, note: 'Saved-reference scorer parity only, not same-context or multilingual detection calibration.' }) + '\n');
