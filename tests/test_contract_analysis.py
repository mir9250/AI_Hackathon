"""Full-document inputs and consent flow, with entirely mocked external HTTP."""
import asyncio
import base64
import copy
import io
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from pypdf import PdfReader, PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject

from app.api import create_app
from app.config import Settings
from test_api import USER_A, USER_B, NOW, auth
from test_contracts import ContractRemote, create, upload_pdf, upload_page, complete
from test_photos import image_bytes

TEXT_PAGES=[[
    'SYNTHETIC RENTAL CONTRACT - NOT A REAL AGREEMENT',
    'Deposit: KRW 10000000.', 'Monthly rent: KRW 600000.', 'Maintenance fee: KRW 50000.',
    'Term: 2026-01-01 to 2027-12-31.',
],[
    'SPECIAL CLAUSES - SYNTHETIC TEST DATA',
    'Tenant pays a cleaning fee of KRW 200000 at move-out.',
    'Tenant pays wallpaper and floor replacement regardless of condition.',
    'Restoration charges may be deducted from the deposit.',
]]


def synthetic_contract_pdf():
    # The user-mentioned fixture is absent. Build a separate in-memory two-page test document.
    out=io.BytesIO()
    with PdfWriter() as writer:
        font=writer._add_object(DictionaryObject({NameObject('/Type'):NameObject('/Font'),
            NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')}))
        for lines in TEXT_PAGES:
            page=writer.add_blank_page(width=595,height=842)
            page[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):font})})
            content=DecodedStreamObject()
            content.set_data(('BT /F1 11 Tf 48 790 Td 22 TL '+' '.join('('+line+') Tj T*' for line in lines)+' ET').encode('ascii'))
            page[NameObject('/Contents')]=writer._add_object(content)
        writer.write(out)
    return out.getvalue()


RESULT={'document_quality':'readable','summary':{'deposit':10000000,'monthly_rent':600000,'maintenance_fee':50000,
    'contract_period':'2026-01-01 ~ 2027-12-31','special_clauses_summary':'청소비, 벽지·장판 교체비와 원상복구비 부담 특약'},
    'findings':[{'category':'퇴실 청소비','priority':'medium','title':'퇴실 청소비 부담', 'page_number':2,
      'clause_excerpt':TEXT_PAGES[1][1],'reason':'퇴실 시 비용 부담이 명시되어 있습니다.',
      'recommended_action':'청소비 적용 조건과 금액을 원본에서 확인하세요.','evidence_type':'explicit_clause'},
      {'category':'원상복구','priority':'high','title':'상태와 무관한 교체비 부담','page_number':2,
       'clause_excerpt':TEXT_PAGES[1][2],'reason':'교체비 부담 범위가 넓게 표현되어 있습니다.',
       'recommended_action':'실제 적용 범위와 상태 기준을 확인하세요.','evidence_type':'explicit_clause'}],
    'checklist':[{'title':'보증보험 가입 가능 여부','reason':'계약서만으로 실제 가입 여부를 확인할 수 없습니다.','action':'별도 가입 자료를 확인하세요.'}],
    'warnings':['법률 자문이 아닌 AI 참고 분석입니다.']}


