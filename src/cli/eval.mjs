// Grades the auditor against the fixtures: npm run eval [-- --tier see]
// A vulnerable fixture passes when every expected pattern is reported at or above minSeverity.
// A safe fixture passes when nothing at Low or above is reported.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAudit } from '../engine/index.mjs';

const ORDER = ['Info', 'Low', 'Medium', 'High', 'Critical'];
const rank = (s) => ORDER.indexOf(s);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures');
const tierFlag = process.argv.indexOf('--tier');
const tier = tierFlag > 0 ? process.argv[tierFlag + 1] : 'see';

const fixtures = readdirSync(root).filter((name) => !name.startsWith('.'));
const results = await Promise.all(fixtures.map(async (name) => {
  const expected = JSON.parse(readFileSync(join(root, name, 'expected.json'), 'utf8'));
  const code = readFileSync(join(root, name, 'contract.ak'), 'utf8');
  try {
    const { review } = await runAudit({ tier, source: { kind: 'code', code }, jobId: `eval-${name}`, buyerNotes: expected.description });
    let pass;
    let detail;
    if (expected.vulnerable) {
      const missing = expected.expectedPatterns.filter((p) => !review.findings.some(
        (f) => f.pattern_id === p.id && rank(f.severity) >= rank(expected.minSeverity)));
      pass = missing.length === 0;
      detail = pass ? 'found' : `missed #${missing.map((p) => p.id).join(', #')} at ${expected.minSeverity}+`;
    } else {
      const noisy = review.findings.filter((f) => rank(f.severity) >= rank('Low'));
      pass = noisy.length === 0;
      detail = pass ? 'no false alarms' : `${noisy.length} false alarm(s) at Low+`;
    }
    const got = review.findings.map((f) => `${f.severity}#${f.pattern_id ?? '-'}`).join(' ') || 'none';
    return { name, pass, detail, got };
  } catch (error) {
    return { name, pass: false, detail: `error: ${error.message.slice(0, 120)}`, got: '-' };
  }
}));

for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(28)} ${r.detail.padEnd(32)} findings: ${r.got}`);
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} fixtures passed (tier ${tier}).`);
process.exitCode = passed === results.length ? 0 : 1;
