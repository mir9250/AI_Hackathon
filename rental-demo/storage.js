/* 사진·메모를 이 브라우저에만 저장한다. 서버 DB가 아니다. */
(function(){
  let database,queue=Promise.resolve();
  function open(){if(!database)database=new Promise((resolve,reject)=>{if(!window.indexedDB){reject(Error('이 브라우저에서 기기 저장을 사용할 수 없습니다.'));return;}const r=indexedDB.open('deposit-guardian',1);r.onupgradeneeded=()=>r.result.createObjectStore('workspace');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.onblocked=()=>reject(Error('다른 탭을 닫고 다시 시도해 주세요.'));});return database;}
  async function load(){const db=await open();return new Promise((resolve,reject)=>{const r=db.transaction('workspace').objectStore('workspace').get('current');r.onsuccess=()=>resolve(r.result||null);r.onerror=()=>reject(r.error);});}
  function save(value){const snapshot=JSON.parse(JSON.stringify(value));const task=queue.catch(()=>{}).then(async()=>{const db=await open();await new Promise((resolve,reject)=>{const tx=db.transaction('workspace','readwrite');tx.objectStore('workspace').put(snapshot,'current');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('기기 저장이 취소되었습니다.'));});});queue=task;return task;}
  window.DepositStore={load,save};
})();
