"""Account-scoped living records, with private image storage and retry reconciliation."""
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4
from starlette.concurrency import run_in_threadpool
from .photos import PhotoService, inspect_image, logger, URL_TTL
from .errors import ApiError


class LivingService(PhotoService):
    async def rows(self, house_id, token, upload_id=None):
        params = {'select': '*', 'house_id': f'eq.{house_id}', 'order': 'created_at.desc,photo_id.desc'}
        if upload_id: params['upload_id'] = f'eq.{upload_id}'
        response = await self.gateway.request('GET', '/rest/v1/living_records',
            headers=self.headers(token), params=params)
        if response.status_code >= 400: self.gateway.raise_database_error(response)
        try:
            rows = response.json()
            if not isinstance(rows, list) or any(row['house_id'] != house_id or
                (upload_id and row['upload_id'] != str(upload_id)) for row in rows):
                raise ValueError()
            return rows
        except (ValueError, TypeError, KeyError):
            raise ApiError(502, 'DATABASE_INVALID_RESPONSE', '거주 기록을 확인할 수 없습니다.') from None

    @staticmethod
    def check_identity(row, category, description):
        if row['category'] != category or row['description'] != description:
            raise ApiError(409, 'UPLOAD_ID_CONFLICT', '다른 내용으로 저장한 요청입니다. 새 기록으로 등록해 주세요.')

    async def listing(self, user):
        house = await self.gateway.record('houses', user.user_id, user.token)
        if not house: return []
        rows = await self.rows(house['house_id'], user.token)
        for row in rows:
            row['signed_url'] = await self.signed(row.get('preview_path') or row['original_path'], user.user_id, house['house_id'])
            row['signed_url_expires_at'] = datetime.now(timezone.utc) + timedelta(seconds=URL_TTL)
        return rows

    async def upload(self, user, file, category, description, upload_id):
        house = await self.house(user)
        house_id = house['house_id']
        previous = await self.rows(house_id, user.token, upload_id)
        if previous and previous[0].get('deleting'):
            raise ApiError(409,'RESOURCE_DELETING','삭제 중인 사진의 업로드는 재사용할 수 없습니다.')
        if previous:
            self.check_identity(previous[0], category, description)
            return {'photo_id': previous[0]['photo_id'], 'upload_status': 'stored', 'already_uploaded': True}
        # Serialize decode + upload to avoid concurrent full-resolution allocations.
        async with self.processing_lock:
            mime, size, preview = await run_in_threadpool(inspect_image, file)
            attempt = str(uuid4())
            prefix = f'{user.user_id}/{house_id}/{attempt}'
            original = f'{prefix}/original{Path(file.filename).suffix.lower()}'
            preview_path = f'{prefix}/preview.jpg' if preview else None
            paths = []
            try:
                # Include attempted paths: a timeout can happen after Storage committed.
                paths.append(original)
                await self.upload_object(original, file.file, mime)
                if preview:
                    paths.append(preview_path)
                    await self.upload_object(preview_path, preview, 'image/jpeg')
                values = {'photo_id': attempt, 'house_id': house_id, 'category': category, 'description': description,
                          'original_path': original, 'preview_path': preview_path, 'mime_type': mime,
                          'size_bytes': size, 'upload_id': str(upload_id)}
                try:
                    response = await self.gateway.request('POST', '/rest/v1/living_records',
                        headers={**self.headers(), 'Prefer': 'return=representation'}, json=values)
                except ApiError:
                    # Ambiguous commit: reconcile before deleting any possibly referenced file.
                    return await self.reconcile(user, house_id, upload_id, paths, attempt, category, description)
                if response.status_code >= 400:
                    if response.status_code == 409 or response.status_code >= 500:
                        return await self.reconcile(user, house_id, upload_id, paths, attempt, category, description, conflict=response.status_code == 409)
                    await self.cleanup(paths, attempt)
                    paths.clear()
                    self.gateway.raise_database_error(response)
                # Even a malformed success response may have committed. Resolve by upload ID.
                return await self.reconcile(user, house_id, upload_id, paths, attempt, category, description)
            except ApiError:
                # DB reconciliation manages its own cleanup (or preservation).
                if paths: await self.cleanup(paths, attempt)
                raise
            finally:
                if preview: preview.close()

    async def reconcile(self, user, house_id, upload_id, paths, attempt, category, description, conflict=False):
        try:
            rows = await self.rows(house_id, user.token, upload_id)
        except ApiError:
            logger.error('PHOTO_COMMIT_UNKNOWN attempt=%s', attempt)
            paths.clear()  # Preserve possibly committed objects; retry with same upload ID.
            raise ApiError(503, 'UPLOAD_CONFIRMATION_PENDING', '저장 여부 확인이 지연됩니다. 같은 사진을 다시 시도해 주세요.', True) from None
        if rows:
            row = rows[0]
            if row['photo_id'] != attempt:
                await self.cleanup(paths, attempt)
            paths.clear()
            self.check_identity(row, category, description)
            return {'photo_id': row['photo_id'], 'upload_status': 'stored',
                    'already_uploaded': row['photo_id'] != attempt}
        await self.cleanup(paths, attempt)
        paths.clear()
        if conflict:
            raise ApiError(409, 'RECORD_CONFLICT', '기록 저장 요청이 중복되었습니다. 다시 조회해 주세요.')
        raise ApiError(502, 'DATABASE_SAVE_FAILED', '사진 기록 저장에 실패했습니다. 다시 시도해 주세요.', True)

