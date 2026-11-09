/* BUILD_DATA */
const calls=new Map();
const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin'};
function json(value,status=200){return new Response(JSON.stringify(value),{status,headers:{...headers,'Content-Type':'application/json; charset=utf-8'}});}
class Invalid extends Error{}
function image(value){
 if(typeof value!=='string')throw new Invalid('이미지 형식을 확인해 주세요.');
 const m=/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(value);
 if(!m)throw new Invalid('JPG, PNG, WEBP 이미지만 분석할 수 있습니다.');
 let bytes;try{bytes=atob(m[2]);}catch{throw new Invalid('이미지 인코딩을 확인해 주세요.');}
 if(!bytes.length||bytes.length>4*1024*1024)throw new Invalid('웹 체험판에서는 사진당 4MB까지 분석할 수 있습니다.');
 const valid=m[1]==='jpeg'?bytes.startsWith('\xff\xd8\xff'):m[1]==='png'?bytes.startsWith('\x89PNG\r\n\x1a\n'):bytes.startsWith('RIFF')&&bytes.slice(8,12)==='WEBP';
 if(!valid)throw new Invalid('이미지 실제 형식을 확인해 주세요.');return value;
}
function validate(body){
 if(!body||typeof body!=='object'||Array.isArray(body))throw new Invalid('JSON 객체가 필요합니다.');
 const {task,consent}=body,text=body.text??'',area=body.area??'',images=body.images??[];
 if(!Object.hasOwn(AI.prompts,task)||consent!==true)throw new Invalid('분석 유형과 OpenAI 전송 동의를 확인해 주세요.');
 if(typeof text!=='string'||text.length>16000||typeof area!=='string'||area.length>100)throw new Invalid('텍스트 길이와 형식을 확인해 주세요.');
 const count={photo:1,compare:2,contract:0,draft:0}[task];
 if(!Array.isArray(images)||images.length!==count)throw new Invalid(`실제 사진 ${count}장이 필요합니다. 예시 도식은 분석하지 않습니다.`);
 if(!count&&text.trim().length<10)throw new Invalid('분석할 내용을 10자 이상 입력해 주세요.');
 return {task,text,area,images:images.map(image)};
}
function check(value,schema){
 if(schema.type==='object'){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join()!==schema.required.slice().sort().join())throw new Invalid('AI 응답 필수 항목이 맞지 않습니다.');for(const [key,s] of Object.entries(schema.properties))check(value[key],s);}
 else if(schema.type==='array'){if(!Array.isArray(value)||value.length>(schema.maxItems??10))throw new Invalid('AI 응답 목록 형식이 맞지 않습니다.');value.forEach(v=>check(v,schema.items));if(schema===AI.schema.properties.tags&&new Set(value).size!==value.length)throw new Invalid('AI 상태 태그에 중복 항목이 있습니다.');}
 else if(typeof value!=='string'||value.length>12000||(schema.enum&&!schema.enum.includes(value)))throw new Invalid('AI 응답 값 형식이 맞지 않습니다.');
}
async function analyze(req,env){
 const url=new URL(req.url);
 if(req.headers.get('Origin')&&req.headers.get('Origin')!==url.origin)return json({error:'같은 사이트에서 요청해 주세요.'},403);
 if(req.headers.get('Sec-Fetch-Site')==='cross-site')return json({error:'다른 사이트의 분석 요청은 지원하지 않습니다.'},403);
 if(req.headers.get('Content-Type')?.split(';')[0]!=='application/json')return json({error:'JSON 요청이 필요합니다.'},415);
 const length=Number(req.headers.get('Content-Length'));
 if(length>12*1024*1024)return json({error:'요청 자료가 너무 큽니다.'},413);
 let body;
 try{const reader=req.body?.getReader();if(!reader)throw Error();const parts=[];let size=0;while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>12*1024*1024){await reader.cancel();return json({error:'요청 자료가 너무 큽니다.'},413);}parts.push(value);}const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}body=validate(JSON.parse(new TextDecoder().decode(bytes)));}catch(e){return json({error:e instanceof Invalid?e.message:'입력 형식을 확인해 주세요.'},400);}
 if(!env.OPENAI_API_KEY)return json({error:'사이트의 AI 키가 아직 설정되지 않았습니다. 사진 기록과 리포트 기능은 사용할 수 있습니다.'},503);
 // 이 사이트는 owner-private 배포로 플랫폼 인증 경계 안에서 동작한다.
 const identity=req.headers.get('oai-authenticated-user-id');
 if(!identity)return json({error:'로그인한 사이트 소유자만 AI 분석을 요청할 수 있습니다.'},401);
 const now=Date.now();let recent=(calls.get(identity)||[]).filter(t=>now-t<60000);if(recent.length>=6)return json({error:'분당 분석 한도에 도달했습니다. 잠시 후 시도해 주세요.'},429);recent.push(now);calls.set(identity,recent);if(calls.size>1000)for(const [id,times]of calls){if(times.at(-1)<now-60000)calls.delete(id);}
 const content=[{type:'input_text',text:AI.prompts[body.task]+'\n공간: '+body.area+'\n사용자 제공 자료:\n'+body.text},...body.images.map(image_url=>({type:'input_image',image_url,detail:'high'}))];
 try{
  const upstream=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'Authorization':'Bearer '+env.OPENAI_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({model:env.OPENAI_MODEL||'gpt-4.1-mini',store:false,max_output_tokens:3000,instructions:AI.instructions,input:[{role:'user',content}],text:{format:{type:'json_schema',name:'rental_observation',strict:true,schema:AI.schema}}}),signal:AbortSignal.timeout(80000)});
  if(!upstream.ok)return json({error:upstream.status===429?'AI 사용 한도에 도달했습니다. 잠시 후 확인해 주세요.':'AI 서비스 요청이 실패했습니다. 서버 키와 모델 설정을 확인해 주세요.'},502);
  const result=await upstream.json();if(result.status!=='completed')throw new Invalid('AI 분석이 완료되지 않았습니다.');
  const entries=(result.output||[]).flatMap(i=>i.content||[]);if(entries.some(c=>c.type==='refusal'))throw new Invalid('이 자료에 대한 분석이 거절되었습니다.');
  const analysis=JSON.parse(entries.filter(c=>c.type==='output_text').map(c=>c.text).join(''));check(analysis,AI.schema);
  if(body.task==='contract'&&analysis.observations.some(o=>!o.evidence.trim()||!body.text.includes(o.evidence)))throw new Invalid('AI가 인용한 문구가 입력 특약에 없습니다. 결과를 표시하지 않았습니다.');
  return json({analysis,task:body.task,model:result.model||env.OPENAI_MODEL||'gpt-4.1-mini',createdAt:new Date().toISOString()});
 }catch(e){return json({error:e instanceof Invalid?e.message:e.name==='TimeoutError'?'AI 응답 시간이 초과되었습니다. 자동 재시도하지 않습니다.':'AI 분석에 실패했습니다. 잠시 후 다시 시도해 주세요.'},502);}
}
/* ACCOUNT_API */
export default {async fetch(req,env){
 const account=await accountAPI(req,env);if(account)return account;
 const url=new URL(req.url),path=url.pathname;
 if(path==='/api/health'&&req.method==='GET')return json({configured:!!env.OPENAI_API_KEY,model:env.OPENAI_MODEL||'gpt-4.1-mini',provider:'OpenAI',hosted:true,cloudAvailable:!!(env.DB&&env.BUCKET)});
 if(path==='/api/analyze'&&req.method==='POST')return analyze(req,env);
 if(req.method!=='GET'&&req.method!=='HEAD')return json({error:'지원하지 않는 요청입니다.'},405);
 const name=path==='/'||path==='/rental-demo/'?'/index.html':path.replace(/^\/rental-demo\//,'/');
 if(!Object.hasOwn(ASSETS,name))return json({error:'페이지를 찾을 수 없습니다.'},404);
 if(typeof ASSETS[name]==='object'){const asset=ASSETS[name];const bytes=Uint8Array.from(atob(asset.base64),c=>c.charCodeAt(0));return new Response(req.method==='HEAD'?null:bytes,{headers:{...headers,'Content-Type':asset.type}});}
 const type=name.endsWith('.html')?'text/html':name.endsWith('.css')?'text/css':'text/javascript';
 return new Response(req.method==='HEAD'?null:ASSETS[name],{headers:{...headers,'Content-Type':type+'; charset=utf-8'}});
}};
