"""Real multipart/PDF/image validation; all Supabase requests use an offline transport."""
import io
import json
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import httpx
import jwt
import pytest
from fastapi.testclient import TestClient
from pypdf import PdfWriter

from app.api import create_app
from app.config import Settings
from test_api import USER_A, USER_B, SECRET, NOW, auth
from test_photos import PhotoRemote, HOUSE_A, HOUSE_B, image_bytes


def pdf_bytes(pages=2, encrypted=False):
    target=io.BytesIO()
    with PdfWriter() as writer:
        writer.add_metadata({'/Title':'SYNTHETIC DEMO CONTRACT'})
        for _ in range(pages): writer.add_blank_page(width=595,height=842)
        if encrypted: writer.encrypt('test-only-password')
        writer.write(target)
    return target.getvalue()


class ContractRemote(PhotoRemote):
    def __init__(self):
        super().__init__()
        for house in self.records['houses'].values(): house.update(created_at=NOW,updated_at=NOW)
        self.contracts={}; self.pages={}
        self.read_fail=False; self.read_fail_after_write=False
        self.ready_during_upload=False; self.pdf_race=False

    @staticmethod
    def matches(row,params):
        for key in ['house_id','contract_id','upload_id','upload_status','source_type','original_path']:
            if key in params:
                value=params[key]
                if value=='is.null':
                    if row.get(key) is not None:return False
                elif row.get(key)!=value.removeprefix('eq.'):return False
        return True

    def __call__(self,request):
        path=request.url.path
        if path=='/rest/v1/contracts':
            self.calls.append(request)
            if request.method=='GET':
                assert request.headers['apikey']=='sb_publishable_unit_test'
                user=jwt.decode(request.headers['authorization'].split()[1],SECRET,algorithms=['HS256'],audience='authenticated')['sub']
                assert request.url.params['house_id']==f'eq.{self.records["houses"][user]["house_id"]}'
                if self.read_fail:return httpx.Response(500,json={})
                rows=[]
                for row in self.contracts.values():
                    if self.matches(row,request.url.params):
                        rows.append({**row,'contract_pages':[dict(p) for p in self.pages.values() if p['contract_id']==row['contract_id']], 'contract_analyses':None})
                return httpx.Response(200,json=sorted(rows,key=lambda r:(r['created_at'],r['contract_id']),reverse=True))
            assert request.headers['apikey']=='sb_secret_unit_test'
            assert 'authorization' not in request.headers
            values=json.loads(request.content)
            if self.db_fail:return httpx.Response(500,json={})
            if request.method=='POST':
                assert values['house_id'] in {HOUSE_A,HOUSE_B} and values['upload_status']=='draft'
                if any(row['house_id']==values['house_id'] and row['upload_id']==values['upload_id'] for row in self.contracts.values()):
                    return httpx.Response(409,json={})
                row={**values,'original_path':None,'page_count':None,'created_at':NOW}
                self.contracts[row['contract_id']]=row
            else:
                assert request.method=='PATCH'
                if self.pdf_race and 'original_path' in values:
                    cid=request.url.params['contract_id'].removeprefix('eq.')
                    row=self.contracts[cid]
                    row.update(original_path=f'{USER_A}/{HOUSE_A}/contracts/{cid}/pdf/otherhash/winner/original.pdf',page_count=1)
                    self.objects[row['original_path']]=b'winner'
                rows=[row for row in self.contracts.values() if self.matches(row,request.url.params)]
                if not rows:return httpx.Response(200,json=[])
                row=rows[0]
                if values.get('upload_status')=='ready':
                    if row['source_type']=='images':
                        numbers=sorted(p['page_number'] for p in self.pages.values() if p['contract_id']==row['contract_id'])
                        if not numbers or numbers!=list(range(1,values['page_count']+1)):
                            return httpx.Response(400,json={'code':'23514'})
                    elif not row['original_path']:return httpx.Response(400,json={'code':'23514'})
                row.update(values)
            if self.read_fail_after_write:self.read_fail=True
            if self.commit_timeout:raise httpx.ReadTimeout('private DB details',request=request)
            return httpx.Response(201 if request.method=='POST' else 200,json=[row])
        if path=='/rest/v1/contract_pages':
            self.calls.append(request)
            assert request.method=='POST' and request.headers['apikey']=='sb_secret_unit_test'
            assert 'authorization' not in request.headers
            row=json.loads(request.content); parent=self.contracts[row['contract_id']]
            if self.ready_during_upload:parent.update(upload_status='ready',page_count=1)
            if parent['upload_status']!='draft' or parent['source_type']!='images':return httpx.Response(400,json={'code':'23514'})
            if self.db_fail:return httpx.Response(500,json={})
            if any(p['contract_id']==row['contract_id'] and p['page_number']==row['page_number'] for p in self.pages.values()):
                return httpx.Response(409,json={})
            self.pages[row['page_id']]=row
            if self.read_fail_after_write:self.read_fail=True
            if self.commit_timeout:raise httpx.ReadTimeout('private DB details',request=request)
            return httpx.Response(201,json=[row])
        return super().__call__(request)


