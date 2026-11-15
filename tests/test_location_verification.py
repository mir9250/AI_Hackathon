"""Location uncertainty must never become a clean damage assessment."""
import pytest
from app.schemas import EntryAnalysisResult, ComparisonResult

FINDING = dict(type='location_unverified', status='확인되지 않습니다',
               description='욕실로 지정했지만 침대가 보입니다.',
               recommendation='촬영 위치를 수정하거나 욕실 전체 사진을 등록해 주세요.')

@pytest.mark.parametrize('schema, field, result', [
    (EntryAnalysisResult, 'damages', 'none'),
    (EntryAnalysisResult, 'damages', 'suspected'),
    (ComparisonResult, 'changes', 'no_visible_change'),
    (ComparisonResult, 'changes', 'change_suspected'),
])
def test_location_uncertainty_overrides_damage_conclusion(schema, field, result):
    misleading = dict(FINDING, type='긁힘')
    parsed = schema.model_validate({'overall_result': result, field: [FINDING, misleading]})
    assert parsed.overall_result == 'needs_review'
    assert [item.type for item in getattr(parsed, field)] == ['location_unverified']
