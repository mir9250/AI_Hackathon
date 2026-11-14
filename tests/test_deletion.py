"""Exact-path Storage deletion with real local HTTP routing, offline transports only."""
import copy
import json
from pathlib import Path
from uuid import uuid4
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest
from fastapi.testclient import TestClient
from app.api import create_app
from app.config import Settings
from test_contract_analysis import ContractAnalysisRemote
from test_photos import image_bytes,HOUSE_A
from test_contracts import create,upload_pdf,upload_page,complete
from test_api import auth,USER_A,USER_B,NOW


class DeleteRemote(ContractAnalysisRemote):
    def __init__(self):
        super().__init__();self.delete_fail=False;self.finish_fail=False;self.partial=False;self.info_fail=False
        self.busy=False;self.rpc_error=None;self.info_response=None;self.delete_response=None;self.photo_results={};self.comparison_results={}
    def __call__(self,r):
        path=r.url.path
        if path=='/rest/v1/photos':
            self.calls.append(r)
            if r.method=='GET':
                rows=[dict(p) for p in self.photos]
                for key in ['house_id','stage','photo_id','upload_id','paired_entry_photo_id']:
                    if key in r.url.params:rows=[p for p in rows if p.get(key)==r.url.params[key].removeprefix('eq.')]
                for p in rows:
                    p['analyses']=self.photo_results.get(p['photo_id']);p['comparisons']=self.comparison_results.get(p['photo_id'])
                return httpx.Response(200,json=rows)
            if r.method=='POST':
                row={**json.loads(r.content),'created_at':NOW};self.photos.append(row)
                return httpx.Response(201,json=[row])
        if path.startswith('/rest/v1/rpc/') and path.endswith(('begin_resource_deletion','finish_resource_deletion')):
            self.calls.append(r);assert r.headers['apikey']=='sb_secret_unit_test'
            data=json.loads(r.content);kind=data['p_kind'];rid=data['p_id'];user=data['p_user_id']
            if self.rpc_error:return httpx.Response(400,json={'code':self.rpc_error})
            target=next((p for p in self.photos if p['photo_id']==rid),None) if kind=='photo' else self.contracts.get(rid)
            if not target:return httpx.Response(200,json={'action':'gone' if path.endswith('begin_resource_deletion') else 'deleted'})
            if target['house_id']!=self.records['houses'][user]['house_id']:return httpx.Response(200,json={'action':'forbidden'})
            if path.endswith('begin_resource_deletion'):
                if self.busy:return httpx.Response(200,json={'action':'busy'})
                if kind=='photo':
                    rows=[target]+([p for p in self.photos if p.get('paired_entry_photo_id')==rid] if target['stage']=='entry' else [])
                    paired=rows[1]['photo_id'] if len(rows)>1 else None
                    if target['stage']=='entry' and not target.get('deleting') and paired!=data.get('p_expected_exit'):
                        return httpx.Response(200,json={'action':'confirmation_changed'})
                    for p in rows:p['deleting']=True
                    manifest={'photos':copy.deepcopy(rows)}
                else:
                    target['upload_status']='deleting';manifest={'contract':copy.deepcopy(target),'pages':copy.deepcopy([p for p in self.pages.values() if p['contract_id']==rid])}
                return httpx.Response(200,json={'action':'prepared','house_id':target['house_id'],**manifest})
            if self.finish_fail:return httpx.Response(500,json={})
            if kind=='photo':
                ids={rid}|{p['photo_id'] for p in self.photos if p.get('paired_entry_photo_id')==rid}
                self.photos[:]=[p for p in self.photos if p['photo_id'] not in ids]
                for i in ids:self.photo_results.pop(i,None);self.comparison_results.pop(i,None)
            else:
                self.contracts.pop(rid);self.pages={k:p for k,p in self.pages.items() if p['contract_id']!=rid};self.analyses.pop(rid,None)
            return httpx.Response(200,json={'action':'deleted'})
        if path.startswith('/storage/v1/object/info/'):
            self.calls.append(r);key=path.split('/deposit-private/',1)[1]
            if self.info_response is not None:return self.info_response
            status=500 if self.info_fail else 200 if key in self.objects else 404
            return httpx.Response(status,json={'code':'NoSuchKey'} if status==404 else {})
        if r.method=='DELETE' and path=='/storage/v1/object/deposit-private':
            self.calls.append(r);assert r.headers['apikey']=='sb_secret_unit_test';assert 'authorization' not in r.headers
            if self.delete_fail:return httpx.Response(500,json={'message':'private upstream error'})
            paths=json.loads(r.content)['prefixes']
            for key in paths[:1] if self.partial else paths:self.objects.pop(key,None)
            return httpx.Response(200,json=self.delete_response if self.delete_response is not None else [])
        return super().__call__(r)