@pytest.fixture
def contract_system():
    remote=ContractRemote()
    settings=Settings(_env_file=None,supabase_url='https://local-test.supabase.co',
        supabase_publishable_key='sb_publishable_unit_test',supabase_secret_key='sb_secret_unit_test')
    def no_ai(request):raise AssertionError('Contract upload must not call OpenAI')
    with TestClient(create_app(settings,httpx.MockTransport(remote),httpx.MockTransport(no_ai))) as client:
        yield client,remote


def create(client,source='pdf',upload_id=None,user=USER_A):
    return client.post('/api/contracts',headers=auth(user),json={'source_type':source,'upload_id':upload_id or str(uuid4())})


def upload_pdf(client,cid,payload=None,name='demo.pdf',mime='application/pdf',user=USER_A):
    return client.post(f'/api/contracts/{cid}/pdf',headers=auth(user),files={'file':(name,pdf_bytes() if payload is None else payload,mime)})


def upload_page(client,cid,number=1,payload=None,name='page.png',mime='image/png',user=USER_A):
    return client.post(f'/api/contracts/{cid}/pages',headers=auth(user),data={'page_number':str(number)},
        files={'file':(name,image_bytes() if payload is None else payload,mime)})


def complete(client,cid,confirmed=True,user=USER_A):
    return client.post(f'/api/contracts/{cid}/complete',headers=auth(user),json={'all_pages_confirmed':confirmed})


def test_pdf_draft_upload_detail_original_preservation_and_confirmed_completion(contract_system):
    client,remote=contract_system
    made=create(client);assert made.status_code==200,made.text
    cid=made.json()['data']['contract_id'];source=pdf_bytes()
    assert made.json()['data']['upload_status']=='draft'
    result=upload_pdf(client,cid,source);assert result.status_code==200,result.text
    assert remote.contracts[cid]['upload_status']=='draft'
    assert remote.objects[remote.contracts[cid]['original_path']]==source
    detail=client.get(f'/api/contracts/{cid}',headers=auth()).json()['data']
    assert detail['page_count']==2 and '/object/sign/' in detail['signed_url']
    assert detail['pages']==[] and detail['analysis'] is None and detail['analysis_status']=='not_analyzed'
    assert complete(client,cid,False).status_code==422
    assert complete(client,cid).json()['data']['upload_status']=='ready'
    assert complete(client,cid).status_code==200
    assert upload_pdf(client,cid).status_code==409


def test_create_idempotency_multiple_contracts_source_conflict_and_user_separation(contract_system):
    client,remote=contract_system
    uid=str(uuid4());first=create(client,upload_id=uid).json()['data']
    again=create(client,upload_id=uid).json()['data']
    assert first['contract_id']==again['contract_id'] and len(remote.contracts)==1
    assert create(client,'images',uid).status_code==409
    create(client,'images')
    assert len(client.get('/api/contracts',headers=auth()).json()['data'])==2
    assert client.get('/api/contracts',headers=auth(USER_B)).json()=={'data':[]}
    assert client.get(f'/api/contracts/{first["contract_id"]}',headers=auth(USER_B)).status_code==404


