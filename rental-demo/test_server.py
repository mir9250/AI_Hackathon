import base64
import io
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch
import server

IMAGE = 'data:image/png;base64,' + base64.b64encode(b'\x89PNG\r\n\x1a\nexample').decode()


def result(evidence='퇴실 청소비 10만 원'):
    return {'summary': '확인할 질문이 있습니다.', 'observations': [{'location': '청소 특약', 'evidence': evidence,
            'interpretation': '산정 범위를 확인하세요.', 'certainty': '보통', 'category': '특약 확인'}],
            'questions': ['금액 산정 범위가 무엇인가요?'], 'next_steps': ['계약 전체를 확인하세요.'],
            'draft': '청소비 산정 내역 확인 부탁드립니다.', 'limitations': ['법적 유효성을 확정하지 않습니다.']}


class ProviderContext(io.BytesIO):
    def __enter__(self):
        return self
    def __exit__(self, *args):
        self.close()


class Tests(unittest.TestCase):
    def test_consent_and_input(self):
        for value in [{}, {'task': 'contract', 'text': '충분히 긴 계약 내용입니다.'}, {'task': 'hack', 'consent': True}]:
            with self.assertRaises(server.InputError):
                server.validate_input(value)
        valid = server.validate_input({'task': 'photo', 'images': [IMAGE], 'consent': True})
        self.assertEqual(valid['images'], [IMAGE])
        with self.assertRaises(server.InputError):
            server.validate_input({'task': 'compare', 'images': [IMAGE], 'consent': True})
        with self.assertRaises(server.InputError):
            server.validate_input({'task': 'contract', 'text': 'a' * 16001, 'consent': True})

    def test_only_local_image_bytes(self):
        for value in ['https://example.com/photo.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,' + base64.b64encode(b'not png').decode()]:
            with self.assertRaises(server.InputError):
                server.valid_image(value)

    def test_payload_privacy_and_order(self):
        data = server.validate_input({'task': 'compare', 'images': [IMAGE, IMAGE], 'consent': True})
        payload = server.payload_for(data)
        self.assertFalse(payload['store'])
        self.assertTrue(payload['text']['format']['strict'])
        self.assertEqual([c['type'] for c in payload['input'][0]['content']], ['input_text', 'input_image', 'input_image'])
        self.assertNotIn('api_key', json.dumps(payload))

    def test_no_key_no_network(self):
        with patch.dict(os.environ, {'OPENAI_API_KEY': ''}), patch('server.request.urlopen') as transport:
            with self.assertRaises(server.ProviderError) as exc:
                server.call_openai({'task': 'contract', 'text': '특약', 'images': [], 'area': ''})
            self.assertEqual(exc.exception.status, 503)
            transport.assert_not_called()

    def test_structured_provider_response_and_quote_validation(self):
        def call(response):
            return ProviderContext(json.dumps(response).encode())
        def envelope(analysis):
            return {'status': 'completed', 'model': 'test-model', 'output': [{'content': [{'type': 'output_text', 'text': json.dumps(analysis)}]}]}
        data = {'task': 'contract', 'text': '퇴실 청소비 10만 원을 부담한다.', 'images': [], 'area': '특약'}
        with patch.dict(os.environ, {'OPENAI_API_KEY': 'unit-test-only'}):
            with patch('server.request.urlopen', return_value=call(envelope(result()))):
                response = server.call_openai(data)
                self.assertEqual(response['model'], 'test-model')
                self.assertEqual(response['task'], 'contract')
            with patch('server.request.urlopen', return_value=call(envelope(result('없는 조항')))):
                with self.assertRaises(server.ProviderError):
                    server.call_openai(data)
            for response in [{'status': 'incomplete'}, {'status': 'completed', 'output': [{'content': [{'type': 'refusal'}]}]}, envelope({'summary': '필드 누락'})]:
                with patch('server.request.urlopen', return_value=call(response)):
                    with self.assertRaises(server.ProviderError):
                        server.call_openai(data)

    def test_schema_rejects_bad_values(self):
        value = result()
        value['observations'][0]['certainty'] = '99%'
        with self.assertRaises(server.ProviderError):
            server.validate_schema(value, server.SCHEMA)

    def test_static_whitelist(self):
        self.assertNotIn('.env', server.ALLOWED_FILES)
        self.assertNotIn('server.py', server.ALLOWED_FILES)


if __name__ == '__main__':
    unittest.main()
