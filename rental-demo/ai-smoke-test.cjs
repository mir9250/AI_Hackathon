const fs=require('fs'),vm=require('vm'),assert=require('assert');
const nodes=new Map();const get=s=>{if(!nodes.has(s))nodes.set(s,{innerHTML:'',textContent:'',checked:false,value:'',isConnected:true,classList:{toggle(){}},contains(){return false},querySelector:get,appendChild(){}});return nodes.get(s)};
let requests=0,notices=[];
const answer={analysis:{summary:'<script>test</script>',observations:[],questions:['확인할 점'],next_steps:[],draft:'확인 요청 초안',limitations:['법률 판단 아님']},model:'test-model',createdAt:'2026-11-07T00:00:00Z',task:'photo'};
const fakeState={area:'wall',phase:'before',contract:'퇴실 청소비 10만원은 임차인이 부담한다.',ai:{},records:{}};
const rec={image:'data:image/png;base64,dGVzdA==',note:'벽지 메모'};
const ctx={state:fakeState,areas:[{id:'wall',name:'벽지'}],getRecord:()=>rec,createDraft:()=> '공제 근거를 요청합니다.',toast:t=>notices.push(t),refresh(){}};
const sandbox={window:{DepositStore:{save:async()=>{}}},document:{querySelector:get,createElement:()=>get('#aiPanel')},location:{hash:'#record'},AbortController,clearTimeout,setTimeout:()=>1,fetch:async(url,options)=>{if(url==='/api/health')return{ok:true,json:async()=>({configured:true,model:'test-model'})};requests++;const body=JSON.parse(options.body);assert(body.consent);assert.equal(body.images.length,1);assert(!('api_key' in body));return {ok:true,json:async()=>answer};}};
vm.createContext(sandbox);vm.runInContext(fs.readFileSync('rental-demo/ai-ui.js','utf8'),sandbox);
(async()=>{
 sandbox.window.mountAI('record',ctx);await new Promise(resolve=>setImmediate(resolve));
 await get('#runAI').onclick();assert.equal(requests,0);assert(notices[0].includes('동의'));
 get('#aiConsent').checked=true;await get('#runAI').onclick();assert.equal(requests,1);assert(fakeState.ai['record/wall/before']);assert(get('#aiPanel').innerHTML.includes('&lt;script&gt;'));assert(!get('#aiPanel').innerHTML.includes('<script>'));
 rec.note='새로 바뀐 메모';sandbox.window.mountAI('record',ctx);assert(get('#aiPanel').innerHTML.includes('이전 자료의 분석'));
 rec.image='';sandbox.window.mountAI('record',ctx);assert(get('#aiPanel').innerHTML.includes('실제 사진 한 장'));get('#aiConsent').checked=true;await get('#runAI').onclick();assert.equal(requests,1);
 console.log('PASS AI consent gate, server payload, actual response rendering, escaping, changed-input warning, missing-image gate');
})().catch(e=>{console.error(e);process.exitCode=1});
