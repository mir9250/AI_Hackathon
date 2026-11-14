// 파일 선택·공간 이동·저장 이후에도 분석 영역을 다시 마운트하는지 검증합니다.
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const nodes=new Map(),mounts=[];
function get(s){if(!nodes.has(s))nodes.set(s,{innerHTML:'',textContent:'',value:'',classList:{add(){},remove(){},toggle(){}},setAttribute(){},removeAttribute(){},click(){}});return nodes.get(s);}
class Reader{readAsDataURL(){this.result='data:image/png;base64,dGVzdA==';this.onload();}}
class Picture{set src(value){this.onload();}}
const context={document:{querySelector:get,querySelectorAll:()=>[],addEventListener(){},createElement:()=>({click(){}})},window:{addEventListener(){},scrollTo(){},mountAI:(route,ctx)=>mounts.push({route,image:ctx.getRecord().image})},location:{hash:'#record'},FileReader:Reader,Image:Picture,setTimeout:()=>1,clearTimeout(){},console};
vm.createContext(context);vm.runInContext(fs.readFileSync('rental-demo/app.js','utf8'),context);
assert.equal(mounts.length,1);assert.equal(mounts[0].route,'record');assert(get('#app').innerHTML.includes('id="photoAnalysis"'));
get('#photo').onchange({target:{files:[{type:'image/png',size:20,name:'room.png'}]}});assert.equal(mounts.length,2);assert(mounts[1].image);assert(get('#app').innerHTML.includes('id="photoAnalysis"'));
get('#save').onclick();assert.equal(mounts.length,3);assert.equal(mounts[2].route,'record');
vm.runInContext("state.area='bath';record()",context);assert.equal(mounts.length,4);assert.equal(mounts[3].image,'');
context.location.hash='#contract';vm.runInContext('render()',context);assert.equal(mounts.at(-1).route,'contract');get('#analyzeContract').onclick();assert.equal(mounts.at(-1).route,'contract');
console.log('PASS photo upload, save, area change and keyword check retain the AI action panel');
