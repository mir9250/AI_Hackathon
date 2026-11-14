"""Offline move-out upload/list and two-image comparison API integration tests."""
import asyncio
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import httpx
import jwt
import pytest
from fastapi.testclient import TestClient

from app.api import create_app
from app.config import Settings
from test_api import USER_A, USER_B, SECRET, NOW, auth
from test_photos import PhotoRemote, HOUSE_A, HOUSE_B, image_bytes

ENTRY = str(uuid4())
OTHER_ENTRY = str(uuid4())
RESULT = {'overall_result':'change_suspected','changes':[{'type':'긁힘','status':'새 흔적 의심',
    'description':'입실 사진에는 보이지 않던 선 모양 흔적', 'recommendation':'같은 각도에서 추가 촬영하세요.'}]}


class MoveOutRemote(PhotoRemote):
    def __init__(self):
        super().__init__()
        self.logs = {}
        self.comparison = None
        self.missing_sql = False
        self.save_fail = False
        self.pair_race = False
        self.image_fail = False
        self.photos = [self.entry(ENTRY, HOUSE_A, USER_A), self.entry(OTHER_ENTRY, HOUSE_B, USER_B)]
        for row in self.photos: self.objects[row['original_path']] = image_bytes()

    @staticmethod
    def entry(photo_id, house, user):
        return {'photo_id':photo_id,'house_id':house,'stage':'entry','location':'거실',
                'original_path':f'{user}/{house}/{photo_id}/original.png','preview_path':None,
                'mime_type':'image/png','size_bytes':100,'upload_id':str(uuid4()),
                'paired_entry_photo_id':None,'created_at':NOW}

    def __call__(self, request):
        path = request.url.path
        if path.startswith('/rest/v1/rpc/'):
            self.calls.append(request)
            assert request.headers['apikey']=='sb_secret_unit_test'
            assert 'authorization' not in request.headers
            if self.missing_sql: return httpx.Response(404,json={'code':'PGRST202'})
            value=json.loads(request.content)
            assert value['p_user_id']==USER_A
            photo_id=value['p_photo_id']
            exit_photo=next(row for row in self.photos if row['photo_id']==photo_id)
            assert exit_photo['stage']=='exit' and exit_photo['paired_entry_photo_id']==ENTRY
            fn=path.rsplit('/',1)[-1]
            if fn=='begin_photo_comparison':
                if self.comparison and self.comparison['status']=='completed':
                    return httpx.Response(200,json={'action':'completed','analysis':self.comparison})
                if self.comparison and self.comparison['status']=='analyzing' and not self.comparison.get('stale'):
                    return httpx.Response(200,json={'action':'busy'})
                rid=value['p_request_id']
                self.logs[rid]={'status':'pending','attempted':False,'task_type':'photo_comparison'}
                self.comparison={'exit_photo_id':photo_id,'entry_photo_id':ENTRY,'status':'analyzing',
                    'active_request_id':rid,'overall_result':None,'changes':[], 'error_code':None,
                    'started_at':NOW,'updated_at':NOW,'model_name':None}
                return httpx.Response(200,json={'action':'acquired'})
            if fn=='reserve_photo_comparison_attempt':
                assert self.comparison['active_request_id']==value['p_active_request_id']
                if sum(row['attempted'] for row in self.logs.values())>=value['p_limit']:
                    return httpx.Response(200,json={'action':'limit'})
                rid=value['p_attempt_id']
                self.logs[rid]={'status':'analyzing','attempted':True,'task_type':'photo_comparison'}
                self.comparison['active_request_id']=rid
                return httpx.Response(200,json={'action':'reserved','request_id':rid})
            if fn=='finish_photo_comparison_attempt':
                if self.save_fail: return httpx.Response(500,json={})
                rid=value['p_request_id']
                if self.comparison['active_request_id']!=rid or self.comparison['status']!='analyzing':
                    return httpx.Response(200,json={'action':'superseded'})
                self.logs[rid]['status']='completed' if value['p_result'] else 'failed'
                if value['p_final']:
                    self.comparison.update(status='completed' if value['p_result'] else 'failed',
                        overall_result=value['p_result']['overall_result'] if value['p_result'] else None,
                        changes=value['p_result']['changes'] if value['p_result'] else [],
                        error_code=value['p_error_code'],model_name=value['p_model'])
                return httpx.Response(200,json={'action':'saved','analysis':self.comparison})
            raise AssertionError(fn)
        if path=='/rest/v1/photos':
            self.calls.append(request)
            if request.method=='GET':
                assert request.headers['apikey']=='sb_publishable_unit_test'
                user=jwt.decode(request.headers['authorization'].split()[1],SECRET,
                    algorithms=['HS256'],audience='authenticated')['sub']
                house=request.url.params['house_id'].removeprefix('eq.')
                if house!=self.records['houses'][user]['house_id']: return httpx.Response(200,json=[])
                rows=[dict(row) for row in self.photos if row['house_id']==house]
                for key in ['stage','photo_id','upload_id','paired_entry_photo_id']:
                    if key in request.url.params:
                        expected=request.url.params[key].removeprefix('eq.')
                        rows=[row for row in rows if row.get(key)==expected]
                if 'comparisons' in request.url.params['select']:
                    assert 'comparisons!comparisons_exit_photo_id_fkey(*)' in request.url.params['select']
                    for row in rows: row['comparisons']=self.comparison if self.comparison and self.comparison['exit_photo_id']==row['photo_id'] else None
                if 'analyses' in request.url.params['select']:
                    for row in rows: row['analyses']=None
                return httpx.Response(200,json=rows)
            assert request.headers['apikey']=='sb_secret_unit_test'
            assert 'authorization' not in request.headers
            row={**json.loads(request.content),'created_at':NOW}
            assert row['stage']=='exit' and row['house_id']==HOUSE_A
            assert row['paired_entry_photo_id']==ENTRY and row['location']=='거실'
            if self.db_fail: return httpx.Response(500,json={})
            if self.pair_race:
                winner={**row,'photo_id':str(uuid4()),'upload_id':str(uuid4()),'original_path':f'{USER_A}/{HOUSE_A}/winner/original.png'}
                self.photos.append(winner); self.objects[winner['original_path']]=b'winner'
                return httpx.Response(409,json={})
            if any(p['paired_entry_photo_id']==ENTRY for p in self.photos): return httpx.Response(409,json={})
            self.photos.append(row)
            if self.commit_timeout: raise httpx.ReadTimeout('private details',request=request)
            return httpx.Response(201,json=[row])
        if path=='/rest/v1/comparisons':
            self.calls.append(request)
            assert request.headers['apikey']=='sb_publishable_unit_test'
            assert 'authorization' in request.headers
            return httpx.Response(200,json=[self.comparison] if self.comparison else [])
        if path.startswith('/storage/v1/object/authenticated/'):
            self.calls.append(request)
            assert request.headers['apikey']=='sb_secret_unit_test'
            if self.image_fail: return httpx.Response(500)
            key=path.split('/deposit-private/',1)[1]
            return httpx.Response(200,content=self.objects[key])
        return super().__call__(request)