@pytest.fixture
def system():
    remote=DeleteRemote()
    async def no_ai(r):pytest.fail('Deletion must never call paid AI')
    settings=Settings(_env_file=None,supabase_url='https://local-test.supabase.co',supabase_publishable_key='sb_publishable_unit_test',supabase_secret_key='sb_secret_unit_test')
    with TestClient(create_app(settings,httpx.MockTransport(remote),httpx.MockTransport(no_ai))) as client:yield client,remote


def photo(client,entry=None,heic=False):
    url='/api/move-out/photos' if entry else '/api/move-in/photos'
    data={'upload_id':str(uuid4()),**({'paired_entry_photo_id':entry} if entry else {'location':'거실'})}
    fmt='HEIF' if heic else 'PNG';name='photo.heic' if heic else 'photo.png';mime='image/heic' if heic else 'image/png'
    response=client.post(url,headers=auth(),files={'file':(name,image_bytes(fmt),mime)},data=data)
    assert response.status_code==200,response.text
    return response.json()['data']['photo_id']


def remove(client,rid,kind='photos',pair=None,headers=None):
    return client.delete(f'/api/{kind}/{rid}'+(f'?paired_exit_photo_id={pair}' if pair else ''),headers=auth() if headers is None else headers)


@pytest.mark.parametrize('linked',[False,True])
def test_entry_deletion_exact_files_results_preserves_other_resources(system,linked):
    client,r=system;eid=photo(client,heic=True);xid=photo(client,eid,True) if linked else None
    unrelated=photo(client);cid=create(client).json()['data']['contract_id']
    r.logs['retained']={'attempted_at':'2026-11-14','resource_id':eid}
    r.photo_results[eid]={}
    paths={p[k] for p in r.photos if p['photo_id'] in {eid,xid} for k in ['original_path','preview_path'] if p.get(k)}
    response=remove(client,eid,pair=xid);assert response.status_code==200,response.text
    assert not (paths & r.objects.keys());assert [p['photo_id'] for p in r.photos]==[unrelated]
    assert cid in r.contracts and 'retained' in r.logs and eid not in r.photo_results
    listed=client.get('/api/move-in/photos',headers=auth()).json()['data'];assert [p['photo_id'] for p in listed]==[unrelated]
    assert remove(client,eid,pair=xid).json()['data']['already_deleted']
    calls=[c for c in r.calls if c.method=='DELETE'];assert set(json.loads(calls[-1].content)['prefixes'])==paths


def test_exit_only_preserves_entry_and_can_pair_again(system):
    client,r=system;eid=photo(client);xid=photo(client,eid)
    assert remove(client,xid).status_code==200
    assert [p['photo_id'] for p in r.photos]==[eid]
    assert photo(client,eid)!=xid


@pytest.mark.parametrize('kind,ready',[('pdf',False),('pdf',True),('images',False),('images',True)])
def test_contract_files_pages_analysis_cascade_and_other_data_preserved(system,kind,ready):
    client,r=system;cid=create(client,kind).json()['data']['contract_id']
    if kind=='pdf':assert upload_pdf(client,cid,Path('tests/fixtures/dummy_rental_contract.pdf').read_bytes()).status_code==200
    else:
        assert upload_page(client,cid,1,image_bytes('HEIF'),'page.heic','image/heic').status_code==200
        assert upload_page(client,cid,2).status_code==200
    if ready:assert complete(client,cid).status_code==200
    other=create(client).json()['data']['contract_id'];eid=photo(client)
    r.analyses[cid]={'contract_id':cid,'status':'failed'}
    files={k for k in r.objects if f'/contracts/{cid}/' in k}
    response=remove(client,cid,'contracts');assert response.status_code==200,response.text
    assert not(files & r.objects.keys());assert not any(p['contract_id']==cid for p in r.pages.values()) and cid not in r.analyses
    assert other in r.contracts and any(p['photo_id']==eid for p in r.photos)
    assert client.get(f'/api/contracts/{cid}',headers=auth()).status_code==404


def test_empty_draft_can_delete(system):
    client,r=system;cid=create(client).json()['data']['contract_id']
    assert remove(client,cid,'contracts').status_code==200
    assert not any(c.method=='DELETE' and c.url.path.startswith('/storage/') for c in r.calls)


