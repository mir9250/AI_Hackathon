import { escapeHtml } from './ui.js';
const e=escapeHtml;
const errors={AI_DAILY_LIMIT:'오늘 사용할 수 있는 AI 분석 횟수를 모두 사용했어요. 내일 다시 이용해 주세요.',
  AI_CONTRACT_UNREADABLE:'계약서 글자를 읽지 못했어요. 아래 안내를 확인하고 모든 페이지를 선명하게 다시 등록해 주세요.',
  AI_EVIDENCE_UNAVAILABLE:'계약서 글자를 읽지 못해 분석 결과를 확인할 수 없어요. 글자를 선택할 수 있는 PDF로 다시 등록해 주세요.',
  AI_EVIDENCE_MISMATCH:'AI 분석 내용을 계약서 원문과 맞춰 보지 못해 결과를 저장하지 않았어요. 다시 시도해 주세요.',
  AI_PAGE_RANGE:'AI 분석 결과에 오류가 있어 저장하지 않았어요. 다시 시도해 주세요.',
  AI_CREDIT_REQUIRED:'AI 기능을 잠시 사용할 수 없어요. 잠시 후 다시 시도해 주세요.',AI_AUTH_ERROR:'AI 기능을 잠시 사용할 수 없어요. 잠시 후 다시 시도해 주세요.',AI_PERMISSION_ERROR:'AI 기능을 잠시 사용할 수 없어요. 잠시 후 다시 시도해 주세요.',AI_MODEL_UNAVAILABLE:'AI 기능을 잠시 사용할 수 없어요. 잠시 후 다시 시도해 주세요.',AI_SETUP_REQUIRED:'AI 기능을 잠시 사용할 수 없어요. 잠시 후 다시 시도해 주세요.',AI_NOT_CONFIGURED:'AI 기능을 잠시 사용할 수 없어요. 잠시 후 다시 시도해 주세요.',AI_UNAVAILABLE:'AI 기능을 잠시 사용할 수 없어요. 잠시 후 다시 시도해 주세요.',AI_RATE_LIMIT:'AI 기능을 잠시 사용할 수 없어요. 잠시 후 다시 시도해 주세요.',AI_SERVICE_ERROR:'AI 기능을 잠시 사용할 수 없어요. 잠시 후 다시 시도해 주세요.',
  AI_TIMEOUT:'계약서 분석이 오래 걸려 멈췄어요. 다시 시도해 주세요.',
  AI_STALE:'이전 분석이 중간에 멈췄어요. 다시 시도해 주세요.',
  AI_INVALID_RESPONSE:'AI 분석 결과를 정리하지 못했어요. 다시 시도해 주세요.'};
const money=(value)=>value==null?'확인 불가':Number(value).toLocaleString('ko-KR')+'원';
const value=(text)=>e(text??'확인 불가');

