"""No paid calls: exercise real API flow with private Storage and OpenAI mock transports."""
import asyncio
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.api import create_app
from app.config import Settings
from app.schemas import EntryAnalysisResult
from test_api import USER_A, USER_B, NOW, auth
from test_photos import PhotoRemote, HOUSE_A, image_bytes

PHOTO = str(uuid4())
GOOD = {'overall_result': 'suspected', 'damages': [{'type': '얼룩', 'status': '의심',
        'description': '벽에 보이는 얼룩', 'recommendation': '가까이 촬영하여 기록하세요.'}]}


class AnalysisRemote(PhotoRemote):
    def __init__(self):
        super().__init__()
        self.analysis = None
        self.logs = {}
        self.missing_sql = False
        self.save_fail = False
        self.image_fail = False
        path = f'{USER_A}/{HOUSE_A}/{PHOTO}/original.png'
        self.photos = [{'photo_id': PHOTO, 'house_id': HOUSE_A, 'stage': 'entry', 'location': '거실',
            'original_path': path, 'preview_path': None, 'mime_type': 'image/png', 'size_bytes':100,
            'upload_id':str(uuid4()), 'created_at':NOW, 'analyses':None}]
        self.objects[path] = image_bytes()

    def __call__(self, request):
        path = request.url.path
        if path.startswith('/rest/v1/rpc/'):
            self.calls.append(request)
            assert request.headers['apikey'] == 'sb_secret_unit_test'
            assert 'authorization' not in request.headers
            if self.missing_sql: return httpx.Response(404,json={'code':'PGRST202'})
            data=json.loads(request.content)
            assert data['p_user_id'] == USER_A and data['p_photo_id'] == PHOTO
            function=path.rsplit('/',1)[-1]
            if function == 'begin_photo_analysis':
                if self.analysis and self.analysis['status']=='completed':
                    return httpx.Response(200,json={'action':'completed','analysis':self.analysis})
                if self.analysis and self.analysis['status']=='analyzing' and not self.analysis.get('stale'):
                    return httpx.Response(200,json={'action':'busy'})
                request_id=data['p_request_id']
                self.logs[request_id]={'status':'pending','attempted':False,'error':None}
                self.analysis={'photo_id':PHOTO,'status':'analyzing','overall_result':None,'damages':[],
                    'active_request_id':request_id,'started_at':NOW,'updated_at':NOW,'model_name':None,'error_code':None}
                return httpx.Response(200,json={'action':'acquired'})
            if function == 'reserve_photo_ai_attempt':
                if self.analysis['active_request_id'] != data['p_active_request_id']:
                    return httpx.Response(200,json={'action':'superseded'})
                if sum(log['attempted'] for log in self.logs.values()) >= data['p_limit']:
                    return httpx.Response(200,json={'action':'limit'})
                request_id=data['p_attempt_id']
                self.logs[request_id]={'status':'analyzing','attempted':True,'error':None}
                self.analysis['active_request_id']=request_id
                return httpx.Response(200,json={'action':'reserved','request_id':request_id})
            if function == 'finish_photo_ai_attempt':
                if self.save_fail: return httpx.Response(500,json={})
                request_id=data['p_request_id']
                if self.analysis['active_request_id'] != request_id or self.analysis['status'] != 'analyzing':
                    return httpx.Response(200,json={'action':'superseded'})
                self.logs[request_id].update(status='completed' if data['p_result'] else 'failed',error=data['p_error_code'])
                if data['p_final']:
                    self.analysis.update(status='completed' if data['p_result'] else 'failed',
                        overall_result=data['p_result']['overall_result'] if data['p_result'] else None,
                        damages=data['p_result']['damages'] if data['p_result'] else [],
                        model_name=data['p_model'],error_code=data['p_error_code'])
                return httpx.Response(200,json={'action':'saved','analysis':self.analysis})
            raise AssertionError('Unknown RPC')
        if path.startswith('/storage/v1/object/authenticated/'):
            self.calls.append(request)
            assert request.headers['apikey']=='sb_secret_unit_test'
            assert 'authorization' not in request.headers
            if self.image_fail: return httpx.Response(500)
            return httpx.Response(200,content=next(iter(self.objects.values())))
        if path=='/rest/v1/photos' and request.method=='GET':
            self.photos[0]['analyses']=self.analysis
            photo_id=request.url.params.get('photo_id')
            if photo_id and photo_id != f'eq.{PHOTO}': return httpx.Response(200,json=[])
        return super().__call__(request)


