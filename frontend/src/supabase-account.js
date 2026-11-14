import { ApiError } from './api.js';

// Transitional direct connection for account records only. RLS remains authoritative.
// File uploads and AI stay on the FastAPI backend; never expose its secret key here.
export function createSupabaseAccountApi(client) {
  return async (path, { method = 'GET', body, signal } = {}) => {
    const { data, error: authError } = await client.auth.getUser();
    if (authError || !data.user) throw new ApiError('AUTH_REQUIRED', '다시 로그인해 주세요.', false, 401);
    const table = path === '/api/profile' ? 'profiles' : path === '/api/house' ? 'houses' : null;
    if (!table) throw new ApiError('BACKEND_REQUIRED', '사진·계약서 저장과 AI 분석은 서버 연결을 준비 중입니다. 로그인·프로필·나의 집 저장은 사용할 수 있습니다.');
    if (!['GET', 'PUT'].includes(method)) throw new ApiError('METHOD_NOT_ALLOWED', '허용되지 않은 요청입니다.');
    let query;
    if (method === 'PUT') {
      const fields = table === 'profiles' ? ['display_name'] : ['name', 'address'];
      const values = Object.fromEntries(fields.map(key => [key, String(body?.[key] || '').trim()]));
      if (Object.entries(values).some(([key,value]) => !value || value.length > (key === 'address' ? 500 : 80))) {
        throw new ApiError('VALIDATION_ERROR', '이름은 1~80자, 주소는 1~500자로 입력해 주세요.');
      }
      query = client.from(table).upsert({ ...values, user_id: data.user.id }, { onConflict: 'user_id' }).select('*');
    } else query = client.from(table).select('*').eq('user_id', data.user.id);
    if (signal) query = query.abortSignal(signal);
    const { data: row, error } = await query.maybeSingle();
    if (error) throw new ApiError('DATABASE_ERROR', '정보를 저장·조회하지 못했습니다. 연결 상태를 확인해 주세요.', true);
    if (row && row.user_id !== data.user.id) throw new ApiError('FORBIDDEN', '본인 기록만 조회할 수 있습니다.');
    return row;
  };
}
