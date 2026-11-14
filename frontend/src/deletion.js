// Browser confirmation is explicit and mobile accessible; never treat API failure as success.
export async function confirmPhotoDeletion(api,photo,signal){
  let paired=null;
  if(photo.stage==='entry'){
    const exits=await api('/api/move-out/photos',{signal});
    paired=exits.find(row=>row.paired_entry_photo_id===photo.photo_id)?.photo_id||null;
  }
  const message=photo.stage==='entry'
    ?paired?'이 입실 사진에는 연결된 퇴실 사진이 있습니다. 삭제하면 입실·퇴실 사진과 AI 분석·비교 결과가 모두 삭제됩니다. 계속하시겠습니까?':'이 입실 사진의 원본·미리보기와 AI 분석 결과를 삭제하시겠습니까?'
    :'이 퇴실 사진의 원본·미리보기와 AI 비교 결과를 삭제하시겠습니까? 연결된 입실 사진은 유지됩니다.';
  if(!window.confirm(message+' 삭제 후 복구할 수 없습니다. 백업·캐시의 즉시 영구 삭제를 의미하지 않습니다.'))return false;
  const query=paired?`?paired_exit_photo_id=${encodeURIComponent(paired)}`:'';
  await api(`/api/photos/${encodeURIComponent(photo.photo_id)}${query}`,{method:'DELETE',signal});
  return true;
}
