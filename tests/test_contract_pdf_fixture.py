"""Regression of the exact user-uploaded Korean PDF; no generated substitute."""
import copy
import importlib.util
from pathlib import Path

import pytest
from pypdf import PdfReader

from app.contract_analysis import prepare_pdf,validate_evidence,normalize_text,AIError,usable_pdf_text
from app.schemas import ContractAnalysisResult
from test_contract_analysis import system,analyze
from test_contracts import create,upload_pdf,complete
from test_api import auth

ROOT=Path(__file__).resolve().parents[1]
PDF=ROOT/'tests/fixtures/dummy_rental_contract.pdf'
spec=importlib.util.spec_from_file_location('offline_pdf_check',ROOT/'scripts/check_contract_pdf.py')
check=importlib.util.module_from_spec(spec);spec.loader.exec_module(check)


@pytest.fixture
def document():
    assert PDF.is_file(),'The actual uploaded PDF fixture must be present; no substitute generated.'
    with PDF.open('rb') as f:return prepare_pdf(f,2)


def test_actual_fixture_reproduces_old_mismatch_without_replacement_character(document):
    pages=PdfReader(PDF).pages
    legacy=[p.extract_text() for p in pages]
    assert [len(t) for t in legacy]==[735,947]
    assert all('\ufffd' not in t for t in legacy)  # old quality gate incorrectly accepted these
    assert all(not usable_pdf_text(t) for t in legacy)
    assert all(check.needs_korea_cmap(p) for p in pages)
    assert all(normalize_text(clause) not in normalize_text(legacy[1]) for clause in check.DUMMY_CLAUSES)
    with pytest.raises(AIError) as exc:
        validate_evidence(check.dummy_result(),{'page_count':2,'texts':legacy})
    assert exc.value.detail.code=='AI_EVIDENCE_MISMATCH'
    assert len(validate_evidence(check.dummy_result(),document).findings)==6


def test_actual_pdf_all_six_clauses_are_on_page_two_and_financial_values_readable(document):
    assert document['text_methods']==['pdfminer_korea1','pdfminer_korea1']
    assert [len(t) for t in document['texts']]==[739,949]
    first,second=map(normalize_text,document['texts'])
    for clause in check.DUMMY_CLAUSES:
        assert normalize_text(clause) in second and normalize_text(clause) not in first
    for value in ['10,000,000원','500,000원','70,000원','2026년 11월 14일 ~ 2028년 11월 13일']:
        assert normalize_text(value) in first
    assert '150,000원' in second


@pytest.mark.parametrize('mutation',['wrong_page','wrong_amount','wrong_period','negation','rewritten_amount','invented'])
def test_real_pdf_rejects_semantic_and_page_changes(document,mutation):
    data=check.dummy_result().model_dump();data['findings']=data['findings'][:1]
    finding=data['findings'][0]
    if mutation=='wrong_page':finding['page_number']=1
    elif mutation=='wrong_amount':finding['clause_excerpt']=finding['clause_excerpt'].replace('150,000','160,000')
    elif mutation=='wrong_period':finding['clause_excerpt']=check.DUMMY_CLAUSES[3].replace('2개월','3개월')
    elif mutation=='negation':finding['clause_excerpt']=finding['clause_excerpt'].replace('공제한다','공제하지 않는다')
    elif mutation=='rewritten_amount':finding['clause_excerpt']=finding['clause_excerpt'].replace('150,000원','15만 원')
    else:finding['clause_excerpt']='계약 종료 후 임대인은 추가 위약금 500만원을 지급한다.'
    with pytest.raises(AIError):validate_evidence(ContractAnalysisResult.model_validate(data),document)


def test_actual_fixture_partial_failure_is_not_silently_accepted(document):
    data=check.dummy_result().model_dump();data['findings'][1]['page_number']=1
    checked=validate_evidence(ContractAnalysisResult.model_validate(data),document)
    assert len(checked.findings)==5
    assert any('2번 항목(1페이지): 근거 페이지 불일치' in w for w in checked.warnings)


def test_korea_fallback_failure_never_reuses_corrupted_text(monkeypatch):
    def failed(*args,**kwargs):raise ValueError('private source content')
    monkeypatch.setattr('app.contract_analysis.extract_pages',failed)
    with PDF.open('rb') as f:document=prepare_pdf(f,2)
    assert document['texts']==[None,None]
    with pytest.raises(AIError) as exc:validate_evidence(check.dummy_result(),document)
    assert exc.value.detail.code=='AI_EVIDENCE_UNAVAILABLE'


def test_exact_uploaded_pdf_mock_analysis_saves_and_reloads(system,caplog):
    client,remote,ai,_=system;source=PDF.read_bytes()
    cid=create(client).json()['data']['contract_id']
    assert upload_pdf(client,cid,source).status_code==200
    assert complete(client,cid).status_code==200
    ai.expected_pdf=source;ai.outputs=[check.dummy_result().model_dump()]
    response=analyze(client,cid)
    assert response.status_code==200,response.text
    assert len(response.json()['data']['findings'])==6
    reloaded=client.get(f'/api/contracts/{cid}',headers=auth()).json()['data']['analysis']
    assert reloaded['findings']==response.json()['data']['findings']
    assert analyze(client,cid).status_code==200 and len(ai.calls)==1
    assert '150,000원' not in caplog.text and '홍길동' not in caplog.text


def test_offline_report_contains_no_original_text():
    report=check.diagnose(PDF,True)
    assert report['dummy_check_passed'] and report['verified_findings']==6
    assert report['pages'][1]['clause_matches']==list(range(1,7))
    assert 'clause_excerpt' not in str(report) and '홍길동' not in str(report)
