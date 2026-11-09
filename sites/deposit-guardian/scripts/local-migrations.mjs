import {readdir,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
export async function migrate(DB){
  await DB.prepare('CREATE TABLE IF NOT EXISTS local_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL)').run();
  const files=(await readdir(new URL('../drizzle/',import.meta.url))).filter(f=>/^\d+_[\w]+\.sql$/.test(f)).sort();
  const applied=[];
  for(const name of files){
    const sql=await readFile(new URL('../drizzle/'+name,import.meta.url),'utf8');
    const hash=createHash('sha256').update(sql).digest('hex');
    const old=await DB.prepare('SELECT sha256 FROM local_migrations WHERE name=?').bind(name).first();
    if(old){if(old.sha256!==hash)throw Error('Applied migration changed: '+name);continue;}
    const statements=sql.split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean);
    // D1 batch is transactional: schema and history advance together.
    await DB.batch([...statements.map(s=>DB.prepare(s)),DB.prepare('INSERT INTO local_migrations VALUES (?,?)').bind(name,hash)]);
    applied.push(name);
  }
  return applied;
}