class CompareAI:
    def __init__(self):
        self.calls=[]; self.outputs=[]
        self.wait=False; self.entered=threading.Event(); self.release=threading.Event()

    async def __call__(self, request):
        self.calls.append(request)
        assert str(request.url)=='https://api.openai.com/v1/responses'
        assert request.headers['authorization']=='Bearer unit-openai-secret'
        data=json.loads(request.content)
        assert data['model']=='gpt-5.4-mini' and data['store'] is False
        assert data['text']['format']['name']=='move_out_photo_comparison'
        assert data['text']['format']['strict'] is True
        assert set(data['text']['format']['schema']['properties'])=={'overall_result','changes'}
        content=data['input'][0]['content']
        images=[part for part in content if part['type']=='input_image']
        assert len(images)==2
        assert all(image['image_url'].startswith('data:image/jpeg;base64,') for image in images)
        assert '입실' in content[1]['text'] and '퇴실' in content[3]['text']
        assert 'location' in content[0]['text'] and '거실' in content[0]['text']
        assert 'supabase.co' not in str(data)
        self.entered.set()
        while self.wait and not self.release.is_set(): await asyncio.sleep(.005)
        output=self.outputs.pop(0) if self.outputs else RESULT
        if isinstance(output,Exception): raise output
        if isinstance(output,httpx.Response): return output
        return httpx.Response(200,json={'status':'completed','output':[{'type':'message','content':[
            {'type':'output_text','text':json.dumps(output)}]}]})


@pytest.fixture
def moveout_system():
    remote=MoveOutRemote(); ai=CompareAI()
    settings=Settings(_env_file=None,supabase_url='https://local-test.supabase.co',
        supabase_publishable_key='sb_publishable_unit_test',supabase_secret_key='sb_secret_unit_test',
        openai_api_key='unit-openai-secret')
    with TestClient(create_app(settings,httpx.MockTransport(remote),httpx.MockTransport(ai))) as client:
        yield client,remote,ai,settings


