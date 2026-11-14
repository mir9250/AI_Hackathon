"""Offline API integration tests: real multipart, real image decode, mocked Supabase HTTP."""
import io
import json
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.api import create_app
from app.config import Settings
from test_api import FakeSupabase, USER_A, USER_B, NOW, auth

HOUSE_A, HOUSE_B = str(uuid4()), str(uuid4())


def image_bytes(fmt='PNG'):
    data = io.BytesIO()
    with Image.new('RGB', (16, 12), '#659276') as image:
        image.save(data, format=fmt)
    return data.getvalue()


class PhotoRemote(FakeSupabase):
    def __init__(self):
        super().__init__()
        self.records['houses'] = {USER_A: {'user_id': USER_A, 'house_id': HOUSE_A, 'name': 'A', 'address': 'test'},
                                  USER_B: {'user_id': USER_B, 'house_id': HOUSE_B, 'name': 'B', 'address': 'test'}}
        self.photos = []
        self.objects = {}
        self.storage_fail = False
        self.db_fail = False
        self.cleanup_fail = False
        self.commit_timeout = False
        self.read_fail = False
        self.race = False

    def __call__(self, request):
        if request.url.path.startswith('/storage/'):
            self.calls.append(request)
            assert request.headers['apikey'] == 'sb_secret_unit_test'
            assert 'authorization' not in request.headers
            if '/object/sign/' in request.url.path:
                path = request.url.path.split('/object/sign/', 1)[1]
                return httpx.Response(200, json={'signedURL': '/object/sign/' + path + '?token=fake'})
            if request.method == 'DELETE':
                if self.cleanup_fail: return httpx.Response(500, json={})
                for path in json.loads(request.content)['prefixes']: self.objects.pop(path, None)
                return httpx.Response(200, json=[])
            if self.storage_fail: return httpx.Response(500, json={})
            path = request.url.path.split('/object/deposit-private/', 1)[1]
            self.objects[path] = request.content
            return httpx.Response(200, json={'Key': path})
        if request.url.path == '/rest/v1/photos':
            self.calls.append(request)
            if request.method == 'GET':
                assert request.headers['apikey'] == 'sb_publishable_unit_test'
                assert request.headers['authorization'].startswith('Bearer ')
                if self.read_fail: return httpx.Response(500, json={})
                house_id = request.url.params['house_id'].removeprefix('eq.')
                upload = request.url.params.get('upload_id', '').removeprefix('eq.')
                rows = [p for p in self.photos if p['house_id'] == house_id and p['stage'] == 'entry'
                        and (not upload or p['upload_id'] == upload)]
                return httpx.Response(200, json=rows)
            assert request.headers['apikey'] == 'sb_secret_unit_test'
            assert 'authorization' not in request.headers
            row = {**json.loads(request.content), 'created_at': NOW, 'analyses': None}
            assert row['stage'] == 'entry'
            assert row['house_id'] == HOUSE_A
            if self.db_fail: return httpx.Response(500, json={})
            if self.race:
                row['photo_id'] = str(uuid4())
                row['original_path'] = f'{USER_A}/{HOUSE_A}/{row["photo_id"]}/original.png'
                self.objects[row['original_path']] = b'other-success'
            self.photos.append(row)
            if self.commit_timeout:
                raise httpx.ReadTimeout('secret upstream details', request=request)
            return httpx.Response(409 if self.race else 201, json=[row])
        return super().__call__(request)


@pytest.fixture
def photos_system():
    remote = PhotoRemote()
    settings = Settings(_env_file=None, supabase_url='https://local-test.supabase.co',
                        supabase_publishable_key='sb_publishable_unit_test', supabase_secret_key='sb_secret_unit_test')
    with TestClient(create_app(settings, httpx.MockTransport(remote))) as client:
        yield client, remote


def upload(client, payload=None, name='room.png', mime='image/png', location='거실', upload_id=None, headers=None):
    return client.post('/api/move-in/photos', headers=auth() if headers is None else headers,
        files={'file': (name, image_bytes() if payload is None else payload, mime)},
        data={'location': location, 'upload_id': upload_id or str(uuid4())})


