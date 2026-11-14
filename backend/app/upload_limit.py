"""Bound incoming multipart bodies before the parser spools files to disk."""
import re

from starlette.responses import JSONResponse
from starlette.formparsers import MultiPartException


class UploadTooLarge(MultiPartException):
    pass


class UploadLimitMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        file_route = scope['path'] in {'/api/move-in/photos', '/api/move-out/photos', '/api/living-records'} or re.fullmatch(r'/api/contracts/[^/]+/(pdf|pages)', scope['path'])
        if scope['method'] != 'POST' or not file_route:
            return await self.app(scope, receive, send)
        limit = 21 * 1024 * 1024  # 20MiB file + bounded multipart overhead
        count = 0
        async def limited_receive():
            nonlocal count
            message = await receive()
            count += len(message.get('body', b''))
            if count > limit:
                scope['photo_upload_too_large'] = True
                raise UploadTooLarge('Image upload too large')
            return message
        try:
            length = dict(scope['headers']).get(b'content-length')
            if length and int(length) > limit: raise UploadTooLarge('Image upload too large')
            await self.app(scope, limited_receive, send)
        except UploadTooLarge:
            await JSONResponse(status_code=422, content={'error': {'code': 'IMAGE_SIZE_LIMIT',
                'message': '업로드 요청이 너무 큽니다. 파일은 20MiB 이하로 하나씩 전송해 주세요.',
                'retryable': False}})(scope, receive, send)
