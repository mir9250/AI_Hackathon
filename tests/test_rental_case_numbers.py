from scripts.rental_law_common import case_numbers


def test_merged_case_number_normalization():
    assert case_numbers('2024다297384, 297391') == ['2024다297384', '2024다297391']
    assert case_numbers('94다34692,94다34708') == ['94다34692', '94다34708']
    assert case_numbers('2023다249661(본소), 2023다249662(반소)') == ['2023다249661', '2023다249662']
    assert case_numbers('2023다249661, 2023다249661') == ['2023다249661']
