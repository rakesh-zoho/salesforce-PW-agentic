import fs from 'fs';
import path from 'path';
import { spawnSync, spawn } from 'child_process';

const ROOT = path.resolve(__dirname, '..');
const RESULTS_DIR = path.join(ROOT, 'allure-results');
const REPORT_DIR = path.join(ROOT, 'allure-report');
const HISTORY_DIR = path.join(ROOT, 'allure-history');
const HISTORY_STORE_DIR = path.join(HISTORY_DIR, 'history');
const RUN_PREFIX = 'run-';
const RUN_RETENTION = 7;

function log(message) {
  console.log(`[allure-dashboard] ${message}`);
}

async function exists(source) {
  return fs.existsSync(source);
}

async function ensureDir(dir) {
  if (!(await exists(dir))) {
    await fs.promises.mkdir(dir, { recursive: true });
  }
}

async function removeDir(dir) {
  if (await exists(dir)) {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

async function copyDirectory(src, dest) {
  if (!(await exists(src))) {
    throw new Error(`Source directory does not exist: ${src}`);
  }

  await ensureDir(dest);

  if (fs.promises.cp) {
    await fs.promises.cp(src, dest, { recursive: true });
    return;
  }

  const entries = await fs.promises.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, destPath);
    } else {
      await fs.promises.copyFile(sourcePath, destPath);
    }
  }
}

function runCommand(command, args = []) {
  log(`Running: ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
  });

  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
}

async function writeEnvironmentProperties() {
  await ensureDir(RESULTS_DIR);
  const env = process.env.NODE_ENV || 'local';
  const browser = process.env.PW_BROWSER || 'chromium';
  const sfUrl = process.env.SF_URL || '';

  const content = [
    `ENV=${env}`,
    `BROWSER=${browser}`,
    `SF_URL=${sfUrl}`,
    `RUN_TIMESTAMP=${new Date().toISOString()}`,
  ].join('\n');

  await fs.promises.writeFile(path.join(RESULTS_DIR, 'environment.properties'), content, 'utf8');
}

async function writeExecutorJson() {
  await ensureDir(RESULTS_DIR);

  const executor = {
    name: process.env.CI_NAME || 'local-playwright',
    type: process.env.CI ? 'CI' : 'local',
    url: process.env.CI_BUILD_URL || '',
    buildOrder: process.env.CI_BUILD_NUMBER || `${Date.now()}`,
    buildName: process.env.CI_BUILD_NAME || 'Playwright Run',
    reportName: 'Allure Dashboard',
    reportUrl: '',
  };

  await fs.promises.writeFile(path.join(RESULTS_DIR, 'executor.json'), JSON.stringify({ executor }, null, 2), 'utf8');
}

async function writeCategoriesJson() {
  await ensureDir(RESULTS_DIR);

  const categories = [
    {
      name: 'Assertion Failures',
      matchedStatuses: ['failed'],
      messageRegex: 'AssertionError|expected|received|to have',
    },
    {
      name: 'Timeouts',
      matchedStatuses: ['failed'],
      messageRegex: 'Timeout|timed out|Exceeded',
    },
    {
      name: 'Environment Issues',
      matchedStatuses: ['broken'],
      messageRegex: 'ENOTFOUND|ECONNREFUSED|Failed to launch',
    },
  ];

  await fs.promises.writeFile(path.join(RESULTS_DIR, 'categories.json'), JSON.stringify(categories, null, 2), 'utf8');
}

async function injectHistory() {
  if (!(await exists(HISTORY_STORE_DIR))) {
    log('No previous history found, skipping history injection.');
    return;
  }

  const destination = path.join(RESULTS_DIR, 'history');
  await removeDir(destination);
  await copyDirectory(HISTORY_STORE_DIR, destination);
  log('Injected history into current allure-results.');
}

async function archiveCurrentRun() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '').replace(/T/, '-').slice(0, 15);
  const runDir = path.join(HISTORY_DIR, `${RUN_PREFIX}${timestamp}`);
  await ensureDir(HISTORY_DIR);
  await copyDirectory(RESULTS_DIR, runDir);
  log(`Archived current run to ${runDir}`);
  return runDir;
}

async function rotateRunHistory() {
  const entries = await fs.promises.readdir(HISTORY_DIR, { withFileTypes: true });
  const runDirs = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(RUN_PREFIX))
    .sort((a, b) => a.name.localeCompare(b.name));

  const keep = runDirs.slice(-RUN_RETENTION);
  const remove = runDirs.slice(0, Math.max(0, runDirs.length - RUN_RETENTION));

  for (const entry of remove) {
    const location = path.join(HISTORY_DIR, entry.name);
    await removeDir(location);
    log(`Removed old run archive: ${entry.name}`);
  }

  if (remove.length === 0) {
    log('No old run archives to remove.');
  }
}

async function persistUpdatedHistory() {
  const reportHistory = path.join(REPORT_DIR, 'history');
  if (!(await exists(reportHistory))) {
    log('No generated report history available to persist.');
    return;
  }

  await ensureDir(HISTORY_DIR);
  await removeDir(HISTORY_STORE_DIR);
  await copyDirectory(reportHistory, HISTORY_STORE_DIR);
  log('Persisted updated history to allure-history/history.');
}

async function cleanPreviousReport() {
  await removeDir(REPORT_DIR);
  await ensureDir(REPORT_DIR);
}

async function main() {
  try {
    await ensureDir(RESULTS_DIR);
    await writeEnvironmentProperties();
    await writeExecutorJson();
    await writeCategoriesJson();
    await injectHistory();

    log('Executing Playwright tests...');
    runCommand('npx', ['playwright', 'test', '--config', 'config/playwright.config.js']);

    await archiveCurrentRun();
    await rotateRunHistory();

    log('Generating merged Allure dashboard...');
    await cleanPreviousReport();
    runCommand('npx', ['allure', 'generate', 'allure-results', '--clean', '--output', 'allure-report']);

    await persistUpdatedHistory();

    log('Opening merged Allure report...');
    const openProcess = spawn('npx', ['allure', 'open', 'allure-report'], {
      cwd: ROOT,
      shell: true,
      detached: true,
      stdio: 'ignore',
    });
    openProcess.unref();

    log('Dashboard generation finished successfully.');
  } catch (error) {
    console.error('[allure-dashboard] Error:', error.message);
    process.exit(1);
  }
}

main();
