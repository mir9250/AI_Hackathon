import fs from 'node:fs';
import path from 'node:path';
const assets = {};
const types = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon' };
function collect(dir, prefix='') {
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
    const name=path.join(dir,entry.name), relative=prefix+'/'+entry.name;
    if(entry.isDirectory()) collect(name,relative);
    else assets[relative]={type:types[path.extname(entry.name)]||'application/octet-stream',data:fs.readFileSync(name).toString('base64')};
  }
}
collect('web-build');
fs.mkdirSync('dist/server',{recursive:true});
fs.writeFileSync('dist/server/index.js',fs.readFileSync('hosting/render-worker.js','utf8')+'\nconst assets='+JSON.stringify(assets)+';\nexport default createWorker(assets);\n');
console.log('Built Worker with',Object.keys(assets).length,'assets and fixed Render API upstream.');