def upload_exit(client, pair=ENTRY, upload_id=None, payload=None, name='exit.png', mime='image/png', user=USER_A):
    return client.post('/api/move-out/photos',headers=auth(user),
        data={'paired_entry_photo_id':pair,'upload_id':upload_id or str(uuid4())},
        files={'file':(name,image_bytes() if payload is None else payload,mime)})


def compare(client, photo_id, user=USER_A):
    return client.post(f'/api/move-out/photos/{photo_id}/compare',headers=auth(user))


def test_exit_upload_inherits_location_and_lists_private_pair(moveout_system):
    client,remote,ai,_=moveout_system
    before=dict(remote.objects)
    response=upload_exit(client)
    assert response.status_code==200,response.text
    photo_id=response.json()['data']['photo_id']
    row=next(p for p in remote.photos if p['photo_id']==photo_id)
    assert row['stage']=='exit' and row['paired_entry_photo_id']==ENTRY
    assert row['location']=='거실'
    assert remote.objects[row['original_path']]==image_bytes()
    assert all(remote.objects[key]==value for key,value in before.items())
    for _ in range(2):
        data=client.get('/api/move-out/photos',headers=auth()).json()['data']
        assert len(data)==1
        assert data[0]['entry_photo']['photo_id']==ENTRY
        assert '/object/sign/' in data[0]['entry_signed_url'] and '/object/sign/' in data[0]['signed_url']
        assert data[0]['comparison_status']=='not_analyzed' and data[0]['comparison'] is None
    assert client.get('/api/move-out/photos',headers=auth(USER_B)).json()=={'data':[]}
    assert not ai.calls


def test_duplicate_id_returns_existing_but_second_exit_is_blocked(moveout_system):
    client,remote,_,_=moveout_system
    uid=str(uuid4()); first=upload_exit(client,upload_id=uid).json()['data']
    count=len(remote.calls)
    again=upload_exit(client,upload_id=uid,payload=b'completed retry does not decode')
    assert again.status_code==200
    assert again.json()['data']['photo_id']==first['photo_id']
    assert again.json()['data']['already_uploaded'] is True
    assert not any('/storage/' in str(r.url) for r in remote.calls[count:])
    assert upload_exit(client).status_code==409
    assert len([p for p in remote.photos if p['stage']=='exit'])==1


@pytest.mark.parametrize('pair',[OTHER_ENTRY, str(uuid4())])
def test_other_users_or_missing_entry_cannot_be_linked(moveout_system,pair):
    client,remote,ai,_=moveout_system
    before=dict(remote.objects)
    assert upload_exit(client,pair=pair).status_code==404
    assert remote.objects==before and not ai.calls


def test_same_user_wrong_house_entry_is_rejected(moveout_system):
    client,remote,_,_=moveout_system
    remote.photos[0]['house_id']=str(uuid4())
    assert upload_exit(client).status_code==404
    assert not any(r.method=='POST' and '/storage/' in str(r.url) for r in remote.calls)


@pytest.mark.parametrize('kwargs',[
    {'name':'bad.gif','mime':'image/gif'}, {'mime':'text/plain'}, {'payload':b'broken'},
    {'payload':b''}, {'payload':image_bytes('JPEG')}, {'payload':b'x'*(20*1024*1024+1)},
    {'pair':'invalid-uuid'},
])
def test_invalid_file_and_fields_never_write(moveout_system,kwargs):
    client,remote,_,_=moveout_system
    before=dict(remote.objects)
    assert upload_exit(client,**kwargs).status_code==422
    assert remote.objects==before


def test_unauthenticated_exit_endpoints_blocked(moveout_system):
    client,remote,_,_=moveout_system
    assert client.get('/api/move-out/photos').status_code==401
    assert client.post('/api/move-out/photos',data={'paired_entry_photo_id':ENTRY,'upload_id':str(uuid4())},
        files={'file':('exit.png',image_bytes(),'image/png')}).status_code==401
    assert client.post(f'/api/move-out/photos/{ENTRY}/compare').status_code==401


@pytest.mark.parametrize('failure',['storage_fail','db_fail'])
def test_exit_failure_cleans_only_attempt_not_entry(moveout_system,failure):
    client,remote,_,_=moveout_system
    before=dict(remote.objects); setattr(remote,failure,True)
    assert upload_exit(client).status_code==502
    assert remote.objects==before


