import hashlib
import json

import pytest
from fastapi.testclient import TestClient

from app import legal
from backend.legal_preview import app


@pytest.fixture
def client():
    legal.catalog.cache_clear()
    with TestClient(app) as client:
        yield client
    legal.catalog.cache_clear()


def test_public_catalog_counts_and_paging(client):
    result = client.get('/api/legal/cases').json()['data']
    assert result['catalog_total'] == result['total'] == 120
    assert result['primary_count'] == 119
    assert result['secondary_count'] == 1
    assert len(result['items']) == 10
    assert result['legal_professional_reviewed'] is False
    second = client.get('/api/legal/cases?offset=10').json()['data']
    assert not {r['id'] for r in result['items']} & {r['id'] for r in second['items']}


def test_source_filter_and_detail(client):
    result = client.get('/api/legal/cases?source=primary&limit=30').json()['data']
    assert result['total'] == 119
    assert all(r['verification_level'] == 'primary_text_checked' for r in result['items'])
    full = client.get('/api/legal/cases/case-98gahap44951').json()['data']
    assert full['verification_level'] == 'official_secondary_only'
    assert full['reference_eligible_after_legal_review'] is False
    assert full['source_quote'] and full['cautions']


def test_search_case_number_and_no_match(client):
    result = client.get('/api/legal/cases', params={'q': '2023다249661'}).json()['data']
    assert result['total'] == 1
    assert result['items'][0]['id'] == 'case-2023da249661'
    assert client.get('/api/legal/cases?q=절대매칭되지않는문자열').json()['data']['total'] == 0
    assert client.get('/api/legal/cases', params={'q': "' OR 1=1 --"}).json()['data']['total'] == 0
    topic = client.get('/api/legal/cases').json()['data']['topics'][0]
    filtered = client.get('/api/legal/cases', params={'topic': topic}).json()['data']['items']
    assert filtered and all(topic in r['topics'] for r in filtered)


@pytest.mark.parametrize('query', ['limit=0', 'limit=31', 'offset=-1', 'offset=1001', 'source=other', 'q=' + '가' * 101])
def test_input_limits(client, query):
    assert client.get('/api/legal/cases?' + query).status_code == 422


def test_not_found_and_missing_data(client, monkeypatch, tmp_path):
    assert client.get('/api/legal/cases/missing').status_code == 404
    monkeypatch.setattr(legal, 'DATA_PATH', tmp_path / 'absent.json')
    legal.catalog.cache_clear()
    assert client.get('/api/legal/cases').status_code == 503


def test_unique_cases_and_hashes():
    data = json.loads(legal.DATA_PATH.read_text())
    cases = [r for r in data['records'] if r['type'] == 'case']
    numbers = set()
    for record in cases:
        assert not numbers.intersection(record['case_numbers'])
        numbers.update(record['case_numbers'])
        if record.get('source_quote_sha256'):
            assert hashlib.sha256(record['source_quote'].encode()).hexdigest() == record['source_quote_sha256']
