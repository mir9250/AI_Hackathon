// Local-only gateway. Never included by scripts/build.mjs or Sites hosting.
import worker from '../dist/server/index.js';
export default {fetch(request,env,ctx){
  const headers=new Headers(request.headers);
  const token=headers.get('x-local-test-token');
  const user=headers.get('x-local-test-user');
  headers.delete('oai-authenticated-user-id');
  headers.delete('oai-authenticated-user-email');
  headers.delete('x-local-test-token');headers.delete('x-local-test-user');
  // Only the isolated test runner supplies this random, per-process binding.
  if(env.LOCAL_TEST_TOKEN&&token===env.LOCAL_TEST_TOKEN&&/^[a-z]+$/.test(user||'')){
    headers.set('oai-authenticated-user-id',user);
    headers.set('oai-authenticated-user-email',user+'@example.invalid');
  }
  return worker.fetch(new Request(request,{headers}),env,ctx);
}};
