// 브라우저 대역을 이용한 흐름 검증. 실제 시각·카메라 검수는 별도 필요.
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const nodes=new Map();let report='',copied='';
function get(s){if(!nodes.has(s))nodes.set(s,{innerHTML:'',textContent:'',value:'',style:{},classList:{add(){},remove(){},toggle(){}},checkValidity(){return true},setAttribute(){},removeAttribute(){},click(){}});return nodes.get(s)}
const context={document:{querySelector:get,querySelectorAll:()=>[],addEventListener(){},createElement:()=>({click(){}})},location:{hash:''},window:{addEventListener(){},scrollTo(){}},navigator:{clipboard:{writeText:async t=>{copied=t}}},setTimeout:()=>1,clearTimeout(){},Blob:class{constructor(parts){report=parts.join('')}},URL:{createObjectURL:()=> 'blob:test',revokeObjectURL(){}},console};vm.createContext(context);vm.runInContext(fs.readFileSync('rental-demo/app.js','utf8'),context);const run=code=>vm.runInContext(code,context);
assert(get('#app').innerHTML.includes('처음 들어온 날부터'));assert.equal(run('saved().length'),0);
for(const route of ['record','contract','compare','response','home']){context.location.hash='#'+route;run('render()');assert(get('#app').innerHTML.length>100)}
assert.equal(run("findClauses('청소비 10만원. 벽지 교체. 원상복구 의무.').length"),3);assert.equal(run("findClauses('매월 관리비 납부').length"),0);
context.location.hash='#record';run('render()');get('#save').onclick();assert.equal(run('saved().length'),0);
get('#note').oninput({target:{value:'<script>alert(1)</script> 작은 찍힘'}});get('#save').onclick();assert.equal(run('saved().length'),1);assert(get('#app').innerHTML.includes('&lt;script&gt;'));assert(!get('#app').innerHTML.includes('<script>'));
run('downloadReport()');assert(report.includes('&lt;script&gt;'));assert(!report.includes('<script>'));assert(report.includes('기기 등록 시각'));
run("loadPhoto({type:'application/pdf',size:10},getRecord())");assert(get('#fileError').textContent.includes('JPG'));
context.location.hash='#compare';run('render()');get('#slider').oninput({target:{value:'25'}});assert.equal(get('#compareLine').style.left,'25%');assert.equal(get('#compareFront').style.clipPath,'inset(0 75% 0 0)');get('#comparisonStatus').value='입주 기록에서도 보임';get('#saveComparison').onclick();assert.equal(run('state.comparison.entrance'),'입주 기록에서도 보임');
context.location.hash='#response';run('render()');get('#claim').oninput({target:{value:'청소비'}});get('#amount').oninput({target:{value:'200000'}});get('#generateDraft').onclick();assert(get('#draft').value.includes('200,000원'));assert(get('#draft').value.includes('청소비'));assert(get('#draft').value.includes('견적·영수증'));assert(!get('#draft').value.includes('반드시 반환'));
context.location.hash='#home';run('render()');get('#sample').onclick();assert.equal(run('saved().length'),8);assert.equal(run("getRecord('entrance','before').note"),'<script>alert(1)</script> 작은 찍힘');assert.equal(run("getRecord('bath','before').sample"),true);
console.log('PASS routes, contract keywords, empty save guard, record persistence, XSS escaping, report, upload validation, comparison slider, draft values, sample preservation');
