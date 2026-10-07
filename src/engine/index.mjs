// Runs one audit job end to end: workspace, build, review, optional fix, report.
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectSources, copyWorkspace, prepareWorkspace, runAikenCheck } from './aiken.mjs';
import { MODEL, proposeFix, reviewContract } from './review.mjs';
import { renderReport } from './report.mjs';

const MAX_FIX_ATTEMPTS = 3;

export function hashFiles(files) {
  const hash = createHash('sha256');
  for (const f of files) hash.update(`${f.path}\n${f.content}\n`);
  return hash.digest('hex');
}

export async function runAudit({ tier, source, jobId = randomUUID(), buyerNotes = '', proof, humanReview, log = () => {} }) {
  log(`Preparing workspace (${source.kind})`);
  const workspace = await prepareWorkspace(source, jobId);
  const files = collectSources(workspace.root);
  const inputHash = hashFiles(files);

  log('Running aiken check');
  const check = await runAikenCheck(workspace.root);

  log(`Reviewing with ${MODEL}`);
  const { data: review, usage } = await reviewContract({ tier, files, check, buyerNotes });
  const usages = [usage];

  let fix = null;
  const needsFix = review.findings.some((f) => ['Critical', 'High', 'Medium'].includes(f.severity));
  if ((tier === 'write' || tier === 'audit') && needsFix) {
    const fixDir = `${workspace.root}-fix`;
    let previousAttempt = null;
    fix = { attempts: 0, files: [], testsAdded: [], explanation: null, check: null };
    while (fix.attempts < MAX_FIX_ATTEMPTS) {
      fix.attempts += 1;
      log(`Writing a fix (attempt ${fix.attempts})`);
      const { data, usage: fixUsage } = await proposeFix({ files, review, previousAttempt });
      usages.push(fixUsage);
      copyWorkspace(workspace.root, fixDir);
      for (const file of data.files) {
        const target = join(fixDir, file.path);
        if (!target.startsWith(`${fixDir}/`) || !file.path.endsWith('.ak')) throw new Error(`The fix tried to write an unexpected path: ${file.path}`);
        mkdirSync(join(target, '..'), { recursive: true });
        writeFileSync(target, file.content);
      }
      const fixCheck = await runAikenCheck(fixDir);
      fix = { ...fix, files: data.files, testsAdded: data.tests_added, explanation: data.explanation, check: fixCheck };
      if (fixCheck.ok) break;
      previousAttempt = fixCheck;
    }
  }

  const report = renderReport({
    tier, label: workspace.label, inputHash, model: MODEL, date: new Date().toISOString(),
    files, check, review, fix, humanReview, proof,
  });
  return { report, review, fix, check, inputHash, files, usages, workspace };
}
