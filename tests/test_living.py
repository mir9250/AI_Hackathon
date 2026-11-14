"""Real multipart/image validation with an offline Supabase transport."""
import json
from uuid import uuid4
import httpx
import pytest
from fastapi.testclient import TestClient
from app.api import create_app
from app.config import Settings
from test_api import auth, USER_A, USER_B, NOW
from test_photos import PhotoRemote, HOUSE_A, image_bytes


class LivingRemote(PhotoRemote):
    def __init__(self):
        super().__init__()
        self.living = []

    def __call__(self, request):
        if request.url.path != '/rest/v1/living_records':
            return super().__call__(request)
        self.calls.append(request)
        if request.method == 'GET':
            assert request.headers['apikey'] == 'sb_publishable_unit_test'
            assert request.headers['authorization'].startswith('Bearer ')
            if self.read_fail: return httpx.Response(500)
            house = request.url.params['house_id'].removeprefix('eq.')
            upload = request.url.params.get('upload_id', '').removeprefix('eq.')
            return httpx.Response(200, json=[r for r in self.living if r['house_id'] == house and (not upload or r['upload_id'] == upload)])
        assert request.headers['apikey'] == 'sb_secret_unit_test'
        assert 'authorization' not in request.headers
        if self.db_fail: return httpx.Response(500)
        row = {**json.loads(request.content), 'created_at': NOW}
        self.living.append(row)
        if self.commit_timeout: raise httpx.ReadTimeout('private upstream', request=request)
        return httpx.Response(201, json=[row])


@pytest.fixture
def living_system():
    remote = LivingRemote()
    settings = Settings(_env_file=None, supabase_url='https://local-test.supabase.co',
        supabase_publishable_key='sb_publishable_unit_test', supabase_secret_key='sb_secret_unit_test')
    with TestClient(create_app(settings, httpx.MockTransport(remote))) as client:
        yield client, remote


def save(client, upload_id=None, description='창가 벽에 얼룩', category='mold', payload=None, headers=None):
    return client.post('/api/living-records', headers=auth() if headers is None else headers,
        files={'file': ('wall.png', image_bytes() if payload is None else payload, 'image/png')},
        data={'category': category, 'description': description, 'upload_id': upload_id or str(uuid4())})


def test_persist_retry_reload_and_isolation(living_system):
    client, remote = living_system
    upload = str(uuid4())
    assert save(client, upload).status_code == 200
    assert save(client, upload).json()['data']['already_uploaded'] is True
    assert len(remote.objects) == len(remote.living) == 1
    row = client.get('/api/living-records', headers=auth()).json()['data'][0]
    assert row['description'] == '창가 벽에 얼룩'
    assert row['category'] == 'mold'
    assert row['signed_url'].startswith('https://local-test.supabase.co/storage/')
    assert client.get('/api/living-records', headers=auth(USER_B)).json()['data'] == []
    assert save(client, upload, description='changed').status_code == 409


def test_auth_validation_and_house_required(living_system):
    client, remote = living_system
    assert save(client, headers={}).status_code == 401
    assert client.get('/api/living-records').status_code == 401
    assert save(client, category='invalid').status_code == 422
    assert save(client, description=' ').status_code == 422
    assert save(client, description='x'*2001).status_code == 422
    assert save(client, payload=b'invalid image').status_code == 422
    assert not remote.objects
    del remote.records['houses'][USER_A]
    assert save(client).status_code == 409


def test_storage_failure_and_db_failure_leave_no_success(living_system):
    client, remote = living_system
    remote.storage_fail = True
    assert save(client).status_code == 502
    remote.storage_fail = False
    remote.db_fail = True
    assert save(client).status_code == 502
    assert not remote.living and not remote.objects


def test_timeout_after_commit_reconciles_without_deleting_photo(living_system):
    client, remote = living_system
    remote.commit_timeout = True
    assert save(client).status_code == 200
    assert len(remote.living) == len(remote.objects) == 1


def test_foreign_storage_path_is_not_signed(living_system):
    client, remote = living_system
    assert save(client).status_code == 200
    remote.living[0]['original_path'] = f'{USER_B}/{HOUSE_A}/foreign.png'
    assert client.get('/api/living-records', headers=auth()).status_code == 502
