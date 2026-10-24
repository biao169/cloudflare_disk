#!/usr/bin/env node
/**
 * CloudDrive RC5: idempotent, fail-closed Cloudflare Workers Builds deployment.
 *
 * 1. List remote D1 databases (never confuse an API error with an empty account).
 * 2. If DB exists, inject its verified database_id into a temporary JSONC config.
 * 3. Apply unapplied D1 migrations, verify actual schema, then deploy the Worker.
 * 4. If DB does not exist, deploy once for Cloudflare auto-provisioning; resolve its
 *    newly provisioned ID; migrate; verify; deploy again with the explicit ID.
 *
 * No frontend compilation. The generated configuration is temporary/ignored by Git.
 * No production data, DB, or R2 bucket is deleted by this script.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_TABLES } from '../worker/services/readiness.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG = join(ROOT, 'wrangler.jsonc');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Minimal comment stripper: leaves `//` inside quoted URLs untouched.
export function parseJsonc(input) {
  let result = '', quoted = false, escaped = false, line = false, block = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i], n = input[i + 1];
    if (line) { if (c === '\n') { line = false; result += '\n'; } continue; }
    if (block) { if (c === '*' && n === '/') { block = false; i++; } else if (c === '\n') result += '\n'; continue; }
    if (quoted) { result += c; if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') { quoted = true; result += c; continue; }
    if (c === '/' && n === '/') { line = true; i++; continue; }
    if (c === '/' && n === '*') { block = true; i++; continue; }
    result += c;
  }
  // JSONC allows trailing commas, but do not touch commas inside string literals.
  let cleaned = '', inString = false, slash = false;
  for (let i = 0; i < result.length; i++) {
    const c = result[i];
    if (inString) { cleaned += c; if (slash) slash = false; else if (c === '\\') slash = true; else if (c === '"') inString = false; continue; }
    if (c === '"') { inString = true; cleaned += c; continue; }
    if (c === ',') { let j = i + 1; while (/\s/.test(result[j] ?? '')) j++; if (result[j] === '}' || result[j] === ']') continue; }
    cleaned += c;
  }
  return JSON.parse(cleaned);
}

export function parseCommandJson(stdout) {
  const trimmed = String(stdout ?? '').trim();
  try { return JSON.parse(trimmed); } catch { /* Wrangler may prefix harmless logs. */ }
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] !== '[' && trimmed[i] !== '{') continue;
    try { return JSON.parse(trimmed.slice(i)); } catch { /* Skip prefixes */ }
  }
  throw new Error('无法解析 Wrangler JSON 响应；请检查 Wrangler 版本及命令输出。');
}

export function resolveDatabaseId(response, dbName, configuredId = undefined) {
  const databases = Array.isArray(response) ? response : response?.result;
  if (!Array.isArray(databases)) throw new Error('Wrangler D1 列表不是预期的 JSON 数组，停止自动部署以保护数据。');
  const matches = databases.filter(x => x && x.name === dbName);
  if (matches.length > 1) throw new Error(`发现多个同名 D1 ${dbName}，不能安全自动选择。`);
  if (matches.length === 0) {
    if (configuredId) throw new Error(`配置指定了 D1 ID，但账号中找不到 ${dbName}，可能使用了错误的 Cloudflare 账户。`);
    return null;
  }
  const id = matches[0].uuid ?? matches[0].id ?? matches[0].database_id;
  if (!UUID.test(String(id ?? ''))) throw new Error(`D1 ${dbName} 的 ID 格式无法识别，终止部署。`);
  if (configuredId && id.toLowerCase() !== configuredId.toLowerCase()) {
    throw new Error(`D1 ${dbName} ID 与仓库配置不一致。为避免误改数据库，停止部署。`);
  }
  return id;
}

function binding(config) {
  const dbs = config.d1_databases;
  const db = Array.isArray(dbs) ? dbs.find(x => x.binding === 'DB') : null;
  if (!db?.database_name) throw new Error('wrangler.jsonc 必须含有 DB D1 binding 和 database_name。');
  if (dbs.length !== 1) throw new Error('当前一键部署仅支持一个 D1 绑定，避免迁移错误数据库。');
  if (!config.name || !/^[a-z0-9][a-z0-9-]*$/.test(config.name)) throw new Error('Worker name 无效。');
  if (process.env.CLOUDDRIVE_EXPECT_WORKER_NAME && config.name !== process.env.CLOUDDRIVE_EXPECT_WORKER_NAME) {
    throw new Error('当前 Worker 名称与 CLOUDDRIVE_EXPECT_WORKER_NAME 不一致，已阻止部署到新实例。');
  }
  if (db.database_id && !UUID.test(db.database_id)) throw new Error('现有 database_id 不是有效 UUID，不得用占位 ID 部署。');
  const bs = new Set((config.r2_buckets ?? []).map(x => x.binding));
  if (!bs.has('PRIVATE_BUCKET') || !bs.has('PUBLIC_BUCKET')) throw new Error('缺少私有或公开 R2 Binding。');
  return db;
}

export function extractTables(json) {
  const objects = Array.isArray(json) ? json : Array.isArray(json?.result) ? json.result : [json];
  const rows = objects.flatMap(x => x?.results ?? []);
  return new Set(rows.map(x => x.name).filter(Boolean));
}

export function makeWranglerConfig(config, id = null) {
  const copy = structuredClone(config);
  copy.d1_databases = copy.d1_databases.map(db => db.binding === 'DB'
    ? { ...db, ...(id ? { database_id: id } : {}) } : db);
  if (!id) delete copy.d1_databases.find(db => db.binding === 'DB').database_id;
  return copy;
}

