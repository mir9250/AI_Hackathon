"""Offline PDF diagnosis; no .env, network, source text output, or DB access."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'backend'))
from pypdf import PdfReader
from app.contract_analysis import prepare_pdf, normalize_text, validate_evidence, needs_korea_cmap
from app.schemas import ContractAnalysisResult

# These are the six clauses in the user-provided, explicitly fictional fixture.
# --check-dummy is opt-in and is not a claim about arbitrary uploaded contracts.
DUMMY_CLAUSES=[
    '퇴실 시 임차인은 청소비 150,000원을 부담하며, 해당 금액은 보증금에서 공제한다.',
    '벽지 및 장판은 훼손 여부와 관계없이 퇴실 시 전면 교체하며, 비용은 임차인이 부담한다.',
    '퇴실 시 발생하는 모든 원상복구 비용은 손상 원인 및 사용 기간과 관계없이 임차인이 부담한다.',
    '임차인은 계약 종료일 2개월 전까지 퇴실 의사를 임대인에게 통보한다.',
    '임차인은 실내 흡연을 하지 않으며, 흡연으로 인한 오염이 발생하면 관련 청소비를 부담한다.',
    '입실 및 퇴실 시 주택 상태를 사진으로 기록하고, 확인된 손상에 대해 상호 협의한다.',
]


def dummy_result():
    return ContractAnalysisResult.model_validate({
        'document_quality':'readable',
        'summary':{'deposit':10000000,'monthly_rent':500000,'maintenance_fee':70000,
                   'contract_period':'2026년 11월 14일 ~ 2028년 11월 13일',
                   'special_clauses_summary':None},
        'findings':[{'category':'로컬 원문 대조 테스트','priority':'low','title':f'특약 {i}',
            'page_number':2,'clause_excerpt':clause,'reason':'모의 응답 검증',
            'recommended_action':'원본 확인','evidence_type':'explicit_clause'}
            for i,clause in enumerate(DUMMY_CLAUSES,1)],
        'checklist':[],'warnings':['로컬 모의 응답이며 실제 GPT 분석이 아닙니다.']})


def diagnose(path,check_dummy=False):
    reader=PdfReader(path,strict=True)
    count=len(reader.pages)
    legacy=[page.extract_text() or '' for page in reader.pages]
    with path.open('rb') as source:document=prepare_pdf(source,count)
    report={'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'page_count':count,'pages':[]}
    for i,(old,text,method) in enumerate(zip(legacy,document['texts'],document['text_methods'])):
        row={'page':i+1,'legacy_characters':len(old),'characters':len(text or ''),'extractor':method,
             'adobe_korea1_without_tounicode':needs_korea_cmap(reader.pages[i]),
             'legacy_unexpected_controls':sum(ord(c)<32 and c not in '\n\r\t' for c in old),
             'unexpected_controls':sum(ord(c)<32 and c not in '\n\r\t' for c in text or '')}
        if check_dummy:
            row['legacy_clause_matches']=[j for j,c in enumerate(DUMMY_CLAUSES,1) if normalize_text(c) in normalize_text(old)]
            row['clause_matches']=[j for j,c in enumerate(DUMMY_CLAUSES,1) if normalize_text(c) in normalize_text(text)]
        report['pages'].append(row)
    if check_dummy:
        validated=validate_evidence(dummy_result(),document)
        report['verified_findings']=len(validated.findings)
        report['dummy_check_passed']=(count==2 and len(validated.findings)==6 and
            report['pages'][0]['clause_matches']==[] and report['pages'][1]['clause_matches']==list(range(1,7)))
    return report


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pdf',type=Path)
    parser.add_argument('--check-dummy',action='store_true',help='Check the six known clauses of the fictional fixture only')
    args=parser.parse_args()
    try:
        report=diagnose(args.pdf,args.check_dummy)
        print(json.dumps(report,ensure_ascii=False,indent=2))
        sys.exit(0 if not args.check_dummy or report['dummy_check_passed'] else 1)
    except Exception as error:
        # Do not print exception text or traceback: parsers can embed document text.
        print(json.dumps({'status':'failed','error_type':type(error).__name__}))
        sys.exit(1)
