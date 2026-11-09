import {localRuntime,localConfig} from './local-runtime.mjs';
import {migrate} from './local-migrations.mjs';
import {fileURLToPath} from 'node:url';
const mode=process.argv[2];
if(!['migrate','dev'].includes(mode))throw Error('Use migrate or dev');
const mf=localRuntime({persist:fileURLToPath(new URL('../.local-state/',import.meta.url)),port:mode==='dev'?localConfig.port:0});
try{
  const applied=await migrate(await mf.getD1Database('DB'));
  console.log('Local D1 migrations:',applied.length?applied.join(', '):'already applied');
  if(mode==='migrate')await mf.dispose();
  else{
    console.log('Local Worker:',String(await mf.ready));
    console.log('Anonymous only; forged identity headers stripped; external network disabled.');
    const stop=async()=>{await mf.dispose();process.exit(0);};
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
  }
}catch(error){await mf.dispose();throw error;}
