"""읽기 전용 공개 판례 검색. 사용자 기록·외부 AI·외부 법률 서비스 호출 없음."""
import json
import unicodedata
from functools import lru_cache
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Query

from .errors import ApiError

router = APIRouter(prefix='/api/legal', tags=['법률 참고자료'])
DATA_PATH = Path(__file__).with_name('data') / 'rental-law-v0.2.json'
DISCLAIMER = ('법률 전문가 검토 전 참고자료예요. 임대 대상·계약·사실관계와 사건 당시 법령, '
              '후속 판결을 확인해야 해요. 법률 자문이나 책임·공제액 판정이 아니에요.')


def normalize(value):
    return ' '.join(unicodedata.normalize('NFKC', value).casefold().split())


@lru_cache(maxsize=1)
def catalog():
    try:
        data = json.loads(DATA_PATH.read_text(encoding='utf-8'))
        records = [r for r in data['records'] if r['type'] == 'case']
        if len(records) != 120 or len({r['id'] for r in records}) != 120:
            raise ValueError('invalid case count')
        index = []
        for r in records:
            if not r['source_url'].startswith(('https://law.go.kr/', 'https://www.law.go.kr/', 'https://www.easylaw.go.kr/')):
                raise ValueError('invalid source')
            if not r['source_quote'] or r['verification_level'] not in {'primary_text_checked', 'official_secondary_only'}:
                raise ValueError('missing source text')
            index.append((r, normalize(' '.join([r['citation'], r['title'],
                ' '.join(r['topics']), r.get('source_issues', ''), r['source_quote']]))))
        return data['version'], tuple(index)
    except (OSError, ValueError, KeyError, TypeError):
        raise ApiError(503, 'LEGAL_DATA_UNAVAILABLE', '판례 자료를 준비 중이에요. 잠시 후 다시 조회해 주세요.', True) from None


def brief(record):
    fields = ('id', 'citation', 'title', 'court', 'case_numbers', 'topics', 'decision_on',
              'source_url', 'source_publisher', 'verification_level', 'retrieved_on',
              'reference_eligible_after_legal_review')
    result = {k: record.get(k) for k in fields}
    result['excerpt'] = record['source_quote'][:280] + ('…' if len(record['source_quote']) > 280 else '')
    return result


@router.get('/cases')
def search_cases(q: str = Query(default='', max_length=100),
                 topic: str = Query(default='', max_length=30),
                 source: Literal['all', 'primary'] = 'all',
                 limit: int = Query(default=10, ge=1, le=30),
                 offset: int = Query(default=0, ge=0, le=1000)):
    version, index = catalog()
    words = normalize(q).split()
    topic = normalize(topic)
    matched = [(r, sum(text.count(word) for word in words)) for r, text in index
               if all(word in text for word in words)
               and (not topic or any(normalize(t) == topic for t in r['topics']))
               and (source == 'all' or r['verification_level'] == 'primary_text_checked')]
    matched.sort(key=lambda pair: (pair[1], pair[0]['decision_on'], pair[0]['id']), reverse=True)
    primary = sum(r['verification_level'] == 'primary_text_checked' for r, _ in index)
    return {'data': {'items': [brief(r) for r, _ in matched[offset:offset + limit]],
        'total': len(matched), 'limit': limit, 'offset': offset, 'dataset_version': version,
        'catalog_total': len(index), 'primary_count': primary, 'secondary_count': len(index) - primary,
        'topics': sorted({t for r, _ in index for t in r['topics']}), 'disclaimer': DISCLAIMER,
        'legal_professional_reviewed': False}}


@router.get('/cases/{case_id}')
def get_case(case_id: str):
    version, index = catalog()
    for record, _ in index:
        if record['id'] == case_id:
            return {'data': {**record, 'dataset_version': version,
                             'legal_professional_reviewed': False, 'disclaimer': DISCLAIMER}}
    raise ApiError(404, 'LEGAL_CASE_NOT_FOUND', '해당 판례를 찾지 못했어요. 목록에서 다시 선택해 주세요.')