@pytest.mark.parametrize('failure,code',[('delete_fail','DELETE_STORAGE_FAILED'),('partial','DELETE_STORAGE_UNCONFIRMED'),('finish_fail','DELETE_DATABASE_FAILED'),('info_fail','DELETE_STORAGE_UNCONFIRMED')])
def test_partial_storage_or_db_failure_retains_manifest_restart_retry(system,failure,code,caplog):
    client,r=system;eid=photo(client,heic=True);setattr(r,failure,True)
    response=remove(client,eid);assert response.status_code==503,response.text
    assert response.json()['error']['code']==code and r.photos[0]['deleting']
    assert client.get('/api/move-in/photos',headers=auth()).json()['data'][0]['deleting']
    assert 'private upstream error' not in caplog.text
    if failure=='delete_fail':assert not any(c.url.path.endswith('/finish_resource_deletion') for c in r.calls)
    setattr(r,failure,False)
    # A new ASGI lifespan recreates all process state; only remote DB manifest persists.
    async def no_ai(request):pytest.fail('AI called')
    settings=client.app.app.state.gateway.settings if hasattr(client.app,'app') else None
    with TestClient(create_app(settings,httpx.MockTransport(r),httpx.MockTransport(no_ai))) as restarted:
        assert remove(restarted,eid).status_code==200
    assert not r.photos


def test_auth_owner_unknown_and_changed_confirmation(system):
    client,r=system;eid=photo(client);xid=photo(client,eid)
    assert remove(client,eid,headers={}).status_code==401
    assert remove(client,eid,headers=auth(USER_B)).status_code==404
    assert remove(client,eid).status_code==409
    assert remove(client,str(uuid4())).json()['data']['already_deleted']
    assert len(r.photos)==2 and not any(p.get('deleting') for p in r.photos)


def test_busy_no_storage_mutation_and_sql_setup_failure(system):
    client,r=system;eid=photo(client);r.busy=True
    assert remove(client,eid).status_code==409
    assert not any(c.method=='DELETE' for c in r.calls)
    r.busy=False;r.rpc_error='PGRST202'
    assert remove(client,eid).json()['error']['code']=='DELETE_SETUP_REQUIRED'


def test_corrupt_cross_owner_path_is_never_sent_to_storage(system):
    client,r=system;eid=photo(client);r.photos[0]['original_path']=f'{USER_B}/{HOUSE_A}/{uuid4()}/original.png'
    response=remove(client,eid);assert response.status_code==502,response.text
    assert not any(c.method=='DELETE' for c in r.calls)


def test_duplicate_concurrent_requests_are_safe(system):
    client,r=system;eid=photo(client)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results=list(pool.map(lambda _:remove(client,eid),range(2)))
    assert all(response.status_code==200 for response in results) and not r.photos


def test_preview_path_outside_original_attempt_is_rejected(system):
    client,r=system;eid=photo(client,heic=True)
    r.photos[0]['preview_path']=f'{USER_A}/{HOUSE_A}/{uuid4()}/preview.jpg'
    assert remove(client,eid).json()['error']['code']=='DELETE_PATH_INVALID'
    assert not any(c.method=='DELETE' for c in r.calls)


def test_contract_partial_failure_detail_remains_deletable_without_signing_removed_files(system):
    client,r=system;cid=create(client,'images').json()['data']['contract_id']
    assert upload_page(client,cid,1).status_code==200
    r.finish_fail=True;assert remove(client,cid,'contracts').status_code==503
    before=len(r.calls)
    response=client.get(f'/api/contracts/{cid}',headers=auth())
    assert response.status_code==200,response.text
    data=response.json()['data'];assert data['upload_status']=='deleting' and data['signed_url'] is None and data['pages']==[]
    assert not any('/object/sign/' in c.url.path for c in r.calls[before:])
    r.finish_fail=False;assert remove(client,cid,'contracts').status_code==200


@pytest.mark.parametrize('status,body,success',[
    (400,{'code':'NoSuchKey'},True),(404,{'code':'NoSuchKey'},True),
    (404,{},False),(404,{'code':'NoSuchBucket'},False),
    (400,{'statusCode':'404','code':'NoSuchBucket'},False),
    (403,{'code':'NoSuchKey'},False),
])
def test_only_explicit_missing_object_confirms_storage_absence(system,status,body,success):
    client,r=system;eid=photo(client);r.info_response=httpx.Response(status,json=body)
    response=remove(client,eid)
    assert response.status_code==(200 if success else 503)
    assert bool(r.photos) is not success


@pytest.mark.parametrize('exit_stage,heic',[(False,False),(False,True),(True,False),(True,True)])
def test_real_photo_upload_paths_bind_row_id_and_preview(system,exit_stage,heic):
    client,r=system;entry=photo(client);rid=photo(client,entry,heic) if exit_stage else entry
    if not exit_stage and heic:rid=photo(client,heic=True)
    row=next(p for p in r.photos if p['photo_id']==rid)
    extension='heic' if heic else 'png'
    assert row['original_path']==f'{USER_A}/{HOUSE_A}/{rid}/original.{extension}'
    if heic:assert row['preview_path']==f'{USER_A}/{HOUSE_A}/{rid}/preview.jpg'
    else:assert row.get('preview_path') is None
    expected={row['original_path']}|({row['preview_path']} if row.get('preview_path') else set())
    assert remove(client,rid).status_code==200
    keys=json.loads([c for c in r.calls if c.method=='DELETE'][-1].content)['prefixes']
    assert set(keys)==expected