export function contractAnalysisMarkup(contract,{working=false,consent=false,error=''}={}) {
  const result=contract.analysis;
  if(contract.upload_status==='deleting')return '<p class="notice">계약서 삭제가 진행 중입니다. 삭제 버튼으로 재시도해 주세요.</p>';
  if(contract.upload_status!=='ready')return '<section class="card photo-section"><h3>계약서 AI 분석</h3><p>전체 페이지를 확인하고 계약서 등록을 완료한 뒤 분석할 수 있습니다.</p></section>';
  if(result?.status==='completed') {
    const summary=result.summary||{};
    return `<section class="card photo-section contract-analysis"><h3>① 계약서 주요 정보</h3>
      <p>문서 판독 상태: ${result.document_quality==='partially_readable'?'일부 판독 가능':'판독 가능'}</p>
      <dl class="contract-summary"><dt>보증금</dt><dd>${money(summary.deposit)}</dd><dt>월세</dt><dd>${money(summary.monthly_rent)}</dd>
      <dt>관리비</dt><dd>${money(summary.maintenance_fee)}</dd><dt>계약기간</dt><dd>${value(summary.contract_period)}</dd>
      <dt>특약사항 요약</dt><dd>${value(summary.special_clauses_summary)}</dd></dl>
      <h3>② 주의할 계약 조항</h3>${(result.findings||[]).length?result.findings.map((finding)=>{
        const page=contract.pages?.find((p)=>p.page_number===finding.page_number);
        const url=contract.source_type==='pdf'&&contract.signed_url?`${contract.signed_url}#page=${finding.page_number}`:page?.original_signed_url;
        return `<article class="damage-finding"><p>중요도: ${e({high:'높음',medium:'보통',low:'낮음'}[finding.priority]||finding.priority)} · ${e(finding.category)}</p>
          <h4>${e(finding.title)}</h4><p>${finding.page_number}페이지 · ${finding.evidence_type==='ambiguous_clause'?'모호한 조항':'명시 조항'}</p>
          ${url?`<a href="${e(url)}" target="_blank" rel="noopener noreferrer">${finding.page_number}페이지 원본 확인</a>`:''}
          <blockquote>${e(finding.clause_excerpt)}</blockquote><p><strong>검토 이유</strong> ${e(finding.reason)}</p>
          <p><strong>권장 조치</strong> ${e(finding.recommended_action)}</p></article>`;
      }).join(''):'<p>AI가 제시한 주의 조항이 없습니다. 계약서의 안전성이나 법적 효력을 보장하지 않습니다.</p>'}
      <h3>③ 추가 확인 체크리스트</h3>${(result.checklist||[]).map((item)=>`<article class="damage-finding"><h4>${e(item.title)}</h4><p>${e(item.reason)}</p><p>${e(item.action)}</p></article>`).join('')||'<p>추가 항목이 없습니다.</p>'}
      <h3>④ 분석 한계 및 경고</h3><ul>${(result.warnings||[]).map((warning)=>`<li>${e(warning)}</li>`).join('')}</ul>
      <p class="notice">법률 자문이 아닌 AI 참고 분석입니다. 계약 조항의 효력·위법성·손상 원인·당사자의 책임을 확정하지 않습니다. 원본과 실제 조건을 직접 확인하세요.</p></section>`;
  }
  const stale=result?.status==='analyzing'&&(!result.started_at||Date.now()-Date.parse(result.started_at)>=180000);
  const running=working||(result?.status==='analyzing'&&!stale);
  const message=error||(result?.status==='failed'?(errors[result.error_code]||'분석하지 못했어요. 계약서 원본을 확인한 뒤 다시 시도해 주세요.'):'');
  return `<section class="card photo-section contract-analysis"><h3>계약서 AI 분석</h3>
    <p>등록한 ${contract.source_type==='pdf'?'PDF 전체':'모든 이미지 페이지'}가 분석을 위해 외부 OpenAI API로 전송돼요. 이름·주소·연락처·계좌번호 같은 개인정보가 함께 전송될 수 있어요.</p>
    <label class="confirmation"><input id="contract-ai-consent" type="checkbox" ${consent?'checked':''} ${running?'disabled':''}>계약서 전체를 외부 OpenAI API로 전송하여 분석하는 데 동의합니다.</label>
    <p id="contract-ai-status" role="status" aria-live="polite">${running?'계약서 전체를 분석하고 있습니다…':stale?'분석이 오래 멈춰 있어요. 다시 시도해 주세요.':e(message||'미분석')}</p>
    <ul>${(result?.warnings||[]).map((warning)=>`<li>${e(warning)}</li>`).join('')}</ul>
    <button id="analyze-contract" type="button" ${running||!consent?'disabled':''}>${running?'분석 중…':result?.status==='failed'||stale?'AI 계약서 분석 다시 시도':'AI 계약서 분석하기'}</button>
    <p class="hint">법률 자문이 아닌 AI 참고 분석입니다. 계약서 원문을 직접 확인하세요.</p></section>`;
}
