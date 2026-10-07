// Builds an Aiken workspace for a contract and runs `aiken check` in it.
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
export const WORK_DIR = resolve(here, '../../work');
const TEMPLATE_DIR = join(WORK_DIR, '_template');
const MAX_SOURCE_BYTES = 150_000;
const MAX_REPO_BYTES = 20_000_000;

// Builds run with a clean environment: no API keys or other secrets.
const AIKEN_ENV = {
  HOME: homedir(),
  PATH: `${join(homedir(), '.aiken/bin')}:/opt/homebrew/bin:/usr/bin:/bin`,
  NO_COLOR: '1',
};

const AIKEN_TOML = `name = "auditor/contract"
version = "0.0.0"
compiler = "v1.1.24"
plutus = "v3"
license = "Apache-2.0"
description = "Contract submitted for audit"

[repository]
user = "auditor"
project = "contract"
platform = "github"

[[dependencies]]
name = "aiken-lang/stdlib"
version = "v4.0.0"
source = "github"

[config]
`;

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

export async function runAikenCheck(dir) {
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  try {
    ({ stdout, stderr } = await run('aiken', ['check'], { cwd: dir, env: AIKEN_ENV, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 }));
  } catch (error) {
    stdout = error.stdout ?? '';
    stderr = error.stderr ?? String(error.message);
    exitCode = typeof error.code === 'number' ? error.code : 1;
  }
  const output = stripAnsi(`${stdout}\n${stderr}`).trim();
  const summary = /Summary\s+(\d+)\s+errors?,\s+(\d+)\s+warnings?/i.exec(output);
  let tests = 0, passed = 0, failed = 0;
  for (const m of output.matchAll(/(\d+)\s+tests?\s*\|\s*(\d+)\s+passed\s*\|\s*(\d+)\s+failed/gi)) {
    tests += Number(m[1]); passed += Number(m[2]); failed += Number(m[3]);
  }
  return {
    ok: exitCode === 0,
    errors: summary ? Number(summary[1]) : (exitCode === 0 ? 0 : null),
    warnings: summary ? Number(summary[2]) : null,
    tests, passed, failed,
    output: output.length > 12_000 ? `…${output.slice(-12_000)}` : output,
  };
}

// A template with the stdlib already downloaded makes each job fast and offline.
async function ensureTemplate() {
  if (existsSync(join(TEMPLATE_DIR, 'build/packages'))) return;
  rmSync(TEMPLATE_DIR, { recursive: true, force: true });
  mkdirSync(join(TEMPLATE_DIR, 'validators'), { recursive: true });
  writeFileSync(join(TEMPLATE_DIR, 'aiken.toml'), AIKEN_TOML);
  writeFileSync(join(TEMPLATE_DIR, 'validators/placeholder.ak'), 'test placeholder() {\n  True\n}\n');
  const result = await runAikenCheck(TEMPLATE_DIR);
  if (!result.ok) throw new Error(`Could not prepare the Aiken template:\n${result.output}`);
  rmSync(join(TEMPLATE_DIR, 'validators/placeholder.ak'));
}

function dirBytes(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += dirBytes(path);
    else total += statSync(path).size;
  }
  return total;
}

export async function prepareWorkspace(source, jobId) {
  const dir = join(WORK_DIR, jobId);
  rmSync(dir, { recursive: true, force: true });
  if (source.kind === 'code') {
    await ensureTemplate();
    cpSync(TEMPLATE_DIR, dir, { recursive: true });
    writeFileSync(join(dir, 'validators/contract.ak'), `${source.code.trim()}\n`);
    return { dir, root: dir, label: 'validators/contract.ak (pasted code)' };
  }
  const args = ['clone', '--depth', '1', '--quiet'];
  if (source.ref) args.push('--branch', source.ref);
  args.push(source.url, dir);
  await run('git', args, { timeout: 90_000, env: { ...AIKEN_ENV, GIT_TERMINAL_PROMPT: '0' } });
  if (dirBytes(dir) > MAX_REPO_BYTES) throw new Error('The repository is larger than 20 MB.');
  const root = source.subdir ? resolve(dir, source.subdir) : dir;
  if (!root.startsWith(dir) || !existsSync(join(root, 'aiken.toml'))) {
    throw new Error('No aiken.toml found at the linked path. Link to the folder of an Aiken project.');
  }
  return { dir, root, label: source.display };
}

export function collectSources(root) {
  const files = [];
  let total = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'build' || entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ak')) {
        const content = readFileSync(path, 'utf8');
        total += Buffer.byteLength(content);
        if (total > MAX_SOURCE_BYTES) throw new Error('The Aiken sources are larger than 150 KB.');
        files.push({ path: relative(root, path), content });
      }
    }
  };
  for (const folder of ['validators', 'lib']) {
    if (existsSync(join(root, folder))) walk(join(root, folder));
  }
  if (!files.some((f) => f.path.startsWith('validators'))) throw new Error('No validators found in the contract.');
  return files;
}

export function copyWorkspace(fromDir, toDir) {
  rmSync(toDir, { recursive: true, force: true });
  cpSync(fromDir, toDir, { recursive: true });
}