@pytest.mark.parametrize('kwargs,code',[
    ({'name':'demo.txt'},'INVALID_PDF_TYPE'),({'mime':'text/plain'},'INVALID_PDF_TYPE'),
    ({'payload':image_bytes()},'INVALID_PDF'),({'payload':pdf_bytes()[:70]},'INVALID_PDF'),
    ({'payload':pdf_bytes(encrypted=True)},'PDF_ENCRYPTED'),({'payload':pdf_bytes(21)},'PDF_PAGE_LIMIT'),
    ({'payload':pdf_bytes(0)},'PDF_PAGE_LIMIT'),({'payload':b''},'EMPTY_FILE'),
    ({'payload':b'%PDF-'+b'x'*(20*1024*1024)},'FILE_SIZE_LIMIT'),
])
def test_invalid_pdf_never_reaches_storage(contract_system,kwargs,code):
    client,remote=contract_system;cid=create(client).json()['data']['contract_id']
    result=upload_pdf(client,cid,**kwargs)
    assert result.status_code==422,result.text
    assert result.json()['error']['code']==code
    assert not remote.objects and remote.contracts[cid]['original_path'] is None


def test_pdf_twenty_pages_allowed_and_duplicate_content_does_not_write_again(contract_system):
    client,remote=contract_system;cid=create(client).json()['data']['contract_id'];payload=pdf_bytes(20)
    assert upload_pdf(client,cid,payload).status_code==200
    before=len(remote.calls)
    assert upload_pdf(client,cid,payload).json()['data']['already_uploaded'] is True
    assert not any('/storage/' in str(r.url) for r in remote.calls[before:])
    assert upload_pdf(client,cid,pdf_bytes(1)).status_code==409
    assert len(remote.objects)==1


def test_image_contract_partial_pages_order_missing_page_and_completion(contract_system):
    client,remote=contract_system;cid=create(client,'images').json()['data']['contract_id']
    assert upload_page(client,cid,3).status_code==200
    assert upload_page(client,cid,1).status_code==200
    assert complete(client,cid).status_code==409
    remote.storage_fail=True
    assert upload_page(client,cid,2).status_code==502
    assert len(remote.pages)==2
    remote.storage_fail=False
    assert upload_page(client,cid,2).status_code==200
    detail=client.get(f'/api/contracts/{cid}',headers=auth()).json()['data']
    assert [p['page_number'] for p in detail['pages']]==[1,2,3]
    assert detail['upload_status']=='draft' and detail['uploaded_page_count']==3
    assert complete(client,cid).json()['data']['page_count']==3
    assert remote.contracts[cid]['upload_status']=='ready'
    assert upload_page(client,cid,4).status_code==409
    assert upload_page(client,cid,1).status_code==409


def test_image_page_duplicates_hash_and_heic_preview(contract_system):
    client,remote=contract_system;cid=create(client,'images').json()['data']['contract_id']
    source=image_bytes('HEIF')
    assert upload_page(client,cid,1,source,'page.heic','image/heic').status_code==200
    before=len(remote.calls)
    assert upload_page(client,cid,1,source,'page.heic','image/heic').json()['data']['already_uploaded']
    assert not any('/storage/' in str(r.url) for r in remote.calls[before:])
    assert upload_page(client,cid,1,image_bytes()).status_code==409
    detail=client.get(f'/api/contracts/{cid}',headers=auth()).json()['data']
    assert '/preview.jpg?' in detail['pages'][0]['signed_url']
    assert '/original.heic?' in detail['pages'][0]['original_signed_url']
    assert len(remote.objects)==2 and list(remote.pages.values())[0]['size_bytes']==len(source)


