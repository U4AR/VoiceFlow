// Build dist/worker.js: one ES module (API + matching + browse page), for uploading without wrangler.
import { build } from 'esbuild';
await build({
  entryPoints: ['src/worker-single.js'], bundle: true, format: 'esm', target: 'es2022', outfile: process.env.OUT || 'dist/worker.js', minifyWhitespace: true, minifySyntax: true, minifyIdentifiers: false, legalComments: 'none',
  loader: { '.html': 'text' },
  plugins: [{ name: 'raw', setup(b) { b.onResolve({ filter: /\?raw$/ }, (a) => ({ path: new URL(a.path.replace(/\?raw$/, ''), 'file://' + a.resolveDir + '/').pathname, namespace: 'raw' })); b.onLoad({ filter: /.*/, namespace: 'raw' }, async (a) => ({ contents: (await import('node:fs')).readFileSync(a.path, 'utf8'), loader: 'text' })); } }],
});
console.log('built ' + (process.env.OUT || 'dist/worker.js'));
