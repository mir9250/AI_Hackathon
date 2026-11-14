"""Move-in photo storage. User-scoped reads; privileged writes only after house checks."""
import logging
import tempfile
import warnings
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote
from uuid import uuid4

from PIL import Image, ImageOps, UnidentifiedImageError
from pillow_heif import register_heif_opener
from starlette.concurrency import run_in_threadpool

from .errors import ApiError

register_heif_opener(thumbnails=False)
MAX_BYTES = 20 * 1024 * 1024
MAX_PIXELS = 20_000_000
MAX_SIDE = 10_000
URL_TTL = 900
BUCKET = 'deposit-private'
FORMATS = {'.jpg': ('JPEG', 'image/jpeg'), '.jpeg': ('JPEG', 'image/jpeg'),
           '.png': ('PNG', 'image/png'), '.webp': ('WEBP', 'image/webp'),
           '.heic': ('HEIF', 'image/heic')}
logger = logging.getLogger('app.photos')


def inspect_image(file):
    """Decode one bounded image at a time; keep originals in spooled files."""
    suffix = Path(file.filename or '').suffix.lower()
    expected = FORMATS.get(suffix)
    if not expected or file.content_type not in ({expected[1], 'image/heif'} if suffix == '.heic' else {expected[1]}):
        raise ApiError(422, 'INVALID_IMAGE_TYPE', 'JPG, PNG, HEIC, WEBP 사진만 등록할 수 있습니다.')
    source = file.file
    source.seek(0, 2)
    size = source.tell()
    source.seek(0)
    if not 0 < size <= MAX_BYTES:
        raise ApiError(422, 'IMAGE_SIZE_LIMIT', '사진은 비어 있지 않은 20MiB 이하 파일이어야 합니다.')
    preview = None
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(source) as image:
                if image.format != expected[0]:
                    raise ApiError(422, 'IMAGE_CONTENT_MISMATCH', '확장자·형식과 실제 사진 내용이 일치하지 않습니다.')
                width, height = image.size
                if width * height > MAX_PIXELS or max(width, height) > MAX_SIDE:
                    raise ApiError(422, 'IMAGE_RESOLUTION_LIMIT', '사진은 2천만 화소 이하, 가로·세로 각각 10,000픽셀 이하여야 합니다.')
                image.verify()
            source.seek(0)
            with Image.open(source) as image:
                image.load()  # verify() alone does not fully decode JPEG/WebP/HEIC.
                if suffix == '.heic':
                    preview = tempfile.TemporaryFile()
                    oriented = ImageOps.exif_transpose(image)
                    try:
                        oriented.thumbnail((2048, 2048))
                        with oriented.convert('RGB') as rgb:
                            rgb.save(preview, format='JPEG', quality=85)
                        preview.seek(0)
                    finally:
                        oriented.close()
        source.seek(0)
        return expected[1], size, preview
    except ApiError:
        if preview: preview.close()
        raise
    except (UnidentifiedImageError, OSError, ValueError, EOFError, SyntaxError,
            Image.DecompressionBombError, Image.DecompressionBombWarning):
        if preview: preview.close()
        raise ApiError(422, 'INVALID_IMAGE', '손상되었거나 지원하지 않는 사진입니다. 다른 파일을 선택해 주세요.') from None