class ContractAnalysisRemote(ContractRemote):
    def __init__(self):
        super().__init__();self.analyses={};self.logs={};self.missing_sql=False;self.save_fail=False;self.fetch_fail=False

    def __call__(self,request):
        path=request.url.path
        if path.startswith('/rest/v1/rpc/'):
            self.calls.append(request)
            assert request.headers['apikey']=='sb_secret_unit_test' and 'authorization' not in request.headers
            if self.missing_sql:return httpx.Response(404,json={'code':'PGRST202'})
            data=json.loads(request.content);cid=data['p_contract_id']
            assert data['p_user_id']==USER_A
            row=self.contracts[cid];fn=path.rsplit('/',1)[-1]
            if fn=='begin_contract_analysis':
                assert data['p_consent'] is True and row['upload_status']=='ready'
                current=self.analyses.get(cid)
                if current and current['status']=='completed':return httpx.Response(200,json={'action':'completed','analysis':current})
                if current and current['status']=='analyzing' and not current.get('stale'):return httpx.Response(200,json={'action':'busy'})
                rid=data['p_request_id'];self.logs[rid]={'status':'pending','attempted':False,'task_type':'contract_analysis'}
                self.analyses[cid]={'contract_id':cid,'status':'analyzing','document_quality':None,'summary':None,
                    'findings':[],'checklist':[],'warnings':[],'error_code':None,'model_name':None,'consent_at':NOW,
                    'started_at':NOW,'updated_at':NOW,'active_request_id':rid}
                return httpx.Response(200,json={'action':'acquired'})
            current=self.analyses[cid]
            if fn=='reserve_contract_ai_attempt':
                assert current['active_request_id']==data['p_active_request_id']
                if sum(log['attempted'] for log in self.logs.values())>=data['p_limit']:return httpx.Response(200,json={'action':'limit'})
                rid=data['p_attempt_id'];self.logs[rid]={'status':'analyzing','attempted':True,'task_type':'contract_analysis'}
                current['active_request_id']=rid;return httpx.Response(200,json={'action':'reserved','request_id':rid})
            assert fn=='finish_contract_ai_attempt'
            if self.save_fail:return httpx.Response(500,json={})
            rid=data['p_request_id']
            if current['active_request_id']!=rid or current['status']!='analyzing':return httpx.Response(200,json={'action':'superseded'})
            result=data['p_result'];failed=result is None or result['document_quality']=='unreadable'
            self.logs[rid]['status']='failed' if failed else 'completed'
            if data['p_final']:
                current.update(status='failed' if failed else 'completed',error_code=data['p_error_code'],model_name=data['p_model'])
                if result:current.update(result)
            return httpx.Response(200,json={'action':'saved','analysis':current})
        if path.startswith('/storage/v1/object/authenticated/'):
            self.calls.append(request)
            assert request.headers['apikey']=='sb_secret_unit_test'
            if self.fetch_fail:return httpx.Response(500)
            key=path.split('/deposit-private/',1)[1]
            return httpx.Response(200,content=self.objects[key])
        response=super().__call__(request)
        if path=='/rest/v1/contracts' and request.method=='GET' and response.status_code==200:
            rows=response.json()
            for row in rows:row['contract_analyses']=self.analyses.get(row['contract_id'])
            return httpx.Response(200,json=rows)
        return response


class MockContractAI:
    def __init__(self):
        self.calls=[];self.outputs=[];self.expected_pdf=None;self.expected_pages=2
        self.wait=False;self.entered=threading.Event();self.release=threading.Event()

    async def __call__(self,request):
        self.calls.append(request)
        assert str(request.url)=='https://api.openai.com/v1/responses'
        assert request.headers['authorization']=='Bearer unit-openai-secret'
        payload=json.loads(request.content)
        assert payload['store'] is False and payload['model']=='gpt-5.4-mini'
        assert payload['text']['format']['strict'] is True
        assert set(payload['text']['format']['schema']['properties'])=={'document_quality','summary','findings','checklist','warnings'}
        content=payload['input'][0]['content']
        assert json.loads(content[0]['text'])['registered_page_count']==self.expected_pages
        files=[part for part in content if part['type']=='input_file']
        if files:
            assert len(files)==1 and files[0]['detail']=='high'
            decoded=base64.b64decode(files[0]['file_data'].split(',',1)[1])
            assert decoded==self.expected_pdf
            assert len(PdfReader(io.BytesIO(decoded)).pages)==self.expected_pages
        else:
            images=[part for part in content if part['type']=='input_image']
            assert len(images)==self.expected_pages
            labels=[part['text'] for part in content[1:] if part['type']=='input_text']
            assert labels==[f'계약서 {i}페이지' for i in range(1,self.expected_pages+1)]
            assert all(part['image_url'].startswith('data:image/jpeg;base64,') for part in images)
        assert 'file_id' not in str(payload) and 'supabase.co' not in str(payload)
        self.entered.set()
        while self.wait and not self.release.is_set():await asyncio.sleep(.005)
        result=self.outputs.pop(0) if self.outputs else copy.deepcopy(RESULT)
        if isinstance(result,Exception):raise result
        if isinstance(result,httpx.Response):return result
        return httpx.Response(200,json={'status':'completed','output':[{'type':'message','content':[{'type':'output_text','text':json.dumps(result)}]}]})


