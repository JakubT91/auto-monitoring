import { runNotifications } from './notifier.js';

export default {
  // Cron trigger – běží podle wrangler.toml (denně 7 UTC)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runNotifications(env));
  },

  // HTTP endpoint pro manuální spuštění (testování + admin trigger)
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/run') {
      const key = url.searchParams.get('key');
      if (!env.MANUAL_TRIGGER_KEY || key !== env.MANUAL_TRIGGER_KEY) {
        return new Response('Unauthorized\n', { status: 401 });
      }
      const result = await runNotifications(env);
      return Response.json(result, {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    return new Response(
      'Cestak notifications worker.\n\n' +
      'POST /run?key=<MANUAL_TRIGGER_KEY> for manual trigger.\n' +
      'Cron runs daily at 07:00 UTC.\n',
      {
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      }
    );
  },
};
