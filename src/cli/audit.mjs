// Offline audit: npm run audit -- <contract.ak | GitHub URL> [--tier see|write|audit]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGithub, TIER_NAMES } from '../engine/input.mjs';
import { runAudit } from '../engine/index.mjs';

const args = process.argv.slice(2);
const tierFlag = args.indexOf('--tier');
const tier = tierFlag >= 0 ? args[tierFlag + 1] : 'see';
const target = args.find((a, i) => !a.startsWith('--') && (tierFlag < 0 || i !== tierFlag + 1));
if (!target || !TIER_NAMES.includes(tier)) {
  console.error('Usage: npm run audit -- <contract.ak | https://github.com/...> [--tier see|write|audit]');
  process.exit(1);
}

const github = target.startsWith('https://') ? parseGithub(target) : null;
const source = github ? { kind: 'github', ...github } : { kind: 'code', code: readFileSync(target, 'utf8') };
const name = github ? `${github.display.split('/').slice(3, 5).join('-')}` : basename(dirname(resolve(target))) + '-' + basename(target, '.ak');

const started = performance.now();
const result = await runAudit({ tier, source, jobId: `cli-${name}-${tier}`, log: (m) => console.error(`… ${m}`) });

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../.local/reports');
mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, `${name}-${tier}.md`);
writeFileSync(outPath, result.report);

const tokens = result.usages.reduce((sum, u) => sum + (u?.total_tokens ?? 0), 0);
console.log(JSON.stringify({
  report: outPath,
  seconds: Math.round((performance.now() - started) / 1000),
  compiled: result.check.ok,
  overallRisk: result.review.overall_risk,
  findings: result.review.findings.map((f) => `${f.severity}: ${f.title} (${f.location}) [#${f.pattern_id ?? '-'}]`),
  fix: result.fix ? { attempts: result.fix.attempts, compiles: Boolean(result.fix.check?.ok) } : null,
  tokens,
}, null, 2));
