"""Draft contract uploads with RLS reads, immutable file slots and conditional finalization."""
import hashlib
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

from pypdf import PdfReader, apply_configuration
from pypdf.errors import PyPdfError, DependencyError
from starlette.concurrency import run_in_threadpool

from .errors import ApiError
from .photos import MAX_BYTES, URL_TTL, PhotoService, inspect_image

logger = logging.getLogger('app.contracts')
# Parser warnings may contain document fragments. Return only our safe error codes.
logging.getLogger('pypdf').setLevel(logging.CRITICAL)


def file_digest(file):
    file.seek(0)
    digest = hashlib.sha256()
    size = 0
    while chunk := file.read(256 * 1024):
        size += len(chunk)
        if size > MAX_BYTES:
            raise ApiError(422, 'FILE_SIZE_LIMIT', '파일은 20MiB 이하여야 합니다.')
        digest.update(chunk)
    file.seek(0)
    if not size: raise ApiError(422, 'EMPTY_FILE', '빈 파일은 등록할 수 없습니다.')
    return digest.hexdigest(), size


def inspect_pdf(file):
    if Path(file.filename or '').suffix.lower() != '.pdf' or file.content_type != 'application/pdf':
        raise ApiError(422, 'INVALID_PDF_TYPE', 'PDF 확장자와 application/pdf 형식의 파일을 선택해 주세요.')
    digest, size = file_digest(file.file)
    if file.file.read(5) != b'%PDF-':
        raise ApiError(422, 'INVALID_PDF', '실제 PDF 파일이 아닙니다.')
    file.file.seek(0)
    try:
        # Bounded parser work; do not extract text, images or execute document actions.
        with apply_configuration(zlib_maximum_output_length=32*1024*1024,
                                 stream_decoding_work_maximum_length=64*1024*1024,
                                 page_tree_maximum_entries=1000, page_tree_maximum_depth=30):
            with PdfReader(file.file, strict=True, xref_stream_maximum_entries=100000) as reader:
                if reader.is_encrypted:
                    raise ApiError(422, 'PDF_ENCRYPTED', '암호화된 PDF는 등록할 수 없습니다. 암호화하지 않은 원본을 선택해 주세요.')
                count = len(reader.pages)
                if not 1 <= count <= 20:
                    raise ApiError(422, 'PDF_PAGE_LIMIT', 'PDF는 1~20페이지여야 합니다.')
                for page in reader.pages:
                    if float(page.mediabox.width) <= 0 or float(page.mediabox.height) <= 0:
                        raise ValueError()
                    content = page.get_contents()
                    if content is not None:
                        # Parse page drawing operations without text extraction or rendering.
                        _ = content.operations
    except ApiError:
        raise
    except DependencyError:
        raise ApiError(422, 'PDF_ENCRYPTED', '암호화된 PDF는 등록할 수 없습니다.') from None
    except (NotImplementedError, PyPdfError, OSError, ValueError, TypeError, KeyError, IndexError, RecursionError, OverflowError):
        raise ApiError(422, 'INVALID_PDF', '손상되었거나 처리할 수 없는 PDF입니다. 정상 PDF로 다시 저장해 주세요.') from None
    file.file.seek(0)
    return digest, size, count