def test_upload_persists_original_and_lists_only_owner_after_new_session(photos_system):
    client, remote = photos_system
    source = image_bytes()
    result = upload(client, source)
    assert result.status_code == 200, result.text
    assert result.json()['data']['upload_status'] == 'stored'
    assert len(remote.photos) == len(remote.objects) == 1
    assert next(iter(remote.objects.values())) == source
    for _ in range(2):  # New requests with session token, no in-process photo cache.
        rows = client.get('/api/move-in/photos', headers=auth()).json()['data']
        assert len(rows) == 1
        assert rows[0]['location'] == '거실'
        assert rows[0]['analysis_status'] == 'not_analyzed'
        assert rows[0]['signed_url'].startswith('https://local-test.supabase.co/storage/v1/object/sign/')
        assert rows[0]['signed_url_expires_at']
    assert client.get('/api/move-in/photos', headers=auth(USER_B)).json() == {'data': []}


def test_duplicate_upload_returns_existing_without_storage_write(photos_system):
    client, remote = photos_system
    upload_id = str(uuid4())
    first = upload(client, upload_id=upload_id).json()['data']
    count = len(remote.calls)
    second = upload(client, payload=b'not-read-for-completed-retry', upload_id=upload_id)
    assert second.status_code == 200
    assert second.json()['data']['photo_id'] == first['photo_id']
    assert second.json()['data']['already_uploaded'] is True
    assert not any('/storage/' in str(r.url) for r in remote.calls[count:])
    assert len(remote.photos) == 1


@pytest.mark.parametrize('kwargs,code', [
    ({'name': 'file.gif', 'mime': 'image/gif'}, 'INVALID_IMAGE_TYPE'),
    ({'mime': 'text/plain'}, 'INVALID_IMAGE_TYPE'),
    ({'payload': b'broken'}, 'INVALID_IMAGE'),
    ({'payload': b''}, 'IMAGE_SIZE_LIMIT'),
    ({'payload': image_bytes('JPEG')}, 'IMAGE_CONTENT_MISMATCH'),
    ({'payload': image_bytes()[:35]}, 'INVALID_IMAGE'),
    ({'location': ' '}, 'VALIDATION_ERROR'),
    ({'location': 'x' * 81}, 'VALIDATION_ERROR'),
    ({'upload_id': 'not-uuid'}, 'VALIDATION_ERROR'),
])
def test_invalid_file_and_fields_never_write(photos_system, kwargs, code):
    client, remote = photos_system
    result = upload(client, **kwargs)
    assert result.status_code == 422, result.text
    assert result.json()['error']['code'] == code
    assert not remote.objects and not remote.photos


def test_oversize_and_extreme_resolution(photos_system, monkeypatch):
    client, remote = photos_system
    assert upload(client, payload=b'x' * (20 * 1024 * 1024 + 1)).status_code == 422
    monkeypatch.setattr('app.photos.MAX_PIXELS', 100)
    result = upload(client)
    assert result.status_code == 422
    assert result.json()['error']['code'] == 'IMAGE_RESOLUTION_LIMIT'
    assert not remote.objects


def test_request_body_limit(photos_system):
    client, remote = photos_system
    result = upload(client, payload=b'x' * (21 * 1024 * 1024))
    assert result.status_code == 422
    assert not remote.objects


def test_anonymous_and_unregistered_house(photos_system):
    client, remote = photos_system
    assert upload(client, headers={}).status_code == 401
    assert client.get('/api/move-in/photos').status_code == 401
    remote.records['houses'].clear()
    assert upload(client).json()['error']['code'] == 'HOUSE_REQUIRED'
    assert client.get('/api/move-in/photos', headers=auth()).json() == {'data': []}
    assert not remote.objects


@pytest.mark.parametrize('failure', ['storage_fail', 'db_fail'])
def test_storage_or_database_failure_cleans_attempt(photos_system, failure):
    client, remote = photos_system
    setattr(remote, failure, True)
    result = upload(client)
    assert result.status_code == 502
    assert result.json()['error']['retryable']
    assert not remote.photos and not remote.objects
    assert any(r.method == 'DELETE' for r in remote.calls)


