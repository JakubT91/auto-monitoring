import { runNotifications } from './notifier.js';

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runNotifications(env).then(s => console.log('Scheduled:', JSON.stringify(s))));
  },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/run') {
      const key = url.searchParams.get('key');
      if (key !== env.MANUAL_TRIGGER_KEY) return new Response('Unauthorized', { status: 401 });
      const summary = await runNotifications(env);
      console.log('Notifications run:', JSON.stringify(summary));
      return new Response(JSON.stringify(summary), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('Auto monitoring Worker — use /run?key=...', { status: 200 });
  },
};