class MockAI:
    def __init__(self):
        self.calls=[]
        self.outputs=[]
        self.entered=threading.Event()
        self.release=threading.Event()
        self.wait=False

    async def __call__(self, request):
        self.calls.append(request)
        assert str(request.url)=='https://api.openai.com/v1/responses'
        assert request.headers['authorization']=='Bearer unit-openai-secret'
        payload=json.loads(request.content)
        assert payload['model']=='gpt-5.4-mini'
        assert payload['store'] is False
        assert payload['text']['format']['type']=='json_schema'
        assert payload['text']['format']['strict'] is True
        assert payload['text']['format']['schema']['additionalProperties'] is False
        assert payload['input'][0]['content'][1]['image_url'].startswith('data:image/jpeg;base64,')
        assert 'location' in payload['input'][0]['content'][0]['text']
        assert 'supabase.co' not in str(payload)
        self.entered.set()
        while self.wait and not self.release.is_set(): await asyncio.sleep(.005)
        output=self.outputs.pop(0) if self.outputs else GOOD
        if isinstance(output,Exception): raise output
        if isinstance(output,httpx.Response): return output
        return httpx.Response(200,json={'status':'completed','output':[{'type':'message','content':[
            {'type':'output_text','text':json.dumps(output)}]}]})


@pytest.fixture
def analysis_system():
    remote=AnalysisRemote()
    ai=MockAI()
    settings=Settings(_env_file=None,supabase_url='https://local-test.supabase.co',
        supabase_publishable_key='sb_publishable_unit_test',supabase_secret_key='sb_secret_unit_test',
        openai_api_key='unit-openai-secret')
    with TestClient(create_app(settings,httpx.MockTransport(remote),httpx.MockTransport(ai))) as client:
        yield client,remote,ai,settings


def analyze(client, user=USER_A, photo_id=PHOTO):
    return client.post(f'/api/photos/{photo_id}/analyze',headers=auth(user))


def test_normal_result_saved_and_reloaded_without_duplicate_call(analysis_system):
    client,remote,ai,_=analysis_system
    response=analyze(client)
    assert response.status_code==200,response.text
    assert response.json()['data']['status']=='completed'
    assert response.json()['data']['damages']==GOOD['damages']
    assert len(ai.calls)==1
    assert [log['status'] for log in remote.logs.values()]==['completed']
    assert analyze(client).status_code==200
    assert len(ai.calls)==1
    rows=client.get('/api/move-in/photos',headers=auth()).json()['data']
    assert rows[0]['analysis']['overall_result']=='suspected'
    assert rows[0]['analysis_status']=='completed'


def test_no_damage_is_completed_not_failed(analysis_system):
    client,remote,ai,_=analysis_system
    ai.outputs=[{'overall_result':'none','damages':[]}]
    response=analyze(client)
    assert response.status_code==200
    assert response.json()['data']['overall_result']=='none'
    assert remote.analysis['status']=='completed' and remote.analysis['damages']==[]


@pytest.mark.parametrize('bad',[
    {'overall_result':'unknown','damages':[]},
    {'overall_result':'none','damages':GOOD['damages']},
    {'overall_result':'suspected','damages':[]},
    {'overall_result':'suspected','damages':[{'type':'damage'}]},
    {'overall_result':'none','damages':[],'coordinates':[1,2]},
])
def test_invalid_structured_result_is_failed_and_not_retried(analysis_system,bad):
    client,remote,ai,_=analysis_system
    ai.outputs=[bad]
    response=analyze(client)
    assert response.status_code==502
    assert response.json()['error']['code']=='AI_INVALID_RESPONSE'
    assert remote.analysis['status']=='failed'
    assert remote.analysis['overall_result'] is None
    assert len(ai.calls)==1


def test_only_owner_and_entry_can_analyze(analysis_system):
    client,remote,ai,_=analysis_system
    assert client.post(f'/api/photos/{PHOTO}/analyze').status_code==401
    assert analyze(client,USER_B).status_code==404
    assert analyze(client,photo_id=str(uuid4())).status_code==404
    remote.photos[0]['stage']='exit'
    assert analyze(client).status_code==404
    assert not ai.calls and not remote.logs