@pytest.fixture
def system():
    remote=ContractAnalysisRemote();ai=MockContractAI()
    settings=Settings(_env_file=None,supabase_url='https://local-test.supabase.co',supabase_publishable_key='sb_publishable_unit_test',
        supabase_secret_key='sb_secret_unit_test',openai_api_key='unit-openai-secret')
    with TestClient(create_app(settings,httpx.MockTransport(remote),httpx.MockTransport(ai))) as client:
        yield client,remote,ai,settings


def ready_pdf(system):
    client,remote,ai,_=system
    source=synthetic_contract_pdf();cid=create(client).json()['data']['contract_id']
    assert upload_pdf(client,cid,source).status_code==200
    assert complete(client,cid).status_code==200
    ai.expected_pdf=source
    return cid


def analyze(client,cid,consent=True,user=USER_A):
    return client.post(f'/api/contracts/{cid}/analyze',headers=auth(user),json={'consent':consent})


def test_pdf_all_pages_extraction_evidence_storage_and_cached_result(system):
    client,remote,ai,settings=system;cid=ready_pdf(system)
    response=analyze(client,cid);assert response.status_code==200,response.text
    result=response.json()['data']
    assert result['summary']==RESULT['summary']
    assert result['findings']==RESULT['findings'] and result['checklist']==RESULT['checklist']
    assert result['consent_at'] and result['status']=='completed'
    assert remote.logs[result['active_request_id']]['status']=='completed'
    from pydantic import SecretStr
    settings.openai_api_key=SecretStr('')
    assert analyze(client,cid).status_code==200 and len(ai.calls)==1
    for _ in range(2):
        detail=client.get(f'/api/contracts/{cid}',headers=auth()).json()['data']
        assert detail['analysis']['summary']['deposit']==10000000
        assert detail['analysis_status']=='completed'
        listed=client.get('/api/contracts',headers=auth()).json()['data'][0]
        assert listed['analysis']['findings'][0]['page_number']==2


def test_multi_image_contract_includes_each_registered_page_and_warns_on_unverified_quotes(system):
    client,remote,ai,_=system;cid=create(client,'images').json()['data']['contract_id']
    assert upload_page(client,cid,2,image_bytes('HEIF'),'page.heic','image/heic').status_code==200
    assert upload_page(client,cid,1).status_code==200
    complete(client,cid)
    response=analyze(client,cid);assert response.status_code==502,response.text
    assert response.json()['error']['code']=='AI_EVIDENCE_UNAVAILABLE'
    assert remote.analyses[cid]['status']=='failed'
    downloads=[r.url.path for r in remote.calls if '/object/authenticated/' in r.url.path]
    assert '/page-1/' in downloads[0] and '/page-2/' in downloads[1] and downloads[1].endswith('original.heic')


@pytest.mark.parametrize('mode',['missing','false','string','spoof'])
def test_explicit_strict_consent_required_before_any_document_or_rpc(system,mode):
    client,remote,ai,_=system;cid=ready_pdf(system);before=len(remote.calls)
    body={'missing':{},'false':{'consent':False},'string':{'consent':'true'},'spoof':{'consent':True,'user_id':USER_B}}[mode]
    response=client.post(f'/api/contracts/{cid}/analyze',headers=auth(),json=body)
    assert response.status_code==422 and not ai.calls
    assert not remote.logs
    assert not any('/object/authenticated/' in r.url.path or '/rpc/' in r.url.path for r in remote.calls[before:])