@pytest.mark.parametrize('mode',['pdf','png','heic'])
def test_real_contract_upload_paths_six_parts_digest_and_page_id(system,mode):
    import hashlib
    from uuid import UUID
    client,r=system;cid=create(client,'pdf' if mode=='pdf' else 'images').json()['data']['contract_id']
    if mode=='pdf':
        payload=Path('tests/fixtures/dummy_rental_contract.pdf').read_bytes()
        assert upload_pdf(client,cid,payload).status_code==200
        path=r.contracts[cid]['original_path'];slot='pdf'
    else:
        payload=image_bytes('HEIF' if mode=='heic' else 'PNG')
        assert upload_page(client,cid,1,payload,'page.heic' if mode=='heic' else 'page.png','image/heic' if mode=='heic' else 'image/png').status_code==200
        page=next(p for p in r.pages.values() if p['contract_id']==cid)
        path=page['original_path'];slot='page-1'
    parts=path.removeprefix(f'{USER_A}/{HOUSE_A}/').split('/')
    assert len(parts)==6 and parts[:3]==['contracts',cid,slot]
    assert parts[3]==hashlib.sha256(payload).hexdigest()
    assert str(UUID(parts[4]))==parts[4]
    if mode!='pdf':assert parts[4]==page['page_id']
    expected={path}|({path.rsplit('/',1)[0]+'/preview.jpg'} if mode=='heic' else set())
    assert remove(client,cid,'contracts').status_code==200
    keys=json.loads([c for c in r.calls if c.method=='DELETE'][-1].content)['prefixes']
    assert set(keys)==expected


@pytest.mark.parametrize('linked',[False,True])
def test_different_valid_uuid_in_photo_path_is_rejected(system,linked):
    client,r=system;entry=photo(client);rid=photo(client,entry) if linked else entry
    row=next(p for p in r.photos if p['photo_id']==rid)
    original=row['original_path'];row['original_path']=original.replace(rid,str(uuid4()))
    response=remove(client,entry,pair=rid if linked else None)
    assert response.json()['error']['code']=='DELETE_PATH_INVALID'
    assert not any(c.method=='DELETE' for c in r.calls)
    # The DB manifest remains deleting. Correcting the path check/data permits retry.
    row['original_path']=original
    assert remove(client,entry,pair=rid if linked else None).status_code==200


@pytest.mark.parametrize('change',['slot','digest','page_id'])
def test_contract_paths_must_match_actual_page_and_digest_structure(system,change):
    client,r=system;cid=create(client,'images').json()['data']['contract_id']
    assert upload_page(client,cid,1).status_code==200
    page=next(p for p in r.pages.values() if p['contract_id']==cid)
    original=page['original_path'];parts=original.split('/')
    if change=='slot':parts[4]='page-2'
    elif change=='digest':parts[5]='not-a-sha256'
    else:parts[6]=str(uuid4())
    page['original_path']='/'.join(parts)
    assert remove(client,cid,'contracts').json()['error']['code']=='DELETE_PATH_INVALID'
    assert not any(c.method=='DELETE' for c in r.calls)
    page['original_path']=original
    assert remove(client,cid,'contracts').status_code==200


def test_fixing_validator_allows_retry_without_resetting_deleting_state(system,monkeypatch):
    from app.deletion import DeletionService
    from app.errors import ApiError
    client,r=system;rid=photo(client)
    original=DeletionService.paths
    def rejected(*args):raise ApiError(502,'DELETE_PATH_INVALID','test rejection')
    monkeypatch.setattr(DeletionService,'paths',staticmethod(rejected))
    assert remove(client,rid).status_code==502 and r.photos[0]['deleting']
    assert not any(c.method=='DELETE' for c in r.calls)
    monkeypatch.setattr(DeletionService,'paths',staticmethod(original))
    assert remove(client,rid).status_code==200 and not r.photos


@pytest.mark.parametrize('http_status',[400,404])
def test_storage_official_delete_array_and_missing_error_envelope(system,http_status):
    client,r=system;rid=photo(client);key=r.photos[0]['original_path']
    r.delete_response=[{'id':str(uuid4()),'name':key,'bucket_id':'deposit-private','metadata':{}}]
    r.info_response=httpx.Response(http_status,json={'statusCode':'404','code':'NoSuchKey','error':'NoSuchKey','message':'Object not found'})
    assert remove(client,rid).status_code==200
    assert not r.photos and key not in r.objects
