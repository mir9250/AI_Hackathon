/* 플랫폼 인증 + D1 메타데이터 + 비공개 R2 원본. AI 경로와 독립적이다. */
const accountAreas=new Set(['entrance','bath','window','wall']);
class AccountError extends Error{constructor(message,status=400,code=null){super(message);this.status=status;this.code=code;}}
function accountIdentity(req){const id=req.headers.get('oai-authenticated-user-id'),email=req.headers.get('oai-authenticated-user-email');return id&&email?{id,email}:null;}
function requireAccountIdentity(req){const user=accountIdentity(req);if(!user)throw new AccountError('로그인이 필요합니다.',401);return user;}
function requireCloud(env){if(!env.DB||!env.BUCKET)throw new AccountError('계정 저장소가 준비되지 않았습니다. 잠시 후 다시 시도해 주세요.',503);}
function mutationGuard(req){const url=new URL(req.url);if(req.headers.get('Origin')!==url.origin||req.headers.get('Sec-Fetch-Site')==='cross-site')throw new AccountError('같은 사이트에서 요청해 주세요.',403);}
async function accountBody(req,max){if(req.headers.get('Content-Type')?.split(';')[0]!=='application/json')throw new AccountError('JSON 요청이 필요합니다.',415);const reader=req.body?.getReader();if(!reader)throw new AccountError('요청 내용이 없습니다.');const parts=[];let total=0;while(true){const r=await reader.read();if(r.done)break;total+=r.value.length;if(total>max){await reader.cancel();throw new AccountError('입력 내용이 너무 큽니다.',413);}parts.push(r.value);}const data=new Uint8Array(total);let cursor=0;for(const p of parts){data.set(p,cursor);cursor+=p.length;}try{return JSON.parse(new TextDecoder().decode(data));}catch{throw new AccountError('요청 내용을 읽지 못했습니다.');}}
async function registered(env,user){const row=await env.DB.prepare('SELECT id, email, display_name, created_at, last_login_at FROM users WHERE id = ?').bind(user.id).first();if(!row)throw new AccountError('돌려받집 프로필 등록을 먼저 완료해 주세요.',403);return row;}
function profileView(row){return {id:row.id,email:row.email,displayName:row.display_name,createdAt:row.created_at,lastLoginAt:row.last_login_at};}
function visitCookie(req){const match=/(?:^|;\s*)dg_visit=([a-f0-9]{32})(?:;|$)/.exec(req.headers.get('Cookie')||'');return match?.[1]||crypto.randomUUID().replaceAll('-','');}
function responseCookie(data,cookie){const response=json(data);response.headers.set('Set-Cookie',cookie);return response;}
async function accountSession(req,env,user,kind){
 const profile=await registered(env,user),visit=visitCookie(req),now=new Date().toISOString();
 const event=await env.DB.prepare('INSERT OR IGNORE INTO login_events (id,user_id,kind,visit_id,occurred_at) VALUES (?,?,?,?,?)').bind(crypto.randomUUID(),user.id,kind,visit,now).run();
 let lastLoginAt=profile.last_login_at;
 if(kind==='login'&&event.meta.changes){await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(now,user.id).run();lastLoginAt=now;}
 return responseCookie({ok:true,lastLoginAt},kind==='logout_requested'?'dg_visit=; Path=/api; Secure; HttpOnly; SameSite=Lax; Max-Age=0':`dg_visit=${visit}; Path=/api; Secure; HttpOnly; SameSite=Lax; Max-Age=3600`);
}
function boundedString(value,max,name){if(typeof value!=='string'||value.length>max)throw new AccountError(name+' 형식 또는 길이를 확인해 주세요.');return value;}
const journalCategories=new Set(['수리·점검','누수·결로','하자 발견','임대인 협의','비용·정산','기타']);
const journalStatuses=new Set(['기록만','진행 중','완료']);
function journalId(value){if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))throw new AccountError('일지 식별자를 확인해 주세요.');return value;}
function safeJournal(value,isDraft=false){
 if(!value||typeof value!=='object'||Array.isArray(value))throw new AccountError('일지 형식을 확인해 주세요.');
 const eventDate=boundedString(value.eventDate??'',10,'발생일');
 if((!isDraft||eventDate)&&(!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)||!Number.isFinite(Date.parse(eventDate))||new Date(eventDate).toISOString().slice(0,10)!==eventDate))throw new AccountError('올바른 발생일을 입력해 주세요.');
 const title=boundedString(value.title??'',80,'일지 제목'),body=boundedString(value.body??'',2000,'일지 내용');
 if(!isDraft&&(!title.trim()||!body.trim()))throw new AccountError('일지 제목과 내용을 입력해 주세요.');
 if(!journalCategories.has(value.category)||!journalStatuses.has(value.status)||!(value.area==='general'||accountAreas.has(value.area)))throw new AccountError('일지 분류와 상태를 확인해 주세요.');
 const out={eventDate,title,body,category:value.category,status:value.status,area:value.area};
 if(isDraft){out.editId=value.editId?journalId(value.editId):'';return out;}
 out.id=journalId(value.id);
 for(const field of ['createdAt','updatedAt']){out[field]=boundedString(value[field],40,'일지 기록 시각');if(!Number.isFinite(Date.parse(out[field])))throw new AccountError('일지 기록 시각을 확인해 주세요.');}
 return out;
}
function safeWorkspace(input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw new AccountError('저장할 기록 형식을 확인해 주세요.');
 const out={area:accountAreas.has(input.area)?input.area:'entrance',phase:input.phase==='after'?'after':'before',records:{},ai:{},sample:!!input.sample,contract:boundedString(input.contract??'',12000,'특약'),clauses:null,amount:boundedString(String(input.amount??''),20,'금액'),claim:boundedString(input.claim??'',100,'공제 항목'),draft:boundedString(input.draft??'',16000,'초안'),comparison:{}};
 if(!input.records||typeof input.records!=='object'||Array.isArray(input.records))throw new AccountError('공간 기록을 확인해 주세요.');
 for(const [key,record]of Object.entries(input.records)){
  const parts=key.split('-');if(parts.length!==2||!accountAreas.has(parts[0])||!['before','after'].includes(parts[1])||!record||typeof record!=='object')throw new AccountError('공간 구분을 확인해 주세요.');
  const photoId=record.photoId??'';if(typeof photoId!=='string'||(photoId&&!/^[a-f0-9]{64}$/.test(photoId)))throw new AccountError('사진 식별자를 확인해 주세요.');
  if(record.image&&record.image!==(photoId?'/api/photos/'+photoId:''))throw new AccountError('사진 원본은 사진 업로드 API로 먼저 저장해 주세요.');
  out.records[key]={note:boundedString(record.note??'',2000,'메모'),tag:boundedString(record.tag??'확인 필요',64,'상태'),filename:boundedString(record.filename??'',255,'파일 이름'),savedAt:boundedString(record.savedAt??'',40,'기록 시각'),sample:!!record.sample,photoId,image:photoId?'/api/photos/'+photoId:''};
 }
 for(const [key,value]of Object.entries(input.comparison||{})){if(!accountAreas.has(key))throw new AccountError('비교 위치를 확인해 주세요.');out.comparison[key]=boundedString(value,100,'비교 메모');}
 for(const [key,entry]of Object.entries(input.ai||{})){
  if(!/^(record\/(entrance|bath|window|wall)\/(before|after)|compare\/(entrance|bath|window|wall)|contract|response)$/.test(key)||!entry?.result)throw new AccountError('분석 기록 형식을 확인해 주세요.');
  // 이전 스키마의 태그 없는 응답도 기기에서 보존될 수 있다.
  const a={...entry.result.analysis,tags:entry.result.analysis?.tags||[]};check(a,AI.schema);
  out.ai[key]={signature:boundedString(entry.signature,32,'분석 식별자'),result:{analysis:a,task:boundedString(entry.result.task,20,'분석 유형'),model:boundedString(entry.result.model,100,'모델'),createdAt:boundedString(entry.result.createdAt,40,'분석 시각')}};
 }
 if(!Array.isArray(input.journal??[])||(input.journal??[]).length>100)throw new AccountError('생활 일지는 최대 100개까지 저장할 수 있습니다.');
 out.journal=(input.journal??[]).map(j=>safeJournal(j));
 if(new Set(out.journal.map(j=>j.id)).size!==out.journal.length)throw new AccountError('중복된 일지를 확인해 주세요.');
 out.journalDraft=input.journalDraft==null?null:safeJournal(input.journalDraft,true);
 if(new TextEncoder().encode(JSON.stringify(out)).length>400000)throw new AccountError('저장할 메모가 너무 큽니다.',413);
 return out;
}
async function cloudWorkspace(req,env,user){
 await registered(env,user);
 if(req.method==='GET'){const row=await env.DB.prepare('SELECT payload,version,updated_at FROM workspaces WHERE user_id = ?').bind(user.id).first();return json({workspace:row?JSON.parse(row.payload):null,version:row?.version??0,updatedAt:row?.updated_at??null});}
 const body=await accountBody(req,512*1024);if(!Number.isSafeInteger(body.baseVersion)||body.baseVersion<0)throw new AccountError('저장 버전을 확인해 주세요.');
 const workspace=safeWorkspace(body.workspace);
 for(const record of Object.values(workspace.records)){if(record.photoId&&!await env.DB.prepare('SELECT id FROM photos WHERE id = ? AND user_id = ?').bind(record.photoId,user.id).first())throw new AccountError('접근할 수 없는 사진입니다.',403);}
 const now=new Date().toISOString();const updated=await env.DB.prepare('UPDATE workspaces SET payload = ?,version = version + 1,updated_at = ? WHERE user_id = ? AND version = ?').bind(JSON.stringify(workspace),now,user.id,body.baseVersion).run();
 if(updated.meta.changes!==1)throw new AccountError('다른 기기에서 기록이 변경되었습니다. 서버 기록을 다시 불러온 뒤 저장해 주세요.',409);
 return json({version:body.baseVersion+1,updatedAt:now});
}
async function accountPhoto(req,env,user,id){
 await registered(env,user);
 if(req.method==='GET'){
  if(!/^[a-f0-9]{64}$/.test(id))throw new AccountError('사진을 찾을 수 없습니다.',404);
  const row=await env.DB.prepare('SELECT object_key,mime FROM photos WHERE id = ? AND user_id = ?').bind(id,user.id).first();if(!row)throw new AccountError('사진을 찾을 수 없습니다.',404);
  const file=await env.BUCKET.get(row.object_key);if(!file)throw new AccountError('사진 원본을 불러오지 못했습니다.',404);
  return new Response(file.body,{headers:{...headers,'Content-Type':row.mime,'Content-Disposition':'inline','Cross-Origin-Resource-Policy':'same-origin'}});
 }
 const mime=req.headers.get('Content-Type')?.split(';')[0];if(!['image/jpeg','image/png','image/webp'].includes(mime))throw new AccountError('JPG, PNG, WEBP 사진만 저장할 수 있습니다.',415);
 const reader=req.body?.getReader();if(!reader)throw new AccountError('사진이 없습니다.');const chunks=[];let size=0;while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>4*1024*1024){await reader.cancel();throw new AccountError('사진은 4MB 이하여야 합니다.',413);}chunks.push(value);}const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
 const valid=mime==='image/jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:mime==='image/png'?[137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v):new TextDecoder().decode(bytes.slice(0,4))==='RIFF'&&new TextDecoder().decode(bytes.slice(8,12))==='WEBP';if(!valid)throw new AccountError('사진 형식을 확인해 주세요.');
 const identity=new TextEncoder().encode(user.id+'\0');const combined=new Uint8Array(identity.length+bytes.length);combined.set(identity);combined.set(bytes,identity.length);const photoId=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',combined)),b=>b.toString(16).padStart(2,'0')).join('');
 const existing=await env.DB.prepare('SELECT id FROM photos WHERE id = ? AND user_id = ?').bind(photoId,user.id).first();
 if(!existing){const usage=await env.DB.prepare('SELECT COALESCE(SUM(bytes),0) AS total FROM photos WHERE user_id = ?').bind(user.id).first();if(usage.total+size>128*1024*1024)throw new AccountError('계정 사진 저장 한도(128MB)에 도달했습니다.',413);const objectKey='photos/'+photoId;await env.BUCKET.put(objectKey,bytes,{httpMetadata:{contentType:mime}});await env.DB.prepare('INSERT OR IGNORE INTO photos (id,user_id,object_key,mime,bytes,created_at) VALUES (?,?,?,?,?,?)').bind(photoId,user.id,objectKey,mime,size,new Date().toISOString()).run();}
 return json({id:photoId,url:'/api/photos/'+photoId,bytes:size});
}
async function accountAPI(req,env){
 const path=new URL(req.url).pathname;
 if(!path.startsWith('/api/account/')&&path!=='/api/workspace'&&path!=='/api/photos'&&!path.startsWith('/api/photos/'))return null;
 try{
  const identity=accountIdentity(req);
  if(path==='/api/account/me'&&req.method==='GET'){
   if(!identity)return json({authenticated:false,registered:false,cloudAvailable:!!(env.DB&&env.BUCKET),signInUrl:'/signin-with-chatgpt?return_to=%2F%23account'});
   requireCloud(env);const row=await env.DB.prepare('SELECT id,email,display_name,created_at,last_login_at FROM users WHERE id = ?').bind(identity.id).first();return json({authenticated:true,registered:!!row,user:row?profileView(row):{id:identity.id,email:identity.email},cloudAvailable:true});
  }
  const user=requireAccountIdentity(req);requireCloud(env);
  const expected=req.headers.get('X-Account-Id');
  if((expected&&expected!==user.id)||(!['GET','HEAD'].includes(req.method)&&!expected))throw new AccountError('브라우저의 로그인 계정이 변경되었습니다. 기기 기록을 보관한 뒤 새로고침해 주세요.',409,'ACCOUNT_CHANGED');
  if(!['GET','HEAD'].includes(req.method))mutationGuard(req);
  if(path==='/api/account/register'&&req.method==='POST'){
   const body=await accountBody(req,4096);const name=boundedString(body.displayName,40,'닉네임').trim();if(!name||body.consent!==true)throw new AccountError('닉네임과 계정 저장 동의를 확인해 주세요.');
   const now=new Date().toISOString();const empty={journal:[],journalDraft:null,area:'entrance',phase:'before',records:{},ai:{},sample:false,contract:'',clauses:null,amount:'',claim:'',draft:'',comparison:{}};
   const inserted=await env.DB.prepare('INSERT OR IGNORE INTO users (id,email,display_name,created_at) VALUES (?,?,?,?)').bind(user.id,user.email,name,now).run();
   await env.DB.prepare('INSERT OR IGNORE INTO workspaces (user_id,payload,version,updated_at) VALUES (?,?,0,?)').bind(user.id,JSON.stringify(empty),now).run();
   if(inserted.meta.changes)await env.DB.prepare('INSERT INTO login_events (id,user_id,kind,visit_id,occurred_at) VALUES (?,?,?,?,?)').bind(crypto.randomUUID(),user.id,'register',crypto.randomUUID(),now).run();
   return json({user:profileView(await registered(env,user))});
  }
  if(path==='/api/account/session'&&req.method==='POST')return await accountSession(req,env,user,'login');
  if(path==='/api/account/logout'&&req.method==='POST')return await accountSession(req,env,user,'logout_requested');
  if(path==='/api/account/history'&&req.method==='GET'){await registered(env,user);const rows=await env.DB.prepare('SELECT kind,occurred_at FROM login_events WHERE user_id = ? ORDER BY occurred_at DESC LIMIT 20').bind(user.id).all();return json({events:rows.results});}
  if(path==='/api/workspace'&&['GET','PUT'].includes(req.method))return await cloudWorkspace(req,env,user);
  if(path==='/api/photos'&&req.method==='POST')return await accountPhoto(req,env,user,null);
  if(path.startsWith('/api/photos/')&&req.method==='GET')return await accountPhoto(req,env,user,path.slice('/api/photos/'.length));
  return json({error:'지원하지 않는 계정 요청입니다.'},405);
 }catch(e){return json({error:e instanceof AccountError?e.message:'계정 저장소 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',...(e instanceof AccountError&&e.code?{code:e.code}:{})},e instanceof AccountError?e.status:503);}
}
