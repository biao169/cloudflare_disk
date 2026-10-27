#!/usr/bin/env node
// RC11 production safeguard. This static preflight catches accidental DDL/data
// deletion in automatic migrations; it cannot replace a verified D1/R2 backup.
import {readdirSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const ROOT=resolve(fileURLToPath(new URL('..',import.meta.url)));
export function inspectMigration(name,sql){
 // Remove SQL comments before scanning, not string literals (fail closed for
 // suspicious text inside string literals rather than risk skipping a command).
 const source=sql.replace(/--[^\r\n]*/g,'').replace(/\/\*[\s\S]*?\*\//g,'');
 const forbidden=[/\bDROP\s+(?:TABLE|INDEX|TRIGGER)\b/i,/\bALTER\s+TABLE\b[^;]*\bDROP\b/i,/\bDELETE\s+FROM\b/i,/\bTRUNCATE\b/i,/\bPRAGMA\s+foreign_keys\s*=\s*OFF\b/i];
 return forbidden.some(re=>re.test(source))?[`${name}: contains a destructive or unsafe SQL operation; require a reviewed manual migration`]:[];
}
export function inspectMigrations(root=ROOT){
 const dir=join(root,'migrations'),errors=[];
 for(const name of readdirSync(dir).filter(n=>/^\d+.*\.sql$/.test(n))){
  errors.push(...inspectMigration(name,readFileSync(join(dir,name),'utf8')));
 }
 return errors;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const errors=inspectMigrations();if(errors.length){for(const item of errors)console.error(item);process.exitCode=1;}
 else console.log('Migration safety preflight: no destructive SQL commands detected.');
}