def test_racing_pair_unique_violation_cleans_loser(moveout_system):
    client,remote,_,_=moveout_system
    remote.pair_race=True
    response=upload_exit(client)
    assert response.status_code==409
    assert response.json()['error']['code']=='PHOTO_CONFLICT'
    assert len(remote.objects)==3 and b'winner' in remote.objects.values()


def test_exit_heic_conversion_and_ambiguous_commit_preserve_original(moveout_system):
    client,remote,_,_=moveout_system
    remote.commit_timeout=True
    payload=image_bytes('HEIF')
    response=upload_exit(client,payload=payload,name='exit.heic',mime='image/heic')
    assert response.status_code==200,response.text
    row=next(p for p in remote.photos if p['stage']=='exit')
    assert remote.objects[row['original_path']]==payload
    assert remote.objects[row['preview_path']].startswith(b'\xff\xd8')


def test_successful_compare_saved_reloaded_and_never_recharged(moveout_system):
    client,remote,ai,_=moveout_system
    photo_id=upload_exit(client).json()['data']['photo_id']
    response=compare(client,photo_id)
    assert response.status_code==200,response.text
    result=response.json()['data']
    assert result['overall_result']=='change_suspected' and result['changes']==RESULT['changes']
    assert result['entry_photo_id']==ENTRY and result['exit_photo_id']==photo_id
    assert result['status']=='completed'
    assert compare(client,photo_id).status_code==200 and len(ai.calls)==1
    listed=client.get('/api/move-out/photos',headers=auth()).json()['data'][0]
    assert listed['comparison']['changes']==RESULT['changes']
    assert listed['comparison_status']=='completed'
    assert [log['task_type'] for log in remote.logs.values()]==['photo_comparison']


def test_no_change_is_completed_not_failed(moveout_system):
    client,remote,ai,_=moveout_system
    photo_id=upload_exit(client).json()['data']['photo_id']
    ai.outputs=[{'overall_result':'no_visible_change','changes':[]}]
    assert compare(client,photo_id).json()['data']['status']=='completed'
    assert remote.comparison['changes']==[] and remote.comparison['overall_result']=='no_visible_change'


@pytest.mark.parametrize('result',[
    {'overall_result':'none','changes':[]}, {'overall_result':'change_suspected','changes':[]},
    {'overall_result':'no_visible_change','changes':RESULT['changes']},
    {'overall_result':'change_suspected','changes':[{'type':'scratch'}]},
    {'overall_result':'needs_review','changes':[],'coordinates':[1,2]},
])
def test_invalid_compare_output_cannot_be_stored_as_success(moveout_system,result):
    client,remote,ai,_=moveout_system
    photo_id=upload_exit(client).json()['data']['photo_id']; ai.outputs=[result]
    response=compare(client,photo_id)
    assert response.json()['error']['code']=='AI_INVALID_RESPONSE'
    assert remote.comparison['status']=='failed' and remote.comparison['overall_result'] is None
    assert len(ai.calls)==1


def test_ownership_and_actual_pair_validated_before_ai(moveout_system):
    client,remote,ai,_=moveout_system
    photo_id=upload_exit(client).json()['data']['photo_id']
    assert compare(client,photo_id,USER_B).status_code==404
    assert compare(client,ENTRY).status_code==404
    remote.photos[-1]['paired_entry_photo_id']=OTHER_ENTRY
    assert compare(client,photo_id).status_code==404
    assert not ai.calls and not remote.logs


@pytest.mark.parametrize('first',[
    httpx.Response(500,json={}), httpx.ReadTimeout('private data'),
    httpx.Response(429,json={'error':{'code':'rate_limit_exceeded'}}),
])
def test_transient_compare_error_retries_once_and_counts_both(moveout_system,first):
    client,remote,ai,_=moveout_system
    photo_id=upload_exit(client).json()['data']['photo_id']; ai.outputs=[first,RESULT]
    assert compare(client,photo_id).status_code==200
    assert len(ai.calls)==2 and sum(log['attempted'] for log in remote.logs.values())==2
    assert [log['status'] for log in remote.logs.values()]==['failed','completed']


@pytest.mark.parametrize('error,code',[
    (httpx.Response(401,json={}), 'AI_AUTH_ERROR'),
    (httpx.Response(429,json={'error':{'code':'insufficient_quota'}}), 'AI_CREDIT_REQUIRED'),
])
def test_auth_credit_errors_never_retry(moveout_system,error,code):
    client,remote,ai,_=moveout_system
    photo_id=upload_exit(client).json()['data']['photo_id']; ai.outputs=[error]
    response=compare(client,photo_id)
    assert response.json()['error']['code']==code
    assert remote.comparison['status']=='failed' and len(ai.calls)==1