def test_auth_owner_and_ready_checks_precede_ai(system):
    client,remote,ai,_=system;cid=ready_pdf(system)
    assert client.post(f'/api/contracts/{cid}/analyze',json={'consent':True}).status_code==401
    assert analyze(client,cid,user=USER_B).status_code==404
    remote.contracts[cid]['upload_status']='draft'
    assert analyze(client,cid).status_code==409
    assert not ai.calls and not remote.logs


@pytest.mark.parametrize('change,code',[
    ('page','AI_PAGE_RANGE'),('wrong_page','AI_EVIDENCE_MISMATCH'),('fake_quote','AI_EVIDENCE_MISMATCH'),
    ('extra','AI_INVALID_RESPONSE'),('invalid_number','AI_INVALID_RESPONSE'),('missing','AI_INVALID_RESPONSE')])
def test_bad_schema_or_evidence_never_saved_as_completed(system,change,code):
    client,remote,ai,_=system;cid=ready_pdf(system);result=copy.deepcopy(RESULT)
    if change=='page':result['findings'][0]['page_number']=3
    elif change=='wrong_page':result['findings'][0]['page_number']=1
    elif change=='fake_quote':result['findings'][0]['clause_excerpt']='This clause does not exist.'
    elif change=='extra':result['legal_verdict']='void'
    elif change=='invalid_number':result['summary']['deposit']='unknown'
    elif change=='missing':del result['findings'][0]['evidence_type']
    if change in {'page','wrong_page','fake_quote'}:result['findings']=result['findings'][:1]
    ai.outputs=[result];response=analyze(client,cid)
    assert response.json()['error']['code']==code,response.text
    assert remote.analyses[cid]['status']=='failed' and len(ai.calls)==1


def test_normalized_whitespace_quotes_and_unknown_amounts(system):
    client,remote,ai,_=system;cid=ready_pdf(system);result=copy.deepcopy(RESULT)
    result['findings'][0]['clause_excerpt']=result['findings'][0]['clause_excerpt'].replace(' ','\n')
    result['summary']['maintenance_fee']=None;result['summary']['contract_period']=None
    ai.outputs=[result];response=analyze(client,cid)
    assert response.status_code==200,response.text
    assert response.json()['data']['summary']['maintenance_fee'] is None
    assert response.json()['data']['summary']['contract_period'] is None


def test_unreadable_clears_invented_amounts_records_failed_and_keeps_reupload_guidance(system):
    client,remote,ai,_=system;cid=ready_pdf(system);result=copy.deepcopy(RESULT)
    result['document_quality']='unreadable';result['warnings']=['2페이지 글자가 흐립니다. 전체 페이지를 선명하게 다시 등록하세요.']
    ai.outputs=[result];response=analyze(client,cid)
    assert response.status_code==422 and response.json()['error']['code']=='AI_CONTRACT_UNREADABLE'
    saved=remote.analyses[cid]
    assert saved['status']=='failed' and saved['document_quality']=='unreadable'
    assert all(value is None for value in saved['summary'].values()) and saved['findings']==[]
    assert saved['warnings']==result['warnings'] and saved['consent_at']
    assert remote.logs[saved['active_request_id']]['status']=='failed'
    assert client.get(f'/api/contracts/{cid}',headers=auth()).json()['data']['analysis_status']=='failed'


def test_partial_readability_has_limit_warning(system):
    client,remote,ai,_=system;cid=ready_pdf(system);result=copy.deepcopy(RESULT)
    result['document_quality']='partially_readable';result['warnings']=[];result['summary']['monthly_rent']=None
    ai.outputs=[result];response=analyze(client,cid)
    assert response.status_code==200 and response.json()['data']['warnings']