def test_cleanup_failure_is_recorded_without_private_data(photos_system, caplog):
    client, remote = photos_system
    remote.db_fail = remote.cleanup_fail = True
    assert upload(client).status_code == 502
    assert 'PHOTO_CLEANUP_FAILED attempt=' in caplog.text
    assert 'sb_secret_unit_test' not in caplog.text


def test_committed_database_timeout_preserves_file(photos_system):
    client, remote = photos_system
    remote.commit_timeout = True
    assert upload(client).status_code == 200
    assert len(remote.photos) == len(remote.objects) == 1
    assert not any(r.method == 'DELETE' for r in remote.calls)


def test_concurrent_conflict_cleans_only_losing_attempt(photos_system):
    client, remote = photos_system
    remote.race = True
    result = upload(client)
    assert result.status_code == 200
    assert result.json()['data']['already_uploaded']
    assert list(remote.objects.values()) == [b'other-success']


@pytest.mark.parametrize('fmt,name,mime', [('JPEG','room.jpg','image/jpeg'), ('WEBP','room.webp','image/webp'),
                                         ('HEIF','room.heic','image/heic')])
def test_supported_decoders_and_heic_preview(photos_system, fmt, name, mime):
    client, remote = photos_system
    source = image_bytes(fmt)
    result = upload(client, source, name, mime)
    assert result.status_code == 200, result.text
    assert remote.objects[remote.photos[0]['original_path']] == source
    if fmt == 'HEIF':
        preview = remote.objects[remote.photos[0]['preview_path']]
        with Image.open(io.BytesIO(preview)) as image:
            assert image.format == 'JPEG'
        assert len(remote.objects) == 2


def test_existing_analysis_returned(photos_system):
    client, remote = photos_system
    assert upload(client).status_code == 200
    remote.photos[0]['analyses'] = {'status': 'completed', 'overall_result': 'none', 'damages': []}
    result = client.get('/api/move-in/photos', headers=auth()).json()['data'][0]
    assert result['analysis_status'] == 'completed'
    assert result['analysis']['overall_result'] == 'none'


def test_ambiguous_commit_and_read_failure_preserves_file_for_retry(photos_system, caplog):
    client, remote = photos_system
    original = remote.__class__.__call__
    def after_commit(self, request):
        try:
            return original(self, request)
        except httpx.ReadTimeout:
            self.read_fail = True
            raise
    remote.commit_timeout = True
    # Patch class special method because MockTransport uses the callable instance.
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(PhotoRemote, '__call__', after_commit)
        result = upload(client)
    assert result.status_code == 503
    assert result.json()['error']['code'] == 'UPLOAD_CONFIRMATION_PENDING'
    assert len(remote.objects) == 1
    assert 'PHOTO_COMMIT_UNKNOWN attempt=' in caplog.text
    remote.read_fail = False
    retry = upload(client, upload_id=remote.photos[0]['upload_id'])
    assert retry.status_code == 200
    assert retry.json()['data']['already_uploaded']


def test_cross_house_storage_path_is_never_signed(photos_system):
    client, remote = photos_system
    assert upload(client).status_code == 200
    remote.photos[0]['original_path'] = f'{USER_B}/{HOUSE_B}/other/original.png'
    before = len(remote.calls)
    result = client.get('/api/move-in/photos', headers=auth())
    assert result.status_code == 502
    assert result.json()['error']['code'] == 'INVALID_PHOTO_PATH'
    assert not any('/object/sign/' in str(r.url) for r in remote.calls[before:])


def test_chunked_request_body_limit_without_content_length(photos_system):
    client, remote = photos_system
    request = client.build_request('POST', '/api/move-in/photos', headers=auth(),
        files={'file': ('room.png', b'x' * (21 * 1024 * 1024), 'image/png')},
        data={'location': '거실', 'upload_id': str(uuid4())})
    del request.headers['content-length']
    result = client.send(request)
    assert result.status_code == 422
    assert result.json()['error']['code'] == 'IMAGE_SIZE_LIMIT'
    assert not remote.objects