@pytest.mark.parametrize('number',[0,11,'wrong'])
def test_invalid_page_number(contract_system,number):
    client,remote=contract_system;cid=create(client,'images').json()['data']['contract_id']
    assert upload_page(client,cid,number).status_code==422
    assert not remote.objects


def test_ten_image_pages_allowed_but_no_eleventh(contract_system):
    client,remote=contract_system;cid=create(client,'images').json()['data']['contract_id']
    for number in range(1,11):assert upload_page(client,cid,number).status_code==200
    assert upload_page(client,cid,11).status_code==422
    assert complete(client,cid).json()['data']['page_count']==10


def test_empty_and_wrong_source_contract_cannot_complete_or_upload(contract_system):
    client,remote=contract_system;pdf=create(client).json()['data']['contract_id'];images=create(client,'images').json()['data']['contract_id']
    assert complete(client,pdf).status_code==409 and complete(client,images).status_code==409
    assert upload_page(client,pdf).status_code==409 and upload_pdf(client,images).status_code==409
    assert not remote.objects


@pytest.mark.parametrize('source',['pdf','images'])
@pytest.mark.parametrize('failure',['storage_fail','db_fail'])
def test_failed_file_save_cleans_objects_and_keeps_draft(contract_system,source,failure):
    client,remote=contract_system;cid=create(client,source).json()['data']['contract_id']
    setattr(remote,failure,True)
    result=upload_pdf(client,cid) if source=='pdf' else upload_page(client,cid)
    assert result.status_code==502
    assert remote.contracts[cid]['upload_status']=='draft' and not remote.objects and not remote.pages
    assert any(r.method=='DELETE' for r in remote.calls)


def test_cleanup_failure_logged_without_document_or_secret(contract_system,caplog):
    client,remote=contract_system;cid=create(client).json()['data']['contract_id']
    remote.db_fail=True;remote.cleanup_fail=True
    assert upload_pdf(client,cid).status_code==502
    assert 'PHOTO_CLEANUP_FAILED attempt=' in caplog.text
    assert 'sb_secret_unit_test' not in caplog.text and 'SYNTHETIC DEMO CONTRACT' not in caplog.text


@pytest.mark.parametrize('source',['pdf','images'])
def test_committed_timeout_reconciles_without_deleting_success(contract_system,source):
    client,remote=contract_system;cid=create(client,source).json()['data']['contract_id']
    remote.commit_timeout=True
    result=upload_pdf(client,cid) if source=='pdf' else upload_page(client,cid)
    assert result.status_code==200,result.text
    assert len(remote.objects)==1
    assert complete(client,cid).status_code==200


def test_commit_confirmation_failure_preserves_file_for_same_file_retry(contract_system,caplog):
    client,remote=contract_system;cid=create(client).json()['data']['contract_id'];source=pdf_bytes()
    remote.read_fail_after_write=True
    result=upload_pdf(client,cid,source)
    assert result.status_code==503
    assert result.json()['error']['code']=='UPLOAD_CONFIRMATION_PENDING'
    assert len(remote.objects)==1 and 'CONTRACT_COMMIT_UNKNOWN' in caplog.text
    remote.read_fail=False;remote.read_fail_after_write=False
    assert upload_pdf(client,cid,source).json()['data']['already_uploaded']
    assert len(remote.objects)==1


def test_competing_pdf_does_not_delete_winner(contract_system):
    client,remote=contract_system;cid=create(client).json()['data']['contract_id'];remote.pdf_race=True
    assert upload_pdf(client,cid).status_code==409
    assert list(remote.objects.values())==[b'winner']


def test_page_insert_loses_to_completion_and_cleans_only_loser(contract_system):
    client,remote=contract_system;cid=create(client,'images').json()['data']['contract_id']
    assert upload_page(client,cid,1).status_code==200
    originals=dict(remote.objects);remote.ready_during_upload=True
    assert upload_page(client,cid,2).status_code==409
    assert remote.objects==originals and len(remote.pages)==1


