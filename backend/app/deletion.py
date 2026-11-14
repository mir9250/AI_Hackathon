"""Resumable exact-object deletion. Durable DB flags precede all Storage operations."""
from pathlib import PurePosixPath
from urllib.parse import quote
from uuid import UUID

from .errors import ApiError
from .photos import PhotoService,BUCKET


class DeletionService:
    def __init__(self,gateway,lock):
        self.gateway=gateway
        self.files=PhotoService(gateway,lock)

    async def rpc(self,name,data):
        response=await self.gateway.request('POST','/rest/v1/rpc/'+name,headers=self.files.headers(),json=data)
        if response.status_code>=400:
            try:code=response.json().get('code')
            except (ValueError,AttributeError):code=None
            if code in {'PGRST202','42883','42703'}:
                raise ApiError(503,'DELETE_SETUP_REQUIRED','삭제 기능용 005 SQL을 먼저 적용해 주세요.')
            if code in {'55000','40P01','40001'}:
                raise ApiError(409,'DELETE_CONFLICT','다른 작업과 충돌했습니다. 다시 조회한 뒤 삭제를 재시도해 주세요.',True)
            raise ApiError(503,'DELETE_DATABASE_FAILED','삭제 상태를 확인하지 못했습니다. 같은 삭제 요청으로 재시도해 주세요.',True)
        try:
            result=response.json()
            if not isinstance(result,dict) or not isinstance(result.get('action'),str):raise ValueError()
            return result
        except ValueError:
            raise ApiError(502,'DELETE_INVALID_RESPONSE','삭제 상태 응답을 확인하지 못했습니다.',True) from None

    @staticmethod
    def paths(user,kind,resource_id,manifest):
        try:house=str(UUID(manifest['house_id']))
        except (KeyError,ValueError,TypeError):
            raise ApiError(502,'DELETE_PATH_INVALID','삭제 대상 주택을 확인할 수 없어 중단했습니다.') from None
        prefix=f'{user.user_id}/{house}/'
        paths=[]
        def add(path,contract=False,expected_id=None,expected_slot=None):
            if not isinstance(path,str) or not path.startswith(prefix) or any(x in {'','.','..'} for x in path.split('/')) or '\\' in path:
                raise ValueError()
            parts=path[len(prefix):].split('/')
            if contract:
                if len(parts)!=6 or parts[:2]!=['contracts',str(resource_id)] or parts[2]!=expected_slot or len(parts[3])!=64 or any(c not in '0123456789abcdef' for c in parts[3]):
                    raise ValueError()
                attempt=str(UUID(parts[-2]))
                if expected_id is not None and attempt!=str(expected_id):raise ValueError()
            else:
                if len(parts)!=2:raise ValueError()
                if str(UUID(parts[0]))!=str(expected_id):raise ValueError()
            if not (parts[-1]=='preview.jpg' or (PurePosixPath(path).stem=='original' and PurePosixPath(path).suffix in {'.jpg','.jpeg','.png','.heic','.webp','.pdf'})):
                raise ValueError()
            paths.append(path)
        try:
            if kind=='photo':
                rows=manifest['photos']
                target=next(p for p in rows if p['photo_id']==str(resource_id))
                if not 1<=len(rows)<=2:raise ValueError()
                for row in rows:
                    if row['house_id']!=house or not row['deleting']:raise ValueError()
                    if row is not target and (target['stage']!='entry' or row['paired_entry_photo_id']!=str(resource_id) or row['stage']!='exit'):raise ValueError()
                    add(row['original_path'],expected_id=row['photo_id'])
                    if row.get('preview_path'):
                        if row['preview_path']!=row['original_path'].rsplit('/',1)[0]+'/preview.jpg':raise ValueError()
                        add(row['preview_path'],expected_id=row['photo_id'])
            else:
                row=manifest['contract']
                if row['contract_id']!=str(resource_id) or row['house_id']!=house or row['upload_status']!='deleting':raise ValueError()
                if row.get('original_path'):add(row['original_path'],True,expected_slot='pdf')
                for page in manifest['pages']:
                    if page['contract_id']!=str(resource_id):raise ValueError()
                    slot=f'page-{page["page_number"]}'
                    add(page['original_path'],True,expected_id=page['page_id'],expected_slot=slot)
                    if page['mime_type'] in {'image/heic','image/heif'}:
                        add(page['original_path'].rsplit('/',1)[0]+'/preview.jpg',True,expected_id=page['page_id'],expected_slot=slot)
            return list(dict.fromkeys(paths))
        except (KeyError,ValueError,TypeError,StopIteration):
            raise ApiError(502,'DELETE_PATH_INVALID','삭제 대상 파일 경로를 확인할 수 없어 중단했습니다.') from None

    async def remove(self,user,kind,resource_id,expected_exit=None):
        args={'p_user_id':user.user_id,'p_kind':kind,'p_id':str(resource_id)}
        plan=await self.rpc('begin_resource_deletion',{**args,'p_expected_exit':str(expected_exit) if expected_exit else None})
        action=plan['action']
        if action=='gone':return {'deleted':True,'already_deleted':True}
        if action=='forbidden':raise ApiError(404,'RESOURCE_NOT_FOUND','삭제할 본인 자료를 찾을 수 없습니다.')
        if action in {'busy','parent_deleting','confirmation_changed'}:
            message={'busy':'AI 분석 중에는 삭제할 수 없습니다. 분석 종료 후 다시 시도해 주세요.',
                     'parent_deleting':'연결된 입실 사진이 삭제 중입니다. 입실 사진 삭제를 재시도해 주세요.',
                     'confirmation_changed':'연결된 퇴실 사진이 변경되었습니다. 다시 조회하고 삭제 대상을 확인해 주세요.'}[action]
            raise ApiError(409,'DELETE_'+action.upper(),message,True)
        if action!='prepared':raise ApiError(409,'DELETE_CONFLICT','자료 상태를 다시 확인해 주세요.',True)
        paths=self.paths(user,kind,resource_id,plan)
        if paths:
            response=await self.gateway.request('DELETE',f'/storage/v1/object/{BUCKET}',headers=self.files.headers(),json={'prefixes':paths})
            if response.status_code>=400:
                raise ApiError(503,'DELETE_STORAGE_FAILED','파일 삭제가 완료되지 않았습니다. 같은 삭제 버튼으로 재시도해 주세요.',True)
            # Validate absence even after a 200/partial response. Never drop the DB manifest prematurely.
            for path in paths:
                response=await self.gateway.request('GET',f'/storage/v1/object/info/{BUCKET}/{quote(path,safe="/")}',headers=self.files.headers())
                missing=False
                if response.status_code in {400,404}:
                    try:missing=response.json().get('code')=='NoSuchKey'
                    except (ValueError,AttributeError):pass
                if not missing:
                    raise ApiError(503,'DELETE_STORAGE_UNCONFIRMED','일부 파일의 삭제를 확인하지 못했습니다. 삭제를 재시도해 주세요.',True)
        finished=await self.rpc('finish_resource_deletion',args)
        if finished['action']!='deleted':raise ApiError(409,'DELETE_CONFLICT','삭제 상태가 변경되었습니다. 다시 조회해 주세요.',True)
        return {'deleted':True,'already_deleted':False}