class PhotoService:
    def __init__(self, gateway, processing_lock):
        self.gateway = gateway
        self.processing_lock = processing_lock

    def headers(self, token=None):
        if token:
            return {'apikey': self.gateway.settings.supabase_publishable_key.get_secret_value(),
                    'Authorization': f'Bearer {token}'}
        # New secret keys belong in apikey, never in a JWT Authorization header.
        return {'apikey': self.gateway.settings.supabase_secret_key.get_secret_value()}

    async def house(self, user):
        house = await self.gateway.record('houses', user.user_id, user.token)
        if not house:
            raise ApiError(409, 'HOUSE_REQUIRED', '먼저 주택 정보를 등록해 주세요.')
        return house

    async def rows(self, house_id, token, upload_id=None, stage='entry', paired_id=None):
        relation = 'comparisons!comparisons_exit_photo_id_fkey(*)' if stage == 'exit' else 'analyses(*)'
        params = {'select': '*,' + relation, 'house_id': f'eq.{house_id}',
                  'order': 'created_at.desc,photo_id.desc'}
        if stage: params['stage'] = f'eq.{stage}'
        if paired_id: params['paired_entry_photo_id'] = f'eq.{paired_id}'
        if upload_id: params['upload_id'] = f'eq.{upload_id}'
        response = await self.gateway.request('GET', '/rest/v1/photos', headers=self.headers(token), params=params)
        if response.status_code >= 400: self.gateway.raise_database_error(response)
        try:
            rows = response.json()
            if not isinstance(rows, list) or any(row['house_id'] != house_id or (stage and row['stage'] != stage)
                                                or (paired_id and row.get('paired_entry_photo_id') != str(paired_id))
                                                or (upload_id and row['upload_id'] != str(upload_id)) for row in rows):
                raise ValueError()
            return rows
        except (ValueError, TypeError, KeyError):
            raise ApiError(502, 'DATABASE_INVALID_RESPONSE', '사진 기록을 확인할 수 없습니다.') from None

    async def upload_object(self, path, source, mime):
        source.seek(0, 2)
        size = source.tell()
        source.seek(0)
        async def chunks():
            while chunk := await run_in_threadpool(source.read, 256 * 1024):
                yield chunk
        response = await self.gateway.request('POST', f'/storage/v1/object/{BUCKET}/{path}',
            headers={**self.headers(), 'Content-Type': mime, 'Content-Length': str(size), 'x-upsert': 'false'},
            content=chunks())
        if response.status_code >= 400:
            raise ApiError(502, 'STORAGE_UPLOAD_FAILED', '사진 저장에 실패했습니다. 다시 시도해 주세요.', True)

    async def cleanup(self, paths, attempt):
        if not paths: return
        try:
            response = await self.gateway.request('DELETE', f'/storage/v1/object/{BUCKET}',
                                                  headers=self.headers(), json={'prefixes': paths})
            if response.status_code >= 400: raise ValueError()
        except Exception:
            # Only generated attempt ID: never tokens, addresses or upstream bodies.
            logger.error('PHOTO_CLEANUP_FAILED attempt=%s', attempt)

    async def upload(self, user, file, location, upload_id, stage='entry', paired_entry_photo_id=None, house=None):
        house = house or await self.house(user)
        house_id = house['house_id']
        previous = await self.rows(house_id, user.token, upload_id, stage=None)
        if previous and previous[0].get('deleting'):
            raise ApiError(409,'RESOURCE_DELETING','삭제 중인 사진의 업로드는 재사용할 수 없습니다.')
        if previous:
            self.check_upload_identity(previous[0], stage, paired_entry_photo_id)
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
                values = {'photo_id': attempt, 'house_id': house_id, 'stage': stage, 'location': location,
                          'original_path': original, 'preview_path': preview_path, 'mime_type': mime,
                          'size_bytes': size, 'upload_id': str(upload_id)}
                if paired_entry_photo_id: values['paired_entry_photo_id'] = str(paired_entry_photo_id)
                try:
                    response = await self.gateway.request('POST', '/rest/v1/photos',
                        headers={**self.headers(), 'Prefer': 'return=representation'}, json=values)
                except ApiError:
                    # Ambiguous commit: reconcile before deleting any possibly referenced file.
                    return await self.reconcile(user, house_id, upload_id, paths, attempt, stage, paired_entry_photo_id)
                if response.status_code >= 400:
                    if response.status_code == 409 or response.status_code >= 500:
                        return await self.reconcile(user, house_id, upload_id, paths, attempt, stage, paired_entry_photo_id, conflict=response.status_code == 409)
                    await self.cleanup(paths, attempt)
                    paths.clear()
                    self.gateway.raise_database_error(response)
                # Even a malformed success response may have committed. Resolve by upload ID.
                return await self.reconcile(user, house_id, upload_id, paths, attempt, stage, paired_entry_photo_id)
            except ApiError:
                # DB reconciliation manages its own cleanup (or preservation).
                if paths: await self.cleanup(paths, attempt)
                raise
            finally:
                if preview: preview.close()

    async def reconcile(self, user, house_id, upload_id, paths, attempt, stage='entry', paired_id=None, conflict=False):
        try:
            rows = await self.rows(house_id, user.token, upload_id, stage=None)
        except ApiError:
            logger.error('PHOTO_COMMIT_UNKNOWN attempt=%s', attempt)
            paths.clear()  # Preserve possibly committed objects; retry with same upload ID.
            raise ApiError(503, 'UPLOAD_CONFIRMATION_PENDING', '저장 여부 확인이 지연됩니다. 같은 사진을 다시 시도해 주세요.', True) from None
        if rows:
            row = rows[0]
            if row['photo_id'] != attempt:
                await self.cleanup(paths, attempt)
            paths.clear()
            self.check_upload_identity(row, stage, paired_id)
            return {'photo_id': row['photo_id'], 'upload_status': 'stored',
                    'already_uploaded': row['photo_id'] != attempt}
        await self.cleanup(paths, attempt)
        paths.clear()
        if conflict:
            raise ApiError(409, 'PHOTO_CONFLICT', '이미 퇴실 사진이 연결되었거나 업로드 ID가 중복되었습니다. 다시 조회해 주세요.')
        raise ApiError(502, 'DATABASE_SAVE_FAILED', '사진 기록 저장에 실패했습니다. 다시 시도해 주세요.', True)

    async def signed(self, path, user_id, house_id):
        # Generated paths only; signing is privileged and must stay inside the verified house.
        if not path.startswith(f'{user_id}/{house_id}/') or '..' in path.split('/'):
            raise ApiError(502, 'INVALID_PHOTO_PATH', '사진 경로를 확인할 수 없습니다.')
        response = await self.gateway.request('POST', f'/storage/v1/object/sign/{BUCKET}/{quote(path, safe="/")}',
                                              headers=self.headers(), json={'expiresIn': URL_TTL})
        if response.status_code >= 400:
            raise ApiError(502, 'STORAGE_SIGN_FAILED', '사진 표시 주소를 발급하지 못했습니다. 다시 조회해 주세요.', True)
        try:
            value = response.json()['signedURL']
            # Storage returns /object/sign/...; reject unexpected cross-origin responses.
            if not isinstance(value, str) or not value.startswith(f'/object/sign/{BUCKET}/'):
                raise ValueError()
            return self.gateway.settings.supabase_url + '/storage/v1' + value
        except (ValueError, KeyError, TypeError):
            raise ApiError(502, 'STORAGE_INVALID_RESPONSE', '사진 표시 주소를 확인할 수 없습니다.') from None

    async def listing(self, user):
        house = await self.gateway.record('houses', user.user_id, user.token)
        if not house: return []
        rows = await self.rows(house['house_id'], user.token)
        results = []
        for row in rows:
            analysis = row.pop('analyses', None)
            if isinstance(analysis, list): analysis = analysis[0] if analysis else None
            url = '' if row.get('deleting') else await self.signed(row.get('preview_path') or row['original_path'], user.user_id, house['house_id'])
            results.append({**row, 'signed_url': url,
                'signed_url_expires_at': datetime.now(timezone.utc) + timedelta(seconds=URL_TTL),
                'analysis': analysis, 'analysis_status': analysis['status'] if analysis else 'not_analyzed'})
        return results


    @staticmethod
    def check_upload_identity(row, stage, paired_id):
        if row['stage'] != stage or (stage == 'exit' and row.get('paired_entry_photo_id') != str(paired_id)):
            raise ApiError(409, 'UPLOAD_ID_CONFLICT', '다른 사진 등록에 사용한 업로드 ID입니다. 새 요청으로 등록해 주세요.')

    async def photo(self, house_id, token, photo_id, stage):
        response = await self.gateway.request('GET', '/rest/v1/photos', headers=self.headers(token),
            params={'select':'*,analyses(*)' if stage == 'entry' else '*', 'house_id':f'eq.{house_id}', 'photo_id':f'eq.{photo_id}', 'stage':f'eq.{stage}'})
        if response.status_code >= 400: self.gateway.raise_database_error(response)
        try:
            rows = response.json()
            if not isinstance(rows, list): raise ValueError()
            if not rows: raise ApiError(404, 'PHOTO_NOT_FOUND', '해당 주택의 본인 사진을 찾을 수 없습니다.')
            row = rows[0]
            if len(rows) != 1 or row['house_id'] != house_id or row['photo_id'] != str(photo_id) or row['stage'] != stage:
                raise ValueError()
            return row
        except (ValueError, KeyError, TypeError):
            raise ApiError(502, 'DATABASE_INVALID_RESPONSE', '사진 기록을 확인할 수 없습니다.') from None

    async def upload_exit(self, user, file, paired_id, upload_id):
        house = await self.house(user)
        entry = await self.photo(house['house_id'], user.token, paired_id, 'entry')
        if entry.get('deleting'):
            raise ApiError(409,'RESOURCE_DELETING','삭제 중인 입실 사진에는 퇴실 사진을 연결할 수 없습니다.')
        previous = await self.rows(house['house_id'], user.token, upload_id, stage=None)
        if previous:
            self.check_upload_identity(previous[0], 'exit', paired_id)
            return {'photo_id':previous[0]['photo_id'], 'upload_status':'stored', 'already_uploaded':True}
        paired = await self.rows(house['house_id'], user.token, stage='exit', paired_id=paired_id)
        if paired:
            raise ApiError(409, 'EXIT_ALREADY_EXISTS', '이 입실 사진에는 퇴실 사진이 이미 연결되어 있습니다.')
        return await self.upload(user, file, entry['location'], upload_id, 'exit', paired_id, house)

    async def exit_listing(self, user):
        house = await self.gateway.record('houses', user.user_id, user.token)
        if not house: return []
        rows = await self.rows(house['house_id'], user.token, stage='exit')
        results = []
        for row in rows:
            entry = await self.photo(house['house_id'], user.token, row['paired_entry_photo_id'], 'entry')
            if row['location'] != entry['location']:
                raise ApiError(502, 'INVALID_PHOTO_PAIR', '입실·퇴실 사진 연결 정보를 확인해 주세요.')
            comparison = row.pop('comparisons', None)
            if isinstance(comparison, list): comparison = comparison[0] if comparison else None
            if comparison and (comparison['exit_photo_id'] != row['photo_id'] or comparison['entry_photo_id'] != entry['photo_id']):
                raise ApiError(502, 'INVALID_PHOTO_PAIR', '저장된 비교 결과의 사진 연결을 확인해 주세요.')
            expires = datetime.now(timezone.utc) + timedelta(seconds=URL_TTL)
            entry_url = '' if entry.get('deleting') else await self.signed(entry.get('preview_path') or entry['original_path'], user.user_id, house['house_id'])
            exit_url = '' if row.get('deleting') else await self.signed(row.get('preview_path') or row['original_path'], user.user_id, house['house_id'])
            entry_analysis = entry.pop('analyses', None)
            if isinstance(entry_analysis, list): entry_analysis = entry_analysis[0] if entry_analysis else None
            results.append({**row, 'signed_url':exit_url, 'signed_url_expires_at':expires,
                'entry_signed_url':entry_url, 'entry_signed_url_expires_at':expires,
                'entry_photo':{**entry, 'signed_url':entry_url, 'signed_url_expires_at':expires,
                               'analysis_status':entry_analysis['status'] if entry_analysis else 'not_analyzed', 'analysis':entry_analysis},
                'analysis_status':'not_analyzed', 'analysis':None,
                'comparison':comparison, 'comparison_status':comparison['status'] if comparison else 'not_analyzed'})
        return results