@pytest.mark.parametrize('error,code',[
    (httpx.Response(401,json={}), 'AI_AUTH_ERROR'),
    (httpx.Response(429,json={'error':{'code':'insufficient_quota'}}),'AI_CREDIT_REQUIRED'),
])
def test_auth_credit_no_retry(system,error,code):
    client,remote,ai,_=system;cid=ready_pdf(system);ai.outputs=[error]
    response=analyze(client,cid)
    assert response.json()['error']['code']==code and len(ai.calls)==1
    assert remote.analyses[cid]['status']=='failed'


@pytest.mark.parametrize('error',[httpx.ReadTimeout('secret'),httpx.Response(500,json={})])
def test_transient_retry_is_counted(system,error):
    client,remote,ai,_=system;cid=ready_pdf(system);ai.outputs=[error,copy.deepcopy(RESULT)]
    assert analyze(client,cid).status_code==200
    assert len(ai.calls)==2 and sum(log['attempted'] for log in remote.logs.values())==2
    assert [log['status'] for log in remote.logs.values()]==['failed','completed']


def test_timeout_twice_failed_no_fake_summary(system):
    client,remote,ai,_=system;cid=ready_pdf(system);ai.outputs=[httpx.ReadTimeout('secret')]*2
    response=analyze(client,cid)
    assert response.status_code==504 and remote.analyses[cid]['status']=='failed'
    assert remote.analyses[cid]['summary'] is None and len(ai.calls)==2


def test_common_usage_limit_includes_photos_and_comparisons(system):
    client,remote,ai,settings=system;cid=ready_pdf(system);settings.ai_daily_request_limit=2
    for kind in ['photo_analysis','photo_comparison']:remote.logs[str(uuid4())]={'attempted':True,'status':'completed','task_type':kind}
    response=analyze(client,cid)
    assert response.status_code==429 and remote.analyses[cid]['error_code']=='AI_DAILY_LIMIT'
    assert remote.analyses[cid]['status']=='failed' and not ai.calls


def test_same_contract_concurrent_request_is_rejected(system):
    client,remote,ai,_=system;cid=ready_pdf(system);ai.wait=True
    with ThreadPoolExecutor(max_workers=2) as pool:
        first=pool.submit(analyze,client,cid);assert ai.entered.wait(3)
        try:assert analyze(client,cid).status_code==409 and len(ai.calls)==1
        finally:ai.release.set()
        assert first.result(timeout=3).status_code==200


def test_prepare_failure_has_no_call_or_quota_reservation(system):
    client,remote,ai,_=system;cid=ready_pdf(system);remote.fetch_fail=True
    response=analyze(client,cid)
    assert response.status_code==502 and remote.analyses[cid]['status']=='failed'
    assert not ai.calls and not any(log['attempted'] for log in remote.logs.values())


def test_missing_rpc_no_call(system):
    client,remote,ai,_=system;cid=ready_pdf(system);remote.missing_sql=True
    assert analyze(client,cid).json()['error']['code']=='AI_SETUP_REQUIRED' and not ai.calls


def test_stale_recovery_and_save_error_are_bounded(system,caplog):
    client,remote,ai,_=system;cid=ready_pdf(system)
    remote.analyses[cid]={'contract_id':cid,'status':'analyzing','stale':True}
    assert analyze(client,cid).status_code==200
    remote.analyses[cid]['status']='failed';remote.save_fail=True
    assert analyze(client,cid).status_code==503 and len(ai.calls)==2
    assert 'CONTRACT_AI_STATE_SAVE_FAILED' in caplog.text
    assert 'unit-openai-secret' not in caplog.text and TEXT_PAGES[1][1] not in caplog.text


def test_total_deadline_failed(system,monkeypatch):
    client,remote,ai,_=system;cid=ready_pdf(system);ai.wait=True
    monkeypatch.setattr('app.contract_analysis.TOTAL_TIMEOUT',.1)
    response=analyze(client,cid)
    assert response.status_code==504 and remote.analyses[cid]['status']=='failed'


