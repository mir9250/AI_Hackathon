import {Miniflare} from 'miniflare';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
export const localConfig=JSON.parse(readFileSync(new URL('../local/config.json',import.meta.url),'utf8'));
export function localRuntime({persist=false,port=0,token,outbound}={}){
  return new Miniflare({
    modules:true,modulesRules:[{type:'ESModule',include:['**/*.js','**/*.mjs']}],scriptPath:fileURLToPath(new URL('../local/entry.mjs',import.meta.url)),
    compatibilityDate:localConfig.compatibilityDate,host:'127.0.0.1',port,
    d1Databases:{DB:localConfig.databaseId},r2Buckets:[localConfig.bucketBinding],
    d1Persist:persist,r2Persist:persist,
    bindings:token?{LOCAL_TEST_TOKEN:token,OPENAI_API_KEY:'mock-only-not-a-real-key'}:{},
    // No access to real upstream services, even when developer shell has a key.
    outboundService:outbound||(()=>new Response('External network disabled',{status:502}))
  });
}
