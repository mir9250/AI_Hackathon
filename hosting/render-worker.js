export const UPSTREAM = 'https://ai-hackathon-nd4y.onrender.com';
const LIMIT = 21 * 1024 * 1024;
const error = (status, code, message) => Response.json({ error: { code, message, retryable: status >= 500 } }, { status });
export function createWorker(assets, upstreamFetch = fetch) {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/')) {
        if (!['GET','POST','PUT','DELETE','OPTIONS'].includes(request.method)) return error(405,'METHOD_NOT_ALLOWED','허용되지 않은 요청입니다.');
        if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
        const origin = request.headers.get('origin');
        if (origin && origin !== url.origin) return error(403,'FORBIDDEN','이 사이트에서 요청해 주세요.');
        const auth = request.headers.get('authorization');
        if (url.pathname !== '/api/health' && !auth?.startsWith('Bearer ')) return error(401,'AUTH_REQUIRED','로그인 후 이용해 주세요.');
        if (Number(request.headers.get('content-length')) > LIMIT) return error(422,'IMAGE_SIZE_LIMIT','파일은 20MiB 이하로 하나씩 전송해 주세요.');
        const headers = new Headers();
        for (const name of ['authorization','content-type','accept']) {
          const value = request.headers.get(name); if (value) headers.set(name,value);
        }
        let body, size = 0, tooLarge = false;
        if (!['GET','HEAD'].includes(request.method) && request.body) {
          body = request.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
            size += chunk.byteLength;
            if (size > LIMIT) { tooLarge = true; throw new Error('body limit'); }
            controller.enqueue(chunk);
          } }));
        }
        try {
          const response = await upstreamFetch(UPSTREAM + url.pathname + url.search, {
            method: request.method, headers, body, redirect:'manual', signal: request.signal,
            ...(body ? { duplex: 'half' } : {}),
          });
          if (response.status >= 300 && response.status < 400) return error(502,'UPSTREAM_REDIRECT','서버 응답을 확인할 수 없습니다.');
          const outgoing = new Headers({ 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' });
          for (const name of ['content-type','www-authenticate','retry-after']) {
            const value = response.headers.get(name); if (value) outgoing.set(name,value);
          }
          return new Response(response.body,{status:response.status,headers:outgoing});
        } catch {
          return tooLarge ? error(422,'IMAGE_SIZE_LIMIT','파일은 20MiB 이하로 하나씩 전송해 주세요.') : error(503,'UPSTREAM_UNAVAILABLE','서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.');
        }
      }
      if (!['GET','HEAD'].includes(request.method)) return error(405,'METHOD_NOT_ALLOWED','허용되지 않은 요청입니다.');
      const asset = assets[url.pathname === '/' ? '/index.html' : url.pathname];
      if (!asset) return new Response('Not found',{status:404});
      const bytes = Uint8Array.from(atob(asset.data), c=>c.charCodeAt(0));
      return new Response(request.method === 'HEAD' ? null : bytes, {headers:{'Content-Type':asset.type,'Cache-Control':url.pathname.startsWith('/assets/')?'public,max-age=31536000,immutable':'no-cache','X-Content-Type-Options':'nosniff'}});
    },
  };
}
