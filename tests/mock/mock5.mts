// Test-only mock Meta API. The agent's script is chosen by the task text ([{match, steps}]); each step is picked by
// the number of earlier assistant turns. Every request is logged (kind, task) to DUMP_DIR/requests.jsonl.
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { startMockMeta } from '/home/claude/voice-agent/packages/meta-client/mock/server.ts';
const rules: Array<{ match: string; reply?: string }> = JSON.parse(readFileSync(process.env.MOCK_CHAT_RULES!, 'utf8'));
const scripts: Array<{ match: string; steps: any[] }> = JSON.parse(readFileSync(process.env.MOCK_SCRIPT!, 'utf8'));
const dir = process.env.DUMP_DIR!;
mkdirSync(dir, { recursive: true });
const firstUser = (msgs: any[]) => {
  const u = msgs.find((m) => m.role === 'user');
  const c = u && u.content;
  return typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => p.text || '').join(' ') : '';
};
const mock = await startMockMeta({
  chat: (body) => {
    const msgs = body.messages ?? [];
    const text = JSON.stringify(msgs);
    if (/Your user-given name is/.test(text)) {
      const task = firstUser(msgs);
      const sc = scripts.find((s) => new RegExp(s.match, 'is').test(task)) || { match: '', steps: [] };
      const step = msgs.filter((m: any) => m.role === 'assistant').length;
      const key = createHash('sha1').update(task).digest('hex').slice(0, 8);
      writeFileSync(`${dir}/${key}-step-${String(step + 1).padStart(2, '0')}.json`, JSON.stringify(body));
      appendFileSync(`${dir}/requests.jsonl`, JSON.stringify({ at: Date.now(), kind: 'agent', task: task.slice(0, 80), step: step + 1, tools: (body.tools || []).map((t: any) => t.function?.name || t.name) }) + '\n');
      const s = sc.steps[step] ?? { text: 'Done.' };
      return s.tool ? { toolCalls: [{ name: s.tool, arguments: s.args ?? {} }] } : { text: s.text };
    }
    const rule = rules.find((r) => new RegExp(r.match, 's').test(text));
    const kind = /Decide whether a browser task/.test(text) ? 'judge' : /Classify the user request/.test(text) ? 'router' : /You distinguish spoken/.test(text) ? 'interpreter' : 'other';
    appendFileSync(`${dir}/requests.jsonl`, JSON.stringify({ at: Date.now(), kind, rule: rule ? rule.match.slice(0, 40) : null }) + '\n');
    return { text: rule ? rule.reply : 'OK' };
  },
  port: Number(process.env.PORT),
  apiKey: process.env.MOCK_KEY!,
  transcript: process.env.MOCK_TRANSCRIPT ?? 'hello world',
});
console.log('mock5 on', mock.baseUrl);
