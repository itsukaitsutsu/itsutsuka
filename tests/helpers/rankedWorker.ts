// TEST ONLY: privileged inspection and deterministic deadline expiry. Never deployed.
import { readRoom, writeRoom } from '../../worker/roomStorage';
import { MatchRoom } from '../../worker/matchRoom';
export class TestMatchRoom extends MatchRoom {
  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer) {
    await super.webSocketMessage(socket, raw);
    if (typeof raw === 'string') {
      try { const m = JSON.parse(raw); if (m.type === 'test_sync') socket.send(JSON.stringify({ type: 'test_sync_ack', requestId: m.requestId })); } catch { /* invalid test packet */ }
    }
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/inspect') return Response.json(await readRoom(this.ctx.storage));
    if (url.pathname === '/legacy-snapshot') {
      const room = await readRoom<any>(this.ctx.storage); delete room.rulesVersion;
      await writeRoom(this.ctx.storage, room); return Response.json({ ok: true });
    }
    if (url.pathname === '/remove-review-setting') {
      const room = await readRoom<any>(this.ctx.storage); delete room.reviewMs;
      await writeRoom(this.ctx.storage, room); return Response.json({ ok: true });
    }
    if (url.pathname === '/alarm-status') return Response.json(await this.ctx.storage.getAlarm());
    if (url.pathname === '/interrupt-early-settlement' || url.pathname === '/interrupt-afk-settlement') {
      // Run the real control handler, but simulate interruption after durable intent and before D1.
      const self = this as any, finish = self.finish;
      self.finish = async () => {
        await this.ctx.storage.setAlarm(Date.now() + 60000);
        throw new Error('Injected interruption before settlement');
      };
      try {
        const socket = this.ctx.getWebSockets().find(s => s.deserializeAttachment().uid === url.searchParams.get('uid'))!;
        let raw = await request.text();
        if (url.pathname === '/interrupt-afk-settlement') {
          const room = await readRoom<any>(this.ctx.storage); room.surrender.deadline = Date.now() - 1; room.deadline = Date.now() + 10000;
          await writeRoom(this.ctx.storage, room); raw = JSON.stringify({ type: 'sync' });
        }
        await super.webSocketMessage(socket, raw);
      } finally { self.finish = finish; }
      return Response.json({ ok: true });
    }
    if (url.pathname === '/expire-with-abort') {
      const room = await readRoom<any>(this.ctx.storage); room.deadline = Date.now() - 1;
      await writeRoom(this.ctx.storage, room);
      const socket = this.ctx.getWebSockets().find(s => s.deserializeAttachment().uid === url.searchParams.get('uid'))!;
      await super.webSocketMessage(socket, JSON.stringify({ type: 'abort' })); return Response.json({ ok: true });
    }
    if (url.pathname === '/expire-consent' || url.pathname === '/expire-both-deadlines') {
      const room = await readRoom<any>(this.ctx.storage);
      room.surrender.deadline = Date.now() - 1;
      room.deadline = url.pathname === '/expire-both-deadlines' ? Date.now() - 1000 : Date.now() + 10000;
      await writeRoom(this.ctx.storage, room);
      if (request.method === 'POST') {
        const socket = this.ctx.getWebSockets().find(s => s.deserializeAttachment().uid === url.searchParams.get('uid'))!;
        await super.webSocketMessage(socket, await request.text());
      } else await super.alarm();
      return Response.json({ ok: true });
    }
    if (url.pathname === '/expire') {
      const room = await readRoom<any>(this.ctx.storage);
      room.deadline = Date.now() - 1;
      await writeRoom(this.ctx.storage, room);
      await super.alarm(); return Response.json({ ok: true });
    }
    if (url.pathname === '/late-answer') {
      const room = await readRoom<any>(this.ctx.storage);
      room.deadline = Date.now() - 1; await writeRoom(this.ctx.storage, room);
      const socket = this.ctx.getWebSockets().find(s => s.deserializeAttachment().uid === url.searchParams.get('uid'))!;
      await super.webSocketMessage(socket, await request.text()); return Response.json({ ok: true });
    }
    if (url.pathname === '/replay-finish') {
      const room = await readRoom<any>(this.ctx.storage);
      room.status = 'live'; room.phase = 'review'; room.deadline = Date.now() - 1;
      await writeRoom(this.ctx.storage, room); await super.alarm(); return Response.json({ ok: true });
    }
    return super.fetch(request);
  }
}
export default {
  async fetch(request: Request, env: { MATCH_ROOM: DurableObjectNamespace }) {
    const url = new URL(request.url);
    return env.MATCH_ROOM.get(env.MATCH_ROOM.idFromName(url.searchParams.get('matchId')!)).fetch(request);
  },
};
