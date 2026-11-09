/* 기기 캐시 + 인증된 계정의 서버 기록. 사용자 전환 시 저장 공간도 분리한다. */
(function(){
  let database,queue=Promise.resolve(),session={authenticated:false,registered:false,cloudAvailable:false},version=0,enabled=false,blocked=false,invalidSession=false,lastRemote='',stateStatus={mode:'local',label:'이 기기에 저장됨',message:''};
  const photoIds=new Map();
  function emit(mode,label,message=''){stateStatus={mode,label,message};if(typeof CustomEvent!=='undefined'&&window.dispatchEvent)window.dispatchEvent(new CustomEvent('deposit-storage-status',{detail:stateStatus}));}
  function open(){if(!database)database=new Promise((resolve,reject)=>{if(!window.indexedDB){reject(Error('기기 저장을 사용할 수 없습니다.'));return;}const r=indexedDB.open('deposit-guardian',1);r.onupgradeneeded=()=>r.result.createObjectStore('workspace');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.onblocked=()=>reject(Error('다른 탭을 닫고 다시 시도해 주세요.'));});return database;}
  async function localRead(key){const db=await open();return new Promise((resolve,reject)=>{const r=db.transaction('workspace').objectStore('workspace').get(key);r.onsuccess=()=>resolve(r.result||null);r.onerror=()=>reject(r.error);});}
  async function localWrite(key,value){const db=await open();return new Promise((resolve,reject)=>{const tx=db.transaction('workspace','readwrite');tx.objectStore('workspace').put(value,key);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('기기 저장이 취소되었습니다.'));});}
  const clone=v=>JSON.parse(JSON.stringify(v));
  function key(){return session.authenticated?'account:'+session.user.id:'current';}
  async function api(path,options={}){const requestHeaders=new Headers(options.headers||{});if(path!=='/api/account/me'&&session.authenticated)requestHeaders.set('X-Account-Id',session.user.id);const r=await fetch(path,{credentials:'same-origin',cache:'no-store',...options,headers:requestHeaders});let data;try{data=await r.json();}catch{throw Error('계정 서버 응답을 읽지 못했습니다.');}if(!r.ok){const e=Error(data.error||'서버 요청에 실패했습니다.');e.status=r.status;e.code=data.code;throw e;}return data;}
  function post(path,body){return api(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});}
  function toDataURL(blob){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(blob);});}
  async function hydrate(workspace){const value=clone(workspace);for(const record of Object.values(value.records||{})){if(record.photoId){const url='/api/photos/'+record.photoId;const r=await fetch(url,{credentials:'same-origin',cache:'no-store'});if(!r.ok)throw Error('계정 사진 일부를 불러오지 못했습니다. 서버 기록을 덮어쓰지 않습니다.');record.image=await toDataURL(await r.blob());photoIds.set(record.image,record.photoId);}}return value;}
  async function serialize(snapshot){const value=clone(snapshot);for(const r of Object.values(value.records||{})){if(r.image){let id=photoIds.get(r.image);if(!id){if(!r.image.startsWith('data:image/'))throw Error('기기 사진을 다시 선택해 주세요.');const blob=await (await fetch(r.image)).blob();const response=await api('/api/photos',{method:'POST',headers:{'Content-Type':blob.type},body:blob});id=response.id;photoIds.set(r.image,id);}r.photoId=id;r.image='/api/photos/'+id;}else{r.photoId='';r.image='';}}return value;}
  async function load(){
    if(typeof fetch==='function'){try{session=await api('/api/account/me');}catch{session={authenticated:false,registered:false,cloudAvailable:false};}}
    if(!session.authenticated){emit('local','이 기기에 저장됨','로그인하면 계정에 백업할 수 있습니다.');return localRead('current');}
    if(!session.registered){emit('register','프로필 등록 필요');return null;}
    try{
      const visit=await post('/api/account/session',{});session.user.lastLoginAt=visit.lastLoginAt;invalidSession=false;
      const remote=await api('/api/workspace');const cached=await localRead(key());
      if(cached?.dirty){version=cached.version||0;lastRemote=JSON.stringify(remote.workspace);blocked=remote.version!==version;enabled=!blocked;emit(blocked?'conflict':'pending',blocked?'다른 기기 변경 확인 필요':'미동기화 기기 기록 복원',blocked?'기기 기록을 보존했습니다. 내보내기 후 서버 기록을 확인하세요.':'기기에 남은 미동기화 기록을 복원했습니다.');return cached.state;}
      version=remote.version;
      const value=remote.workspace?await hydrate(remote.workspace):null;lastRemote=JSON.stringify(remote.workspace);enabled=true;blocked=false;
      if(value)await localWrite(key(),{state:value,version});emit('synced','계정에서 불러옴');return value;
    }catch(e){enabled=false;const cached=await localRead(key());version=cached?.version||0;emit('offline','서버 연결 확인 필요',e.message);return cached?.state||null;}
  }
  function save(value){
    const snapshot=clone(value),namespace=key(),accountId=session.user?.id;
    const task=queue.catch(()=>{}).then(async()=>{
      await localWrite(namespace,session.authenticated?{state:snapshot,version,dirty:!!session.registered}:snapshot);
      if(!session.authenticated||!session.registered){emit('local',session.authenticated?'프로필 등록 필요':'이 기기에 저장됨');return {local:true,cloud:false};}
      if(invalidSession){emit('session-changed','로그인 계정 변경됨','기기 기록은 보관했습니다. 새로고침 후 현재 계정으로 다시 불러오세요.');return {local:true,cloud:false};}
      if(!enabled||blocked){emit(blocked?'conflict':'offline',blocked?'다른 기기 변경 확인 필요':'기기에만 저장됨','서버 기록을 확인하고 다시 동기화해 주세요.');return {local:true,cloud:false};}
      if(accountId!==session.user?.id)throw Error('사용자가 변경되었습니다.');
      try{
        emit('syncing','계정에 저장 중…');const remote=await serialize(snapshot);const serialized=JSON.stringify(remote);
        if(serialized!==lastRemote){const response=await api('/api/workspace',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({workspace:remote,baseVersion:version})});version=response.version;lastRemote=serialized;}
        await localWrite(namespace,{state:snapshot,version,dirty:false});emit('synced','계정에 저장됨');return {local:true,cloud:true};
      }catch(e){if(e.code==='ACCOUNT_CHANGED')invalidSession=true;if(e.status===409)blocked=true;emit(invalidSession?'session-changed':blocked?'conflict':'offline',invalidSession?'로그인 계정 변경됨':blocked?'다른 기기 변경 확인 필요':'기기에만 저장됨',e.message);return {local:true,cloud:false,error:e.message};}
    });queue=task;return task;
  }
  async function refreshRemote(){await queue.catch(()=>{});if(!session.registered)throw Error('프로필을 먼저 등록해 주세요.');const old=await localRead(key());if(old)await localWrite('recovery:'+session.user.id+':'+Date.now(),old);const remote=await api('/api/workspace');const state=remote.workspace?await hydrate(remote.workspace):null;version=remote.version;lastRemote=JSON.stringify(remote.workspace);enabled=true;blocked=false;if(state)await localWrite(key(),{state,version});emit('synced','계정에서 불러옴');return state;}
  async function retry(value){await queue.catch(()=>{});if(invalidSession)throw Error('로그인 계정이 변경되어 새로고침이 필요합니다.');if(!session.registered)throw Error('로그인이 필요합니다.');const remote=await api('/api/workspace');if(remote.version!==version){blocked=true;enabled=false;emit('conflict','다른 기기 변경 확인 필요','서버 기록이 변경되어 자동 덮어쓰기를 중단했습니다.');throw Error('다른 기기의 기록이 있습니다. 내보내기 후 서버 기록을 불러오세요.');}enabled=true;blocked=false;return save(value);}
  async function register(displayName,consent){const data=await post('/api/account/register',{displayName,consent});session={...session,authenticated:true,registered:true,user:data.user};return load();}
  async function logout(){await queue.catch(()=>{});await post('/api/account/logout',{});if(stateStatus.mode==='synced')await localWrite(key(),null);location.assign('/signout-with-chatgpt?return_to=%2F');}
  async function importGuest(){const remote=await api('/api/workspace');const w=remote.workspace;const hasRecords=Object.values(w?.records||{}).some(r=>r.image||r.note);if(hasRecords||w?.contract||w?.draft||w?.journal?.length||w?.journalDraft?.body||w?.journalDraft?.title)throw Error('서버에 이미 기록이 있어 비회원 기록으로 덮어쓰지 않았습니다.');version=remote.version;enabled=true;blocked=false;const guest=await localRead('current');if(!guest)throw Error('가져올 비회원 기록이 없습니다.');const result=await save(guest);if(!result.cloud)throw Error(result.error||'계정 업로드를 완료하지 못했습니다. 기기 원본은 유지됩니다.');await localWrite('current',null);return guest;}
  async function checkSession(){
    if(typeof fetch!=='function')return {changed:false};
    const next=await api('/api/account/me');
    if((next.user?.id||null)!==(session.user?.id||null)||!!next.registered!==!!session.registered){invalidSession=true;enabled=false;blocked=true;emit('session-changed','로그인 정보 변경됨','기기 기록은 유지됩니다. 새로고침하면 현재 로그인 계정의 기록을 불러옵니다.');return {changed:true};}
    session=next;return {changed:false};
  }
  window.DepositStore={load,save,checkSession,session:()=>session,status:()=>({...stateStatus}),refreshRemote,retry,register,logout,importGuest,history:()=>api('/api/account/history'),guest:()=>localRead('current')};
})();