@pytest.mark.parametrize('error,code',[
    (httpx.Response(401,json={'error':{'code':'invalid_api_key'}}),'AI_AUTH_ERROR'),
    (httpx.Response(429,json={'error':{'code':'insufficient_quota'}}),'AI_CREDIT_REQUIRED'),
    (httpx.Response(403,json={}), 'AI_PERMISSION_ERROR'),
    (httpx.Response(404,json={}), 'AI_MODEL_UNAVAILABLE'),
    (httpx.Response(400,json={}), 'AI_SERVICE_ERROR'),
])
def test_auth_credit_and_configuration_errors_do_not_retry(analysis_system,error,code):
    client,remote,ai,_=analysis_system
    ai.outputs=[error]
    response=analyze(client)
    assert response.json()['error']['code']==code
    assert response.json()['error']['retryable'] is False
    assert remote.analysis['status']=='failed'
    assert remote.analysis['error_code']==code
    assert len(ai.calls)==1


@pytest.mark.parametrize('first',[
    httpx.Response(500,json={}), httpx.Response(429,json={'error':{'code':'rate_limit_exceeded'}}),
    httpx.ReadTimeout('private image and key details'), httpx.ConnectError('secret detail')])
def test_one_transient_retry_is_counted(analysis_system,first):
    client,remote,ai,_=analysis_system
    ai.outputs=[first,GOOD]
    assert analyze(client).status_code==200
    assert len(ai.calls)==2
    assert sum(log['attempted'] for log in remote.logs.values())==2
    assert [log['status'] for log in remote.logs.values()]==['failed','completed']


def test_timeout_twice_records_failure_without_false_none(analysis_system):
    client,remote,ai,_=analysis_system
    ai.outputs=[httpx.ReadTimeout('secret'),httpx.ReadTimeout('secret')]
    response=analyze(client)
    assert response.status_code==504
    assert response.json()['error']['code']=='AI_TIMEOUT'
    assert 'secret' not in response.text
    assert remote.analysis['status']=='failed'
    assert remote.analysis['overall_result'] is None
    assert len(ai.calls)==2


def test_daily_limit_and_retry_consumes_last_slot(analysis_system):
    client,remote,ai,settings=analysis_system
    settings.ai_daily_request_limit=1
    ai.outputs=[httpx.Response(500,json={})]
    response=analyze(client)
    assert response.status_code==429
    assert response.json()['error']['code']=='AI_DAILY_LIMIT'
    assert len(ai.calls)==1
    assert sum(log['attempted'] for log in remote.logs.values())==1
    assert remote.analysis['status']=='failed'
    assert remote.analysis['error_code']=='AI_DAILY_LIMIT'
    endings=[json.loads(r.content) for r in remote.calls if r.url.path.endswith('/finish_photo_ai_attempt')]
    assert endings[-1]['p_final'] is True
    assert endings[-1]['p_error_code']=='AI_DAILY_LIMIT'


def test_limit_prevents_any_call(analysis_system):
    client,remote,ai,_=analysis_system
    remote.logs={str(uuid4()):{'status':'failed','attempted':True} for _ in range(30)}
    assert analyze(client).status_code==429
    assert not ai.calls
    assert remote.analysis['status']=='failed'
    assert remote.analysis['error_code']=='AI_DAILY_LIMIT'
    pending_job=remote.logs[remote.analysis['active_request_id']]
    assert pending_job['status']=='failed'
    assert pending_job['attempted'] is False


def test_same_photo_concurrent_request_is_busy(analysis_system):
    client,remote,ai,_=analysis_system
    ai.wait=True
    with ThreadPoolExecutor(max_workers=2) as pool:
        first=pool.submit(analyze,client)
        assert ai.entered.wait(3)
        try:
            second=analyze(client)
            assert second.status_code==409
            assert second.json()['error']['code']=='AI_IN_PROGRESS'
            assert len(ai.calls)==1
        finally: ai.release.set()
        assert first.result(timeout=3).status_code==200


def test_stale_analysis_recovers_on_next_request(analysis_system):
    client,remote,ai,_=analysis_system
    remote.analysis={'status':'analyzing','stale':True,'started_at':(datetime.now(timezone.utc)-timedelta(minutes=4)).isoformat()}
    assert analyze(client).status_code==200
    assert remote.analysis['status']=='completed'