// Remote operations are run through the *installed* Wrangler package; no
// dependency on an optionally-installed global CLI or PowerShell quoting.
export function processWrangler(args) {
  const entry = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  if (!existsSync(entry)) throw new Error('请先运行 npm install；未找到本地 node_modules/wrangler/bin/wrangler.js。');
  const r = spawnSync(process.execPath, [entry, ...args], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, CI: 'true', NO_COLOR: '1' }, maxBuffer: 16 * 1024 * 1024
  });
  if (r.error) throw r.error;
  return r;
}

function logCommand(args, result, logger, silent = false) {
  if (!silent && result.stdout?.trim()) logger.log(result.stdout.trim());
  if (result.stderr?.trim()) logger.warn(result.stderr.trim());
  if (result.status !== 0) {
    throw new Error(`Wrangler 命令失败 (${result.status ?? 'unknown'}): wrangler ${args.join(' ')}\n${(result.stderr || result.stdout || '').slice(-3500)}`);
  }
  return result.stdout ?? '';
}

export function parseMode(args) {
  if (args.includes('--backup-only')) return 'backup-only';
  if (args.includes('--migrate-only')) return 'migrate-only';
  if (args.includes('--list-migrations')) return 'list-migrations';
  if (args.includes('--upgrade')) return 'upgrade';
  if (args.includes('--initial')) return 'initial';
  return 'auto';
}

export async function deployCloudDrive({
  runner = processWrangler, configPath = DEFAULT_CONFIG, mode = 'auto', logger = console
} = {}) {
  const absolute = resolve(configPath);
  const original = parseJsonc(readFileSync(absolute, 'utf8'));
  const db = binding(original);
  if (!['auto', 'initial', 'upgrade', 'migrate-only', 'list-migrations', 'backup-only'].includes(mode)) throw new Error('Unknown mode');
  const files = readdirSync(join(dirname(absolute), 'migrations')).filter(f => /^\d+.*\.sql$/.test(f)).sort();
  if (!files.length) throw new Error('未找到 SQL 迁移文件。');
  const temp = join(dirname(absolute), `.clouddrive-deploy-${process.pid}.jsonc`);
  const write = id => writeFileSync(temp, JSON.stringify(makeWranglerConfig(original, id), null, 2) + '\n');
  const call = (args, silent=false) => {
    const output = runner(args);
    return logCommand(args, output, logger, silent);
  };
  const list = () => parseCommandJson(call(['d1', 'list', '--json'], true));
  const configArgs = ['--config', temp];
  const verify = () => {
    const raw = call(['d1','execute','DB','--remote','--command',"SELECT name FROM sqlite_master WHERE type='table'",'--json',...configArgs],true);
    const tables = extractTables(parseCommandJson(raw));
    const missing = [...REQUIRED_TABLES,'d1_migrations'].filter(name => !tables.has(name));
    if (missing.length) throw new Error(`迁移命令返回成功但 D1 仍缺少 ${missing.join(', ')}；停止发布。`);
    logger.log(`[CloudDrive] 远程 D1 表结构已验证：${REQUIRED_TABLES.length} 个必需表和迁移记录表存在。`);
  };
  try {
    logger.log(`[CloudDrive] Worker=${original.name}; D1=${db.database_name}; mode=${mode}`);
    let id = resolveDatabaseId(list(), db.database_name, db.database_id);
    if (!id) {
      if (['upgrade','migrate-only','list-migrations','backup-only'].includes(mode)) throw new Error('未找到现有 D1，升级/迁移操作禁止新建数据库。');
      logger.log('[CloudDrive] Cloudflare 中尚无目标 D1。首次执行 Worker 部署以自动创建 D1/R2。');
      write(null);
      call(['deploy', ...configArgs]);
      id = resolveDatabaseId(list(), db.database_name);
      if (!id) throw new Error('Worker 已提交但远程 D1 未创建成功；停止后续操作，不允许假报部署成功。');
    } else {
      logger.log(`[CloudDrive] 已找到现有 D1 ${db.database_name}，将保留该数据库并应用增量迁移。`);
    }
    write(id); // D1 subcommands require a real ID even after auto-provisioning.
    if (mode === 'backup-only') {
      const folder = join(dirname(absolute), 'backups');
      mkdirSync(folder, {recursive: true});
      const file = join(folder, `clouddrive-d1-${new Date().toISOString().replace(/[:.]/g,'-')}.sql`);
      call(['d1','export','DB','--remote','--output',file,...configArgs]);
      logger.log(`[CloudDrive] D1 备份已保存在 ${file}（注意：不包含 R2 文件）。`);
      return { mode, databaseName: db.database_name, databaseId: id, migrated: false, backupFile: file };
    }
    if (mode === 'list-migrations') {
      call(['d1','migrations','list','DB','--remote',...configArgs]);
      return { mode, databaseName: db.database_name, databaseId: id, migrated: false };
    }
    call(['d1','migrations','apply','DB','--remote',...configArgs]);
    verify();
    if (mode !== 'migrate-only') {
      call(['deploy',...configArgs]);
      logger.log('[CloudDrive] Worker 代码已发布，D1 迁移已验证。首次使用请设置 BOOTSTRAP_TOKEN 后进入 /setup。');
    } else {
      logger.log('[CloudDrive] 仅数据库迁移成功；Worker 代码未重新部署。');
    }
    return { mode, databaseName: db.database_name, databaseId: id, migrated: true };
  } finally {
    rmSync(temp, { force:true });
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) deployCloudDrive({mode:parseMode(process.argv.slice(2))})
  .catch(error => { console.error(`[CloudDrive] 自动部署失败：${error.message}`); process.exitCode = 1; });