@pytest.mark.parametrize('source,quote,accepted',[
    ('청소비 150,000원을 부담한다.','청소비 150,000원을 부담한다.',True),
    ('청소비 150,000원을\n부담한다.','청소비150,000원을 부담한다.',True),
    ('청소비 １５０，０００원을 부담한다.','청소비 150,000원을 부담한다.',True),
    ('청소비 150,000원을 부담한다.','청소비 15만 원을 부담한다.',False),
    ('청소비 150,000원을 부담한다.','청소비 150,001원을 부담한다.',False),
    ('청소비를 부담하지 않는다.','청소비를 부담한다.',False),
    ('기간 2026-01-01~2027-12-31','기간 2026-01-01~2028-12-31',False),
    ('청소비\u200b 150,000원을 부담한다.','청소비 150,000원을 부담한다.',True),
    ('한글 청소비 부담',__import__('unicodedata').normalize('NFD','한글 청소비 부담'),True),
])
def test_conservative_quote_normalization(source,quote,accepted):
    from app.contract_analysis import validate_evidence,AIError
    from app.schemas import ContractAnalysisResult
    data=copy.deepcopy(RESULT);data['findings']=data['findings'][:1]
    data['findings'][0].update(page_number=1,clause_excerpt=quote)
    result=ContractAnalysisResult.model_validate(data)
    if accepted:
        assert len(validate_evidence(result,{'page_count':1,'texts':[source]}).findings)==1
    else:
        with pytest.raises(AIError):validate_evidence(result,{'page_count':1,'texts':[source]})


def test_partial_rejection_keeps_only_verified_findings_and_persists_warning(system,caplog):
    client,remote,ai,_=system;cid=ready_pdf(system)
    result=copy.deepcopy(RESULT);result['findings'][1]['clause_excerpt']='Invented private SECRET CLAUSE'
    ai.outputs=[result];response=analyze(client,cid)
    assert response.status_code==200,response.text
    saved=response.json()['data'];assert len(saved['findings'])==1
    assert any('2번 항목(2페이지): 원문 인용 불일치' in w for w in saved['warnings'])
    assert 'reason=quote_mismatch' in caplog.text and 'SECRET CLAUSE' not in caplog.text
    again=client.get(f'/api/contracts/{cid}',headers=auth()).json()['data']['analysis']
    assert again['findings']==saved['findings'] and again['warnings']==saved['warnings']
    assert analyze(client,cid).status_code==200 and len(ai.calls)==1


def test_unextractable_and_wrong_page_quotes_are_excluded_not_presented_as_verified():
    from app.contract_analysis import validate_evidence,AIError
    from app.schemas import ContractAnalysisResult
    result=ContractAnalysisResult.model_validate(RESULT)
    with pytest.raises(AIError) as exc:validate_evidence(result,{'page_count':2,'texts':[None,None]})
    assert exc.value.detail.code=='AI_EVIDENCE_UNAVAILABLE'
    data=copy.deepcopy(RESULT);data['findings'][1]['page_number']=1
    checked=validate_evidence(ContractAnalysisResult.model_validate(data),{'page_count':2,'texts':['unrelated header', '\n'.join(TEXT_PAGES[1])]})
    assert len(checked.findings)==1
    assert any('근거 페이지 불일치' in w for w in checked.warnings)


def test_pdf_extraction_failure_does_not_log_or_invent_text(monkeypatch):
    from app.contract_analysis import prepare_pdf
    from pypdf._page import PageObject
    monkeypatch.setattr(PageObject,'extract_text',lambda self: (_ for _ in ()).throw(ValueError('private PDF content')))
    document=prepare_pdf(io.BytesIO(synthetic_contract_pdf()),2)
    assert document['texts']==[None,None] and document['page_count']==2
    assert document['content'][0]['file_data'].startswith('data:application/pdf;base64,')
