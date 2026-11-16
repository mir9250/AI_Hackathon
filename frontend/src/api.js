export class ApiError extends Error {
  constructor(code, message, retryable = false, status = 0) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

// 서버가 보내는 오류 중 개발자용 문구를 사용자용 문장으로 바꿔 보여 줍니다.
const AI_OFF = 'AI 기능을 잠시 사용할 수 없어요. 잠시 후 다시 시도해 주세요.';
export const USER_MESSAGES = {
  VALIDATION_ERROR: '입력한 내용을 다시 확인해 주세요.',
  IMAGE_SIZE_LIMIT: '파일은 20MB 이하로 한 번에 하나씩 올려 주세요.',
  NOT_FOUND: '요청한 정보를 찾을 수 없어요.',
  HTTP_ERROR: '이 작업은 할 수 없어요.',
  INTERNAL_ERROR: '일시적인 문제가 생겼어요. 잠시 후 다시 시도해 주세요.',
  AUTH_INVALID_RESPONSE: '로그인 상태를 확인하지 못했어요. 다시 로그인해 주세요.',
  AI_SETUP_REQUIRED: AI_OFF, AI_NOT_CONFIGURED: AI_OFF, AI_DATABASE_ERROR: AI_OFF, AI_DATABASE_RESPONSE: AI_OFF,
  AI_CREDIT_REQUIRED: AI_OFF, AI_AUTH_ERROR: AI_OFF, AI_PERMISSION_ERROR: AI_OFF, AI_MODEL_UNAVAILABLE: AI_OFF,
  AI_UNAVAILABLE: AI_OFF, AI_RATE_LIMIT: AI_OFF, AI_SERVICE_ERROR: AI_OFF,
  AI_INVALID_RESPONSE: 'AI 분석 결과를 정리하지 못했어요. 다시 시도해 주세요.',
  DELETE_SETUP_REQUIRED: '지금은 삭제 기능을 사용할 수 없어요. 잠시 후 다시 시도해 주세요.',
  INVALID_PDF_TYPE: 'PDF 파일(.pdf)을 선택해 주세요.',
  UPLOAD_ID_CONFLICT: '같은 등록 요청이 이미 처리됐어요. 새로고침한 뒤 다시 시도해 주세요.',
  PHOTO_CONFLICT: '이미 연결된 사진이 있어요. 새로고침한 뒤 다시 확인해 주세요.',
  CONTRACT_SAVE_FAILED: '계약서 파일을 저장하지 못했어요. 같은 파일로 다시 시도해 주세요.',
};

export function createApi({ baseUrl, auth, fetcher = fetch, onSlow = () => {} }) {
  return async function api(path, { method = 'GET', body, signal, timeoutMs = 60000 } = {}) {
    const { data, error } = await auth.getSession();
    if (error || !data.session?.access_token) {
      throw new ApiError('AUTH_REQUIRED', '로그인 후 이용해 주세요.', false, 401);
    }
    const multipart = body instanceof FormData;
    const slow = setTimeout(() => onSlow(true), 4000);
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetcher(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${data.session.access_token}`,
          ...(body === undefined || multipart ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      let payload;
      try { payload = await response.json(); }
      catch { throw new ApiError('INVALID_RESPONSE', '일시적인 문제로 처리하지 못했어요. 잠시 후 다시 시도해 주세요.', true, response.status); }
      if (!response.ok) {
        throw new ApiError(payload.error?.code || 'API_ERROR',
          USER_MESSAGES[payload.error?.code] || payload.error?.message || '요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.', Boolean(payload.error?.retryable), response.status);
      }
      if (!Object.hasOwn(payload, 'data')) throw new ApiError('INVALID_RESPONSE', '일시적인 문제로 처리하지 못했어요. 잠시 후 다시 시도해 주세요.', true);
      return payload.data;
    } catch (error) {
      if (error instanceof ApiError || error.name === 'AbortError') throw error;
      if (error.name === 'TimeoutError') throw new ApiError('REQUEST_TIMEOUT', '응답이 늦어지고 있어요. 잠시 후 새로고침해서 결과를 확인해 주세요.', true);
      throw new ApiError('NETWORK_ERROR', '서비스에 연결할 수 없어요. 인터넷 연결을 확인하고 다시 시도해 주세요.', true);
    } finally {
      clearTimeout(slow);
      onSlow(false);
    }
  };
}
