import {json} from '../utils/response.js';

// Deployment diagnostics. Does not reveal secret values, passwords, or object keys.
// A binding being present does not mean that the D1 schema has been migrated.
export const REQUIRED_TABLES = [
  'users', 'sessions', 'auth_attempts', 'spaces', 'folders', 'files',
  'storage_objects', 'upload_sessions', 'shares', 'trash_entries',
  'app_settings', 'storage_cleanup_jobs', 'maintenance_lock', 'maintenance_runs', 'operational_events', 'backup_records'
];
function validBootstrapSecret(secret) {
  return typeof secret === 'string' && secret.length >= 32 &&
    !/CHANGE_ME|REPLACE_WITH|EXAMPLE|YOUR_SECRET/i.test(secret);
}
function bindingPresent(bucket) {
  return !!bucket && typeof bucket.get === 'function' && typeof bucket.put === 'function';
}
function diagnostic(status, code, details, httpStatus = 503) {
  return json({success: httpStatus === 200, data: {status, code, ...details}}, httpStatus);
}
export async function readinessResponse(env) {
  const bindings = {
    d1: !!env.DB && typeof env.DB.prepare === 'function',
    private_r2: bindingPresent(env.PRIVATE_BUCKET),
    public_r2: bindingPresent(env.PUBLIC_BUCKET),
    assets: !!env.ASSETS && typeof env.ASSETS.fetch === 'function'
  };
  if (Object.values(bindings).some(value => !value)) {
    return diagnostic('not_ready', 'BINDING_MISSING', {bindings, next_action:'CHECK_WORKER_BINDINGS'});
  }
  try {
    const schema = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all();
    const names = new Set((schema.results || []).map(row => row.name));
    const missingTables = REQUIRED_TABLES.filter(name => !names.has(name));
    if (missingTables.length || !names.has('d1_migrations')) {
      return diagnostic('not_ready', 'D1_MIGRATIONS_REQUIRED', {
        bindings, schema_ready:false, missing_tables:missingTables,
        next_action:'APPLY_REMOTE_D1_MIGRATIONS'
      });
    }
    const admin = await env.DB.prepare(`SELECT COUNT(*) AS count FROM users WHERE role='super_admin'`).first();
    if (!Number(admin?.count)) {
      const secretReady = validBootstrapSecret(env.BOOTSTRAP_TOKEN);
      return diagnostic('setup_required', secretReady ? 'ADMIN_SETUP_REQUIRED' : 'BOOTSTRAP_SECRET_REQUIRED', {
        bindings, schema_ready:true, bootstrap_secret_configured:secretReady,
        next_action:secretReady ? 'VISIT_LOGIN_AND_CREATE_ADMIN' : 'SET_BOOTSTRAP_TOKEN_SECRET'
      });
    }
    return diagnostic('ready', 'READY', {bindings, schema_ready:true, admin_initialized:true, next_action:'NONE'}, 200);
  } catch (error) {
    console.error('Deployment readiness query failed', error);
    return diagnostic('not_ready', 'D1_QUERY_FAILED', {
      bindings, schema_ready:false, next_action:'CHECK_D1_BINDING_AND_MIGRATIONS'
    });
  }
}