def test_concurrent_same_pdf_upload_only_persists_one(contract_system):
    client,remote=contract_system;cid=create(client).json()['data']['contract_id'];source=pdf_bytes()
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses=list(pool.map(lambda _:upload_pdf(client,cid,source),range(2)))
    assert all(r.status_code==200 for r in responses)
    assert len(remote.objects)==1
    assert sum(r.json()['data']['already_uploaded'] for r in responses)==1


def test_other_user_cannot_upload_or_complete_known_contract_id(contract_system):
    client,remote=contract_system;cid=create(client,'images').json()['data']['contract_id']
    assert upload_page(client,cid,user=USER_B).status_code==404
    assert upload_pdf(client,cid,user=USER_B).status_code==404
    assert complete(client,cid,user=USER_B).status_code==404
    assert not remote.objects


def test_authentication_house_and_strict_client_fields(contract_system):
    client,remote=contract_system
    assert client.get('/api/contracts').status_code==401
    assert client.post('/api/contracts',json={'source_type':'pdf','upload_id':str(uuid4())}).status_code==401
    result=client.post('/api/contracts',headers=auth(),json={'source_type':'pdf','upload_id':str(uuid4()),'user_id':USER_B})
    assert result.status_code==422
    remote.records['houses'].pop(USER_A)
    assert create(client).status_code==409
    assert client.get('/api/contracts',headers=auth()).json()=={'data':[]}


def test_confirmation_is_strict_boolean_and_required(contract_system):
    client,remote=contract_system;cid=create(client).json()['data']['contract_id']
    assert upload_pdf(client,cid).status_code==200
    for body in [{},{'all_pages_confirmed':'true'},{'all_pages_confirmed':1}]:
        assert client.post(f'/api/contracts/{cid}/complete',headers=auth(),json=body).status_code==422
    assert remote.contracts[cid]['upload_status']=='draft'


@pytest.mark.parametrize('route',['pdf','pages'])
def test_contract_chunked_body_size_limit(contract_system,route):
    client,remote=contract_system;cid=create(client,'images' if route=='pages' else 'pdf').json()['data']['contract_id']
    request=client.build_request('POST',f'/api/contracts/{cid}/{route}',headers=auth(),data={'page_number':'1'},
        files={'file':('large.pdf',b'x'*(21*1024*1024),'application/pdf')})
    del request.headers['content-length']
    result=client.send(request)
    assert result.status_code==422
    assert not remote.objects


@pytest.mark.parametrize('kwargs',[
    {'name':'bad.gif','mime':'image/gif'},{'mime':'text/plain'},{'payload':b'not-image'},
    {'payload':b'x'*(20*1024*1024+1)},{'payload':image_bytes('JPEG')},
])
def test_contract_image_validation_is_reused_without_storage_writes(contract_system,kwargs):
    client,remote=contract_system;cid=create(client,'images').json()['data']['contract_id']
    assert upload_page(client,cid,**kwargs).status_code==422
    assert not remote.objects and not remote.pages


def test_unknown_create_commit_reuses_same_registration_id(contract_system):
    client,remote=contract_system;uid=str(uuid4());remote.commit_timeout=True
    result=create(client,upload_id=uid)
    assert result.status_code==200
    assert create(client,upload_id=uid).json()['data']['contract_id']==result.json()['data']['contract_id']
    assert len(remote.contracts)==1


def test_malformed_contract_path_is_not_signed(contract_system):
    client,remote=contract_system;cid=create(client).json()['data']['contract_id']
    remote.contracts[cid].update(original_path=f'{USER_B}/{HOUSE_B}/private.pdf',page_count=1)
    before=len(remote.calls)
    result=client.get(f'/api/contracts/{cid}',headers=auth())
    assert result.status_code==502 and result.json()['error']['code']=='INVALID_CONTRACT_PATH'
    assert not any('/object/sign/' in str(r.url) for r in remote.calls[before:])
