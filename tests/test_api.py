from datetime import datetime, timezone
from uuid import uuid4

import httpx
import jwt
import pytest
from fastapi.testclient import TestClient

from app.api import create_app
from app.config import Settings

USER_A = str(uuid4())
USER_B = str(uuid4())
SECRET = 'local-unit-test-secret-never-used-for-real-auth'
NOW = datetime.now(timezone.utc).isoformat()


def token(user=USER_A, **overrides):
    claims = {"sub": user, "iss": "https://local-test.supabase.co/auth/v1",
              "exp": 4102444800, "aud": "authenticated", "role": "authenticated"}
    return jwt.encode({**claims, **overrides}, SECRET, algorithm="HS256")


class FakeSupabase:
    """Offline HTTP transport, including a real signature check for test tokens."""
    def __init__(self):
        self.records = {"profiles": {}, "houses": {}}
        self.calls = []
        self.auth_error = None
        self.db_error = None
        self.confirmed = True
        self.bad_user = False
        self.raw_response = None

    def __call__(self, request):
        self.calls.append(request)
        assert request.headers['apikey'] == 'sb_publishable_unit_test'
        assert 'sb_secret_unit_test' not in str(request.headers)
        assert request.headers['authorization'].startswith('Bearer ')
        encoded = request.headers['authorization'].split(' ', 1)[1]
        if request.url.path == '/auth/v1/user':
            if self.auth_error:
                return httpx.Response(self.auth_error, json={"message": "private upstream detail"})
            try:
                claims = jwt.decode(encoded, SECRET, algorithms=['HS256'], audience='authenticated')
            except jwt.PyJWTError:
                return httpx.Response(401, json={})
            return httpx.Response(200, json={"id": USER_B if self.bad_user else claims['sub'],
                                           "email_confirmed_at": NOW if self.confirmed else None})
        if self.db_error:
            return httpx.Response(self.db_error, json={"message": "sensitive SQL response"})
        if self.raw_response is not None:
            return httpx.Response(200, json=self.raw_response)
        table = request.url.path.split('/')[-1]
        user = request.url.params['user_id'].removeprefix('eq.')
        assert user in {USER_A, USER_B}
        assert jwt.decode(encoded, SECRET, algorithms=['HS256'], audience='authenticated')['sub'] == user
        if request.method == 'POST':
            import json
            value = json.loads(request.content)
            assert value['user_id'] == user
            assert request.url.params['on_conflict'] == 'user_id'
            assert request.headers['prefer'] == 'resolution=merge-duplicates,return=representation'
            previous = self.records[table].get(user, {})
            row = {**previous, **value, "created_at": NOW, "updated_at": NOW}
            if table == 'houses':
                row['house_id'] = previous.get('house_id', str(uuid4()))
            self.records[table][user] = row
        value = self.records[table].get(user)
        return httpx.Response(200, json=[value] if value else [])


@pytest.fixture
def system():
    remote = FakeSupabase()
    settings = Settings(_env_file=None, supabase_url='https://local-test.supabase.co',
                        supabase_publishable_key='sb_publishable_unit_test',
                        supabase_secret_key='sb_secret_unit_test')
    with TestClient(create_app(settings, httpx.MockTransport(remote)), raise_server_exceptions=False) as client:
        yield client, remote


def auth(user=USER_A):
    return {"Authorization": f"Bearer {token(user)}"}


def test_health_does_not_contact_supabase(system):
    client, remote = system
    assert client.get('/api/health').json()['data']['status'] == 'ok'
    assert not remote.calls


@pytest.mark.parametrize('path', ['/api/profile', '/api/house'])
@pytest.mark.parametrize('header', [{}, {'Authorization': 'Basic bad'}, {'Authorization': 'Bearer bad'}])
def test_protected_routes_require_bearer(system, path, header):
    client, remote = system
    response = client.get(path, headers=header)
    assert response.status_code == 401
    assert response.json()['error']['retryable'] is False
    assert not remote.calls


@pytest.mark.parametrize('overrides', [
    {'exp': 1}, {'iss': 'https://attacker.example/auth/v1'}, {'aud': 'other'},
    {'sub': 'not-uuid'}, {'role': 'service_role'}, {'nbf': 9999999999}, {'is_anonymous': True},
])
def test_claim_validation_precedes_data_access(system, overrides):
    client, remote = system
    response = client.get('/api/profile', headers={'Authorization': 'Bearer ' + token(**overrides)})
    assert response.status_code == 401
    assert remote.calls == []


def test_modified_signature_is_rejected_by_auth_server(system):
    client, remote = system
    forged = jwt.encode(jwt.decode(token(), options={'verify_signature': False}), 'attacker', algorithm='HS256')
    assert client.get('/api/profile', headers={'Authorization': 'Bearer ' + forged}).status_code == 401
    assert len(remote.calls) == 1


def test_unconfirmed_email_is_rejected(system):
    client, remote = system
    remote.confirmed = False
    response = client.get('/api/profile', headers=auth())
    assert response.status_code == 401
    assert response.json()['error']['code'] == 'EMAIL_NOT_CONFIRMED'


