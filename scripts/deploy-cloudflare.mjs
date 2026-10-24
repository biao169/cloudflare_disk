#!/usr/bin/env node
// Web deployment with automatic first-run D1/R2 provisioning and safe upgrade order.
// No frontend build. To control the order explicitly:
//   npm run deploy:initial   -> deploy/provision, migrate
//   npm run deploy:upgrade   -> migrate, deploy (backup existing D1 first)
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

export function deploymentOrder(mode, remoteDatabaseReachable) {
  if (!['auto', 'initial', 'upgrade'].includes(mode)) throw new Error('Unknown deployment mode');
  if (mode === 'initial') return ['deploy:code', 'db:migrate:remote'];
  if (mode === 'upgrade') return ['db:migrate:remote', 'deploy:code'];
  return remoteDatabaseReachable
    ? ['db:migrate:remote', 'deploy:code']
    : ['deploy:code', 'db:migrate:remote'];
}
function npmRun(script, capture=false) {
  const win=process.platform==='win32';
  // The script name is chosen from fixed, trusted constants in this file.
  const program=win?'cmd.exe':'npm';
  const args=win?['/d','/c','npm','run',script]:['run',script];
  const result=spawnSync(program,args,{
    stdio:capture?'pipe':'inherit',encoding:'utf8',env:process.env
  });
  if(result.error)throw result.error;
  return result;
}
export function explicitMode(args) {
  if(args.includes('--initial'))return 'initial';
  if(args.includes('--upgrade'))return 'upgrade';
  return 'auto';
}
async function main() {
  const mode=explicitMode(process.argv.slice(2));
  if(mode==='initial')console.log('[CloudDrive] Initial deployment: provision resources first, then apply remote D1 migrations.');
  if(mode==='upgrade')console.log('[CloudDrive] Upgrade: apply pending migrations before activating new Worker. Back up D1 first.');
  let databaseReachable=false;
  if(mode==='auto') {
    console.log('[CloudDrive] Checking whether the remote D1 database is already accessible...');
    const probe=npmRun('db:migrations:list:remote',true);
    databaseReachable=probe.status===0;
    if(!databaseReachable){
      console.warn('[CloudDrive] D1 migration listing did not succeed before provisioning.');
      console.warn('[CloudDrive] Attempting first deployment to auto-provision R2/D1 before applying migrations.');
      console.warn('  If this is an upgrade, STOP and run npm run deploy:upgrade after resolving D1 connectivity.');
      if(probe.stderr)console.warn(probe.stderr.slice(-2200));
    }
  }
  for(const script of deploymentOrder(mode,databaseReachable)) {
    console.log(`[CloudDrive] Executing npm run ${script}`);
    const result=npmRun(script);
    if(result.status!==0){
      console.error(`[CloudDrive] Failed: ${script}. Exit status ${result.status ?? 'unknown'}.`);
      if(script==='db:migrate:remote'){
        console.error('[CloudDrive] Remote D1 schema may be uninitialized. Check /api/v1/health/ready, then inspect D1 bindings and run migrations manually.');
      }
      process.exitCode=result.status||1;
      return;
    }
  }
  console.log('[CloudDrive] Deploy and D1 migrations completed. Verify /api/v1/health/ready; configure BOOTSTRAP_TOKEN if requested.');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e);process.exitCode=1});
