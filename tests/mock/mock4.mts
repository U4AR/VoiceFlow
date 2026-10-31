// Test-only mock Meta API. Non-agent requests use rules ([{match, reply}]); the agent follows SCRIPT step by step
// (the step is the number of earlier assistant turns in the request), so two runs take identical actions.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { startMockMeta } from '/home/claude/voice-agent/packages/meta-client/mock/server.ts';
const rules: Array<{ match: string; reply?: string }> = JSON.parse(readFileSync(process.env.MOCK_CHAT_RULES!, 'utf8'));
const script: Array<{ tool?: string; args?: unknown; text?: string }> = JSON.parse(readFileSync(process.env.MOCK_SCRIPT!, 'utf8'));
const dir = process.env.DUMP_DIR!;
mkdirSync(dir, { recursive: true });
const mock = await startMockMeta({
  chat: (body) => {
    const text = JSON.stringify(body.messages ?? []);
    if (/Your user-given name is/.test(text)) {
      const step = (body.messages ?? []).filter((m: any) => m.role === 'assistant').length;
      writeFileSync(`${dir}/step-${String(step + 1).padStart(2, '0')}.json`, JSON.stringify(body));
      const s = script[step] ?? { text: 'Done.' };
      return s.tool ? { toolCalls: [{ name: s.tool, arguments: s.args ?? {} }] } : { text: s.text };
    }
    const rule = rules.find((r) => new RegExp(r.match, 's').test(text));
    return { text: rule ? rule.reply : 'OK' };
  },
  port: Number(process.env.PORT),
  apiKey: process.env.MOCK_KEY!,
  transcript: process.env.MOCK_TRANSCRIPT ?? 'hello world',
});
console.log('mock4 on', mock.baseUrl);
