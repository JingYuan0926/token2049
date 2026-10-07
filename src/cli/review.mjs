// Human review for the Audit tier.
//   npm run review -- list
//   npm run review -- show <taskId>
//   npm run review -- approve <taskId> [--reviewer "Name"] [--notes "Text"]
// To edit the findings first, edit .local/tasks/<taskId>.json (renderArgs.review), then approve.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TASKS = resolve(dirname(fileURLToPath(import.meta.url)), '../../.local/tasks');
const [command, id] = process.argv.slice(2);
const flag = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

if (command === 'list') {
  const pending = readdirSync(TASKS).filter((f) => f.endsWith('.draft.md')).map((f) => f.replace('.draft.md', ''))
    .filter((t) => !existsSync(join(TASKS, `${t}.approved.json`)));
  console.log(pending.length ? pending.join('\n') : 'No reports wait for review.');
} else if (command === 'show' && id) {
  console.log(readFileSync(join(TASKS, `${id}.draft.md`), 'utf8'));
} else if (command === 'approve' && id) {
  if (!existsSync(join(TASKS, `${id}.draft.md`))) throw new Error(`No draft for task ${id}.`);
  const approval = { reviewer: flag('reviewer') || 'JingYuan Phen', date: new Date().toISOString().slice(0, 10), notes: flag('notes') || '' };
  writeFileSync(join(TASKS, `${id}.approved.json`), JSON.stringify(approval, null, 2), { mode: 0o600, flag: 'wx' });
  console.log(`Approved ${id}. The worker delivers the signed report on its next pass.`);
} else {
  console.log('Usage: npm run review -- list | show <taskId> | approve <taskId> [--reviewer "Name"] [--notes "Text"]');
}