class ContractService:
    def __init__(self, gateway, processing_lock):
        self.gateway = gateway
        self.files = PhotoService(gateway, processing_lock)

    async def rows(self, house_id, token, contract_id=None, upload_id=None):
        params = {'select':'*,contract_pages(*),contract_analyses(*)', 'house_id':f'eq.{house_id}',
                  'order':'created_at.desc,contract_id.desc'}
        if contract_id: params['contract_id'] = f'eq.{contract_id}'
        if upload_id: params['upload_id'] = f'eq.{upload_id}'
        response = await self.gateway.request('GET', '/rest/v1/contracts', headers=self.files.headers(token), params=params)
        if response.status_code >= 400: self.gateway.raise_database_error(response)
        try:
            rows = response.json()
            if not isinstance(rows, list): raise ValueError()
            for row in rows:
                if row['house_id'] != house_id or (contract_id and row['contract_id'] != str(contract_id)) or (upload_id and row['upload_id'] != str(upload_id)):
                    raise ValueError()
                pages = row.get('contract_pages') or []
                if len(pages) > 10 or any(p['contract_id'] != row['contract_id'] for p in pages): raise ValueError()
                row['contract_pages'] = sorted(pages, key=lambda p:p['page_number'])
            return rows
        except (ValueError, KeyError, TypeError):
            raise ApiError(502, 'DATABASE_INVALID_RESPONSE', '계약서 기록을 확인할 수 없습니다.') from None

    async def owned(self, user, contract_id):
        house = await self.files.house(user)
        rows = await self.rows(house['house_id'], user.token, contract_id)
        if not rows: raise ApiError(404, 'CONTRACT_NOT_FOUND', '본인 주택에 등록된 계약서를 찾을 수 없습니다.')
        if len(rows) != 1: raise ApiError(502, 'DATABASE_INVALID_RESPONSE', '계약서 기록을 확인할 수 없습니다.')
        return rows[0], house

    @staticmethod
    def summary(row, house):
        analysis = row.get('contract_analyses')
        if isinstance(analysis, list): analysis = analysis[0] if analysis else None
        if analysis and analysis['contract_id'] != row['contract_id']:
            raise ApiError(502, 'DATABASE_INVALID_RESPONSE', '계약서 분석 연결을 확인할 수 없습니다.')
        metadata = {k:v for k,v in row.items() if k not in {'contract_pages','contract_analyses'}}
        return {**metadata, 'house':house, 'uploaded_page_count':len(row['contract_pages']) if row['source_type']=='images' else row.get('page_count') or 0,
                'analysis':analysis, 'analysis_status':analysis['status'] if analysis else 'not_analyzed'}

    async def create(self, user, source_type, upload_id):
        house = await self.files.house(user)
        previous = await self.rows(house['house_id'], user.token, upload_id=upload_id)
        if not previous:
            values = {'contract_id':str(uuid4()), 'house_id':house['house_id'], 'source_type':source_type,
                      'upload_id':str(upload_id), 'upload_status':'draft'}
            try:
                response = await self.gateway.request('POST', '/rest/v1/contracts',
                    headers={**self.files.headers(), 'Prefer':'return=representation'}, json=values)
                if response.status_code >= 400 and response.status_code != 409 and response.status_code < 500:
                    self.gateway.raise_database_error(response)
            except ApiError as error:
                if error.status < 500: raise
            # Reconcile success, unique conflicts and possibly committed timeouts by upload_id.
            previous = await self.rows(house['house_id'], user.token, upload_id=upload_id)
            if not previous:
                raise ApiError(502, 'CONTRACT_CREATE_FAILED', '계약서 등록 작업 저장을 확인하지 못했습니다. 같은 요청을 다시 시도해 주세요.', True)
        if previous[0]['source_type'] != source_type:
            raise ApiError(409, 'UPLOAD_ID_CONFLICT', '다른 등록 방식에 사용한 업로드 ID입니다.')
        return self.summary(previous[0], house)

    @staticmethod
    def draft(row, source_type=None):
        if row['upload_status'] != 'draft':
            raise ApiError(409, 'CONTRACT_NOT_DRAFT', '등록 완료되었거나 삭제 중인 계약서에는 파일을 추가하거나 교체할 수 없습니다.')
        if source_type and row['source_type'] != source_type:
            raise ApiError(409, 'CONTRACT_SOURCE_MISMATCH', '계약서 등록 방식과 파일 종류가 일치하지 않습니다.')

    @staticmethod
    def slot(row, page_number):
        if page_number is None:
            return {'original_path':row['original_path']} if row.get('original_path') else None
        return next((p for p in row['contract_pages'] if p['page_number']==page_number), None)

    @staticmethod
    def same_content(path, digest):
        # Content hash is in a server-generated path segment; no new DB column needed.
        return len(path.split('/')) >= 4 and path.split('/')[-3] == digest

    @staticmethod
    def receipt(row, page_number, existing):
        page = ContractService.slot(row, page_number)
        return {'contract_id':row['contract_id'], 'page_id':page.get('page_id') if page else None,
                'page_number':page_number, 'page_count':row.get('page_count'),
                'upload_status':row['upload_status'], 'stored':True, 'already_uploaded':existing}

    async def upload(self, user, contract_id, file, page_number=None):
        row, house = await self.owned(user, contract_id)
        source_type = 'pdf' if page_number is None else 'images'
        self.draft(row, source_type)
        async with self.files.processing_lock:
            row, house = await self.owned(user, contract_id)
            self.draft(row, source_type)
            preview = None
            if source_type == 'pdf':
                digest, size, count = await run_in_threadpool(inspect_pdf, file)
                mime = 'application/pdf'
            else:
                mime, size, preview = await run_in_threadpool(inspect_image, file)
                try: digest, _ = await run_in_threadpool(file_digest, file.file)
                except BaseException:
                    if preview: preview.close()
                    raise
                count = None
            try:
                previous = self.slot(row, page_number)
                if previous:
                    if self.same_content(previous['original_path'], digest): return self.receipt(row, page_number, True)
                    raise ApiError(409, 'CONTRACT_FILE_EXISTS', '해당 PDF 또는 페이지 번호에는 다른 파일이 이미 저장되어 있습니다. 교체할 수 없습니다.')
                attempt = str(uuid4())
                slot = 'pdf' if source_type == 'pdf' else f'page-{page_number}'
                prefix = f'{user.user_id}/{house["house_id"]}/contracts/{contract_id}/{slot}/{digest}/{attempt}'
                path = f'{prefix}/original{Path(file.filename).suffix.lower()}'
                paths = []
                try:
                    paths.append(path)
                    await self.files.upload_object(path, file.file, mime)
                    if preview:
                        paths.append(f'{prefix}/preview.jpg')
                        await self.files.upload_object(paths[-1], preview, 'image/jpeg')
                    try:
                        if source_type == 'pdf':
                            response = await self.gateway.request('PATCH','/rest/v1/contracts',
                                headers={**self.files.headers(), 'Prefer':'return=representation'},
                                params={'contract_id':f'eq.{contract_id}', 'house_id':f'eq.{house["house_id"]}',
                                    'source_type':'eq.pdf','upload_status':'eq.draft','original_path':'is.null'},
                                json={'original_path':path,'page_count':count})
                        else:
                            response = await self.gateway.request('POST','/rest/v1/contract_pages',
                                headers={**self.files.headers(), 'Prefer':'return=representation'},
                                json={'page_id':attempt,'contract_id':str(contract_id),'page_number':page_number,
                                      'original_path':path,'mime_type':mime,'size_bytes':size})
                        status = response.status_code
                    except ApiError:
                        status = 503
                    try:
                        current, _ = await self.owned(user, contract_id)
                    except ApiError:
                        logger.error('CONTRACT_COMMIT_UNKNOWN attempt=%s', attempt)
                        paths.clear()  # Never delete an object whose DB commit is uncertain.
                        raise ApiError(503,'UPLOAD_CONFIRMATION_PENDING','저장 확인이 지연됩니다. 같은 파일과 페이지 번호로 다시 시도해 주세요.',True) from None
                    saved = self.slot(current, page_number)
                    if saved:
                        if saved['original_path'] != path: await self.files.cleanup(paths, attempt)
                        paths.clear()
                        if self.same_content(saved['original_path'], digest):
                            return self.receipt(current, page_number, saved['original_path'] != path)
                        raise ApiError(409,'CONTRACT_FILE_EXISTS','같은 페이지에 다른 파일이 먼저 저장되었습니다. 다시 조회해 주세요.')
                    await self.files.cleanup(paths, attempt)
                    paths.clear()
                    if current['upload_status'] != 'draft' or status in {400,409}:
                        raise ApiError(409,'CONTRACT_STATE_CONFLICT','계약서 상태가 변경되었습니다. 다시 조회해 주세요.')
                    raise ApiError(502,'CONTRACT_SAVE_FAILED','파일의 DB 기록 저장에 실패했습니다. 같은 파일을 다시 시도해 주세요.',True)
                except ApiError as error:
                    if paths: await self.files.cleanup(paths, attempt)
                    if error.detail.code == 'STORAGE_UPLOAD_FAILED':
                        raise ApiError(502,'CONTRACT_STORAGE_FAILED','계약서 파일 저장에 실패했습니다. 다시 시도해 주세요.',True) from None
                    raise
            finally:
                if preview: preview.close()

    async def complete(self, user, contract_id, confirmed):
        if not confirmed:
            raise ApiError(422,'PAGES_CONFIRMATION_REQUIRED','전체 페이지를 업로드했는지 직접 확인한 뒤 체크해 주세요.')
        row, house = await self.owned(user, contract_id)
        if row['upload_status']=='ready': return self.summary(row, house)
        self.draft(row)
        if row['source_type']=='pdf':
            count = row.get('page_count')
            if not row.get('original_path') or not count or not 1 <= count <= 20:
                raise ApiError(409,'CONTRACT_INCOMPLETE','유효한 PDF를 먼저 업로드해 주세요.')
        else:
            numbers = [p['page_number'] for p in row['contract_pages']]
            if not numbers or len(numbers)>10 or numbers != list(range(1,len(numbers)+1)):
                raise ApiError(409,'CONTRACT_INCOMPLETE','이미지 페이지를 1부터 빠짐없이 연속된 번호로 업로드해 주세요.')
            count = len(numbers)
        params = {'contract_id':f'eq.{contract_id}','house_id':f'eq.{house["house_id"]}', 'upload_status':'eq.draft'}
        if row['source_type']=='pdf': params['original_path'] = f'eq.{row["original_path"]}'
        try:
            response = await self.gateway.request('PATCH','/rest/v1/contracts',
                headers={**self.files.headers(), 'Prefer':'return=representation'}, params=params,
                json={'upload_status':'ready','page_count':count})
            if response.status_code >= 400 and response.status_code < 500:
                raise ApiError(409,'CONTRACT_STATE_CONFLICT','계약서 상태나 페이지 구성이 변경되었습니다. 다시 조회해 주세요.')
        except ApiError as error:
            if error.status < 500: raise
        current, house = await self.owned(user, contract_id)
        if current['upload_status']!='ready':
            raise ApiError(503,'CONTRACT_COMPLETE_UNCONFIRMED','등록 완료 여부를 확인하지 못했습니다. 다시 조회해 주세요.',True)
        return self.summary(current, house)

    async def listing(self, user):
        house = await self.gateway.record('houses',user.user_id,user.token)
        if not house: return []
        return [self.summary(row, house) for row in await self.rows(house['house_id'],user.token)]

    async def detail(self, user, contract_id):
        row, house = await self.owned(user, contract_id)
        result = {**self.summary(row, house), 'signed_url':None,'signed_url_expires_at':None,'pages':[]}
        if row['upload_status']=='deleting':
            return result  # Retain metadata for retry; don't sign partially removed files.
        async def sign(path):
            if not path.startswith(f'{user.user_id}/{house["house_id"]}/contracts/{contract_id}/'):
                raise ApiError(502,'INVALID_CONTRACT_PATH','계약서 파일 경로를 확인할 수 없습니다.')
            return await self.files.signed(path,user.user_id,house['house_id'])
        if row.get('original_path'):
            result['signed_url'] = await sign(row['original_path'])
            result['signed_url_expires_at'] = datetime.now(timezone.utc)+timedelta(seconds=URL_TTL)
        for page in row['contract_pages']:
            original_url = await sign(page['original_path'])
            url = original_url
            if page['mime_type'] in {'image/heic','image/heif'}:
                url = await sign(page['original_path'].rsplit('/',1)[0]+'/preview.jpg')
            result['pages'].append({**page,'signed_url':url,'original_signed_url':original_url,
                'signed_url_expires_at':datetime.now(timezone.utc)+timedelta(seconds=URL_TTL)})
        return result