def test_entry_analysis_and_comparison_share_daily_budget(moveout_system):
    client,remote,ai,settings=moveout_system
    photo_id=upload_exit(client).json()['data']['photo_id']
    settings.ai_daily_request_limit=1
    remote.logs[str(uuid4())]={'status':'completed','attempted':True,'task_type':'photo_analysis'}
    response=compare(client,photo_id)
    assert response.status_code==429
    assert remote.comparison['status']=='failed' and remote.comparison['error_code']=='AI_DAILY_LIMIT'
    assert not ai.calls


def test_same_exit_comparison_cannot_start_twice(moveout_system):
    client,remote,ai,_=moveout_system
    photo_id=upload_exit(client).json()['data']['photo_id']; ai.wait=True
    with ThreadPoolExecutor(max_workers=2) as pool:
        first=pool.submit(compare,client,photo_id)
        assert ai.entered.wait(3)
        try:
            response=compare(client,photo_id)
            assert response.status_code==409 and response.json()['error']['code']=='AI_IN_PROGRESS'
            assert len(ai.calls)==1
        finally: ai.release.set()
        assert first.result(timeout=3).status_code==200


def test_stale_comparison_recovers(moveout_system):
    client,remote,ai,_=moveout_system
    photo_id=upload_exit(client).json()['data']['photo_id']
    remote.comparison={'exit_photo_id':photo_id,'entry_photo_id':ENTRY,'status':'analyzing','stale':True,
        'started_at':(datetime.now(timezone.utc)-timedelta(minutes=4)).isoformat()}
    assert compare(client,photo_id).status_code==200 and len(ai.calls)==1


def test_missing_003_fails_before_paid_call(moveout_system):
    client,remote,ai,_=moveout_system
    photo_id=upload_exit(client).json()['data']['photo_id']; remote.missing_sql=True
    assert compare(client,photo_id).json()['error']['code']=='AI_SETUP_REQUIRED'
    assert not ai.calls


def test_compare_timeout_and_save_failure_are_not_no_change(moveout_system):
    client,remote,ai,_=moveout_system
    photo_id=upload_exit(client).json()['data']['photo_id']
    ai.outputs=[httpx.ReadTimeout('secret'),httpx.ReadTimeout('secret')]
    response=compare(client,photo_id)
    assert response.status_code==504
    assert remote.comparison['status']=='failed' and remote.comparison['overall_result'] is None
    remote.save_fail=True
    assert compare(client,photo_id).status_code==503
    assert len(ai.calls)==3


def test_entry_upload_id_cannot_be_reused_for_exit(moveout_system):
    client,remote,_,_=moveout_system
    before=dict(remote.objects)
    response=upload_exit(client,upload_id=remote.photos[0]['upload_id'])
    assert response.status_code==409
    assert response.json()['error']['code']=='UPLOAD_ID_CONFLICT'
    assert remote.objects==before


def test_chunked_exit_upload_body_limit(moveout_system):
    client,remote,_,_=moveout_system
    request=client.build_request('POST','/api/move-out/photos',headers=auth(),
        data={'paired_entry_photo_id':ENTRY,'upload_id':str(uuid4())},
        files={'file':('exit.png',b'x'*(21*1024*1024),'image/png')})
    del request.headers['content-length']
    response=client.send(request)
    assert response.status_code==422
    assert response.json()['error']['code']=='IMAGE_SIZE_LIMIT'


def test_comparison_sends_distinct_entry_then_exit_images(moveout_system):
    import io
    from PIL import Image
    client,remote,ai,_=moveout_system
    output=io.BytesIO()
    with Image.new('RGB',(16,12),'#bf534a') as image: image.save(output,format='PNG')
    photo_id=upload_exit(client,payload=output.getvalue()).json()['data']['photo_id']
    before=len(remote.calls)
    assert compare(client,photo_id).status_code==200
    downloads=[str(r.url) for r in remote.calls[before:] if '/object/authenticated/' in str(r.url)]
    assert len(downloads)==2
    assert f'/{ENTRY}/original.png' in downloads[0] and f'/{photo_id}/original.png' in downloads[1]
    images=[part['image_url'] for part in json.loads(ai.calls[0].content)['input'][0]['content'] if part['type']=='input_image']
    assert images[0]!=images[1]