def test_subject_mismatch_is_not_trusted(system):
    client, remote = system
    remote.bad_user = True
    assert client.get('/api/profile', headers=auth()).status_code == 502
    assert len(remote.calls) == 1


@pytest.mark.parametrize('path,body', [
    ('/api/profile', {'display_name': '  세입자  '}),
    ('/api/house', {'name': '  나의 집  ', 'address': '  서울시 중구  '}),
])
def test_read_create_update_and_user_isolation(system, path, body):
    client, remote = system
    assert client.get(path, headers=auth()).json() == {'data': None}
    saved = client.put(path, headers=auth(), json=body)
    assert saved.status_code == 200
    assert saved.json()['data']['user_id'] == USER_A
    assert all(saved.json()['data'][key] == value.strip() for key, value in body.items())
    row_id = saved.json()['data'].get('house_id')
    second = client.put(path, headers=auth(), json=body).json()['data']
    assert second.get('house_id') == row_id
    assert client.get(path, headers=auth()).json()['data'] == second
    assert client.get(path, headers=auth(USER_B)).json()['data'] is None
    assert len(remote.records[path.split('/')[-1] + 's']) == 1


@pytest.mark.parametrize('path,body', [
    ('/api/profile', {'display_name': ' '}),
    ('/api/profile', {'display_name': 'x' * 81}),
    ('/api/profile', {'display_name': 123}),
    ('/api/profile', {'display_name': 'A', 'user_id': USER_B}),
    ('/api/house', {'name': '', 'address': 'x'}),
    ('/api/house', {'name': 'x', 'address': ' '}),
    ('/api/house', {'name': 'x', 'address': 'x' * 501}),
    ('/api/house', {'name': 'x', 'address': 'y', 'house_id': str(uuid4())}),
])
def test_input_errors_are_safe(system, path, body):
    client, remote = system
    response = client.put(path, headers=auth(), json=body)
    assert response.status_code == 422
    assert set(response.json()['error']) == {'code', 'message', 'retryable'}
    assert 'test-backend-secret' not in response.text
    assert all('/rest/' not in str(call.url) for call in remote.calls)


@pytest.mark.parametrize('upstream,expected,retryable', [(401, 401, False), (403, 403, False),
    (409, 409, False), (500, 502, True), (429, 503, True)])
def test_database_error_mapping(system, upstream, expected, retryable):
    client, remote = system
    remote.db_error = upstream
    response = client.get('/api/house', headers=auth())
    assert response.status_code == expected
    assert response.json()['error']['retryable'] is retryable
    assert 'sensitive' not in response.text


@pytest.mark.parametrize('upstream,expected', [(401, 401), (403, 401), (500, 502), (429, 503)])
def test_auth_upstream_errors(system, upstream, expected):
    client, remote = system
    remote.auth_error = upstream
    assert client.get('/api/profile', headers=auth()).status_code == expected


def test_network_timeout():
    def timeout(request):
        raise httpx.ReadTimeout('private token detail', request=request)
    settings = Settings(_env_file=None, supabase_url='https://local-test.supabase.co',
                        supabase_publishable_key='sb_publishable_unit_test',
                        supabase_secret_key='sb_secret_unit_test')
    with TestClient(create_app(settings, httpx.MockTransport(timeout))) as client:
        response = client.get('/api/profile', headers=auth())
        assert response.status_code == 504
        assert response.json()['error']['retryable'] is True
        assert 'private' not in response.text


def test_unknown_path_and_method_share_error_envelope(system):
    client, _ = system
    assert client.get('/api/unknown').status_code == 404
    assert 'error' in client.post('/api/house').json()


def test_cors_authorization_preflight(system):
    client, _ = system
    headers = {'Origin': 'http://localhost:5173', 'Access-Control-Request-Method': 'PUT',
               'Access-Control-Request-Headers': 'authorization,content-type'}
    response = client.options('/api/house', headers=headers)
    assert response.status_code == 200
    assert response.headers['access-control-allow-origin'] == headers['Origin']
    headers['Origin'] = 'https://attacker.example'
    denied = client.options('/api/house', headers=headers)
    assert denied.status_code == 400
    assert 'access-control-allow-origin' not in denied.headers


def test_only_current_api_routes_exist(system):
    client, _ = system
    paths = client.get('/openapi.json').json()['paths']
    assert set(paths) == {'/api/photos/{photo_id}', '/api/health', '/api/profile', '/api/house', '/api/move-in/photos', '/api/photos/{photo_id}/analyze', '/api/move-out/photos', '/api/move-out/photos/{photo_id}/compare', '/api/contracts', '/api/contracts/{id}', '/api/contracts/{id}/pdf', '/api/contracts/{id}/pages', '/api/contracts/{id}/complete', '/api/contracts/{id}/analyze'}


def test_bad_upstream_ownership_is_not_exposed(system):
    client, remote = system
    remote.raw_response = [{'user_id': USER_B, 'display_name': 'private'}]
    response = client.get('/api/profile', headers=auth())
    assert response.status_code == 502
    assert 'private' not in response.text
