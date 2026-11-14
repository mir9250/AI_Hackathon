export class ApiError extends Error {
  constructor(code, message, retryable = false, status = 0) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

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
      catch { throw new ApiError('INVALID_RESPONSE', '서버 응답을 확인할 수 없습니다.', true, response.status); }
      if (!response.ok) {
        throw new ApiError(payload.error?.code || 'API_ERROR',
          payload.error?.message || '요청 처리에 실패했습니다.', Boolean(payload.error?.retryable), response.status);
      }
      if (!Object.hasOwn(payload, 'data')) throw new ApiError('INVALID_RESPONSE', '응답에 데이터가 없습니다.', true);
      return payload.data;
    } catch (error) {
      if (error instanceof ApiError || error.name === 'AbortError') throw error;
      if (error.name === 'TimeoutError') throw new ApiError('REQUEST_TIMEOUT', '응답 대기 시간이 초과되었습니다. 저장된 분석 상태를 다시 조회해 주세요.', true);
      throw new ApiError('NETWORK_ERROR', '서버에 연결할 수 없습니다. 주소와 네트워크를 확인해 주세요.', true);
    } finally {
      clearTimeout(slow);
      onSlow(false);
    }
  };
}