def test_missing_sql_or_key_fails_before_paid_call(analysis_system):
    client,remote,ai,settings=analysis_system
    remote.missing_sql=True
    response=analyze(client)
    assert response.status_code==503
    assert response.json()['error']['code']=='AI_SETUP_REQUIRED'
    remote.missing_sql=False
    from pydantic import SecretStr
    settings.openai_api_key=SecretStr('')
    assert analyze(client).json()['error']['code']=='AI_NOT_CONFIGURED'
    assert not ai.calls


def test_storage_failure_does_not_consume_ai_quota(analysis_system):
    client,remote,ai,_=analysis_system
    remote.image_fail=True
    assert analyze(client).json()['error']['code']=='AI_IMAGE_FETCH_FAILED'
    assert not ai.calls
    assert remote.analysis['status']=='failed'
    assert not any(log['attempted'] for log in remote.logs.values())


def test_save_failure_does_not_repeat_paid_call(analysis_system,caplog):
    client,remote,ai,_=analysis_system
    remote.save_fail=True
    response=analyze(client)
    assert response.status_code==503
    assert len(ai.calls)==1
    assert 'AI_STATE_SAVE_FAILED' in caplog.text
    assert 'unit-openai-secret' not in caplog.text
    assert '벽에 보이는 얼룩' not in caplog.text


@pytest.mark.parametrize('payload,code',[
    ({'status':'incomplete','output':[]},'AI_INCOMPLETE'),
    ({'status':'completed','output':[{'type':'message','content':[{'type':'refusal','refusal':'no'}]}]},'AI_REFUSED'),
    ({'status':'completed','output':[]},'AI_INVALID_RESPONSE'),
    ([], 'AI_INVALID_RESPONSE'),
])
def test_incomplete_refusal_and_malformed_output_not_saved(analysis_system,payload,code):
    client,remote,ai,_=analysis_system
    ai.outputs=[httpx.Response(200,json=payload)]
    response=analyze(client)
    assert response.json()['error']['code']==code
    assert remote.analysis['status']=='failed'
    assert len(ai.calls)==1


def test_total_http_deadline_records_failed(analysis_system,monkeypatch):
    client,remote,ai,_=analysis_system
    monkeypatch.setattr('app.analysis.ANALYSIS_TOTAL_TIMEOUT',.03)
    ai.wait=True
    response=analyze(client)
    assert response.status_code==504
    assert remote.analysis['status']=='failed'
    assert remote.analysis['error_code']=='AI_TIMEOUT'
    assert len(ai.calls)==1


def test_user_path_tampering_prevents_storage_and_ai_calls(analysis_system):
    client,remote,ai,_=analysis_system
    remote.photos[0]['original_path']=f'{USER_B}/other/private.png'
    response=analyze(client)
    assert response.json()['error']['code']=='INVALID_PHOTO_PATH'
    assert not ai.calls
    assert not any('/object/authenticated/' in str(r.url) for r in remote.calls)
    assert remote.analysis['status']=='failed'


def test_completed_result_still_reads_without_openai_key(analysis_system):
    client,remote,ai,settings=analysis_system
    assert analyze(client).status_code==200
    from pydantic import SecretStr
    settings.openai_api_key=SecretStr('')
    assert analyze(client).status_code==200
    assert len(ai.calls)==1


def test_rpc_user_id_comes_from_verified_jwt_not_client_input(analysis_system):
    client,remote,ai,_=analysis_system
    response=client.post(f'/api/photos/{PHOTO}/analyze',headers={**auth(),'X-User-Id':USER_B},
        params={'user_id':USER_B,'p_user_id':USER_B},json={'user_id':USER_B,'p_user_id':USER_B})
    assert response.status_code==200
    rpc_calls=[json.loads(r.content) for r in remote.calls if '/rest/v1/rpc/' in r.url.path]
    assert len(rpc_calls)==3
    assert all(call['p_user_id']==USER_A for call in rpc_calls)
    assert len(ai.calls)==1


def test_forged_jwt_cannot_supply_rpc_user_id(analysis_system):
    import jwt
    from test_api import token
    client,remote,ai,_=analysis_system
    claims=jwt.decode(token(),options={'verify_signature':False})
    forged=jwt.encode(claims,'untrusted-signing-key',algorithm='HS256')
    response=client.post(f'/api/photos/{PHOTO}/analyze',headers={'Authorization':f'Bearer {forged}'},
        json={'p_user_id':USER_A})
    assert response.status_code==401
    assert not any('/rest/v1/rpc/' in r.url.path for r in remote.calls)
    assert not ai.calls and not remote.logs
