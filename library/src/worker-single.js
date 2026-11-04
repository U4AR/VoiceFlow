// The same Worker as worker.js, for a one-file upload (the Cloudflare dashboard or the API): the browse page is served
// from here instead of the assets binding (/flows-core.js points to the copy in the repo).
import worker from './worker.js';
import page from '../public/index.html';

const files = { '/': [page, 'text/html; charset=utf-8'], '/index.html': [page, 'text/html; charset=utf-8'] };
export default {
  async fetch(req, env, ctx) {
    const p = new URL(req.url).pathname;
    if (!p.startsWith('/api/')) {
      const f = files[p];
      if (p === '/flows-core.js') return Response.redirect('https://github.com/U4AR/voiceflow/blob/main/library/src/flows-core.js', 302);
      return f ? new Response(f[0], { headers: { 'content-type': f[1], 'cache-control': 'public, max-age=300' } }) : new Response('not found', { status: 404 });
    }
    return worker.fetch(req, env, ctx);
  },
};
