import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';

interface AdhocSocketClient {
  ws: WebSocket;
  mode: 'control' | 'udp' | 'tcp-listen' | 'tcp-connect' | 'signal' | 'sessions';
  alive: boolean;
  token: string;
  room: string;
  ip: number;
  ipText: string;
  ipU32: number;
  mac: Buffer | null;
  name: Buffer | null;
  game: Buffer | null;
  group: Buffer | null;
  session: string;
  signalClient: AdhocSocketClient | null;
  owner: AdhocSocketClient | null;
  port: number;
  backlog: number;
  dst: string;
  dstport: number;
  connId: number;
  peer: AdhocSocketClient | null;
  peers: Map<number, AdhocSocketClient>;
  rx: Buffer;
  // Shared sessions fields
  shareId: string;
  shareRoom: string;
  shareName: string;
  shareHost: string | null;
  sharePublication: { title: string; mode: 'watch' | 'play'; controller: string | null } | null;
}

function ipFromInt(n: number): string {
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

function ipToU32(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function sendBinary(client: AdhocSocketClient, data: Buffer): void {
  if (client.alive && client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(data, { binary: true });
  }
}

function sendJson(client: AdhocSocketClient, payload: unknown): void {
  if (client.alive && client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(Buffer.from(JSON.stringify(payload), 'utf8'), { binary: true });
  }
}

class SharedSessions {
  private clients = new Map<string, AdhocSocketClient>();

  add(client: AdhocSocketClient, room: string, name: string): void {
    client.shareId = crypto.randomBytes(16).toString('hex');
    client.shareRoom = room;
    client.shareName = name.slice(0, 48);
    client.shareHost = null;
    client.sharePublication = null;
    this.clients.set(client.shareId, client);
  }

  ready(client: AdhocSocketClient): void {
    sendJson(client, { type: 'welcome', id: client.shareId, iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    this.refresh(client.shareRoom);
  }

  refresh(room: string): void {
    const sessions = [...this.clients.values()]
      .filter((c) => c.shareRoom === room && c.sharePublication)
      .map((c) => ({
        id: c.shareId,
        name: c.shareName,
        ...c.sharePublication,
      }));
    for (const c of this.clients.values()) {
      if (c.shareRoom === room) {
        sendJson(c, { type: 'sessions', sessions });
      }
    }
  }

  state(host: AdhocSocketClient): void {
    if (!host.sharePublication) return;
    const members = [...this.clients.values()]
      .filter((c) => c.shareHost === host.shareId)
      .map((c) => ({ id: c.shareId, name: c.shareName }));
    const message = {
      type: 'state',
      host: host.shareId,
      controller: host.sharePublication.controller,
      members,
    };
    sendJson(host, message);
    for (const c of this.clients.values()) {
      if (c.shareHost === host.shareId) {
        sendJson(c, message);
      }
    }
  }

  leave(client: AdhocSocketClient): void {
    if (client.sharePublication) {
      for (const c of this.clients.values()) {
        if (c.shareHost === client.shareId) {
          c.shareHost = null;
          sendJson(c, { type: 'ended' });
        }
      }
      client.sharePublication = null;
    }
    const host = client.shareHost ? this.clients.get(client.shareHost) : undefined;
    client.shareHost = null;
    if (host && host.sharePublication) {
      if (host.sharePublication.controller === client.shareId) {
        host.sharePublication.controller = null;
      }
      sendJson(host, { type: 'departed', peer: client.shareId });
      this.state(host);
    }
    this.refresh(client.shareRoom);
  }

  remove(client: AdhocSocketClient): void {
    this.leave(client);
    this.clients.delete(client.shareId);
  }

  message(client: AdhocSocketClient, data: Buffer): void {
    if (data.length > 49152) throw new Error('shared session message too large');
    const m = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
    const kind = m.type;
    if (kind === 'publish') {
      if ((m.mode !== 'watch' && m.mode !== 'play') || typeof m.title !== 'string') {
        throw new Error('invalid publication');
      }
      this.leave(client);
      client.sharePublication = { title: m.title.slice(0, 100), mode: m.mode, controller: null };
      sendJson(client, { type: 'published', id: client.shareId });
      this.refresh(client.shareRoom);
    } else if (kind === 'leave') {
      this.leave(client);
      sendJson(client, { type: 'ended' });
    } else if (kind === 'join') {
      const host = typeof m.host === 'string' ? this.clients.get(m.host) : undefined;
      if (!host || host === client || host.shareRoom !== client.shareRoom || !host.sharePublication) {
        sendJson(client, { type: 'error', message: 'Session is no longer available' });
        return;
      }
      const guestCount = [...this.clients.values()].filter((c) => c.shareHost === host.shareId).length;
      if (guestCount >= 4) {
        sendJson(client, { type: 'error', message: 'Session is full (4 guests)' });
        return;
      }
      this.leave(client);
      client.shareHost = host.shareId;
      sendJson(client, { type: 'joined', host: host.shareId });
      sendJson(host, { type: 'guest', peer: client.shareId });
      this.state(host);
    } else if (kind === 'control') {
      const pub = client.sharePublication;
      const peerId = typeof m.peer === 'string' ? m.peer : null;
      const target = peerId ? this.clients.get(peerId) : undefined;
      if (!pub || pub.mode !== 'play') throw new Error('host control permission required');
      if (peerId !== null && (!target || target.shareHost !== client.shareId)) {
        throw new Error('controller must be a session member');
      }
      pub.controller = peerId;
      this.state(client);
    } else if (kind === 'signal') {
      const target = typeof m.to === 'string' ? this.clients.get(m.to) : undefined;
      if (!target || target.shareRoom !== client.shareRoom) return;
      const validLink =
        (client.sharePublication && target.shareHost === client.shareId) ||
        (target.sharePublication && client.shareHost === target.shareId);
      if (!validLink) return;
      const payload = m.payload as Record<string, unknown> | undefined;
      if (!payload || typeof payload !== 'object' || Object.keys(payload).length !== 1) {
        throw new Error('invalid signaling payload');
      }
      sendJson(target, { type: 'signal', sender: client.shareId, payload });
    } else {
      throw new Error('unknown shared session message');
    }
  }
}

class AdhocLobby {
  readonly shared = new SharedSessions();
  readonly users = new Map<string, AdhocSocketClient>();
  readonly endpoints = new Set<AdhocSocketClient>();
  readonly udp = new Map<string, AdhocSocketClient>();
  readonly listeners = new Map<string, AdhocSocketClient>();
  private nextIp = 2;
  private nextId = 1;

  private sameGroup(a: AdhocSocketClient, b: AdhocSocketClient): boolean {
    return (
      a.group !== null &&
      b.group !== null &&
      a.room === b.room &&
      a.game !== null &&
      b.game !== null &&
      a.game.equals(b.game) &&
      a.group.equals(b.group)
    );
  }

  add(user: AdhocSocketClient): void {
    if (this.users.has(user.token)) throw new Error('capability already connected');
    const used = new Set([...this.users.values()].map((u) => u.ip));
    while (used.has(this.nextIp)) {
      this.nextIp = this.nextIp >= 0xfffffd ? 2 : this.nextIp + 1;
    }
    user.ip = this.nextIp;
    user.ipText = ipFromInt(user.ip);
    user.ipU32 = ipToU32(user.ipText);
    this.nextIp = this.nextIp >= 0xfffffd ? 2 : this.nextIp + 1;
    this.users.set(user.token, user);
  }

  remove(user: AdhocSocketClient): void {
    this.disconnect(user);
    if (this.users.get(user.token) === user) {
      this.users.delete(user.token);
    }
    for (const ep of [...this.endpoints]) {
      if (ep.owner === user) {
        this.stopClient(ep);
      }
    }
  }

  stopClient(client: AdhocSocketClient): void {
    if (!client.alive) return;
    client.alive = false;
    this.endpoints.delete(client);
    if (client.mode === 'udp') {
      const key = `${client.token}:${client.port}`;
      if (this.udp.get(key) === client) this.udp.delete(key);
    } else if (client.mode === 'tcp-listen') {
      const key = `${client.token}:${client.port}`;
      if (this.listeners.get(key) === client) this.listeners.delete(key);
      for (const p of client.peers.values()) this.stopClient(p);
      client.peers.clear();
    } else if (client.mode === 'tcp-connect' && client.peer) {
      client.peer.peers.delete(client.connId);
      const bye = Buffer.alloc(8);
      bye.write('PT1', 0, 'ascii');
      bye[3] = 3;
      bye.writeUInt32BE(client.connId, 4);
      sendBinary(client.peer, bye);
    } else if (client.mode === 'signal' && client.owner?.signalClient === client) {
      client.owner.signalClient = null;
    }
    try {
      client.ws.close();
    } catch {
      // ignore
    }
  }

  login(user: AdhocSocketClient, packet: Buffer): void {
    const mac = packet.subarray(1, 7);
    const game = packet.subarray(135, 144);
    if (user.mac || !mac.some((b) => b !== 0) || (mac[0] & 1) !== 0 || !/^[A-Z0-9]{9}$/.test(game.toString('ascii'))) {
      throw new Error('invalid or repeated login');
    }
    for (const other of this.users.values()) {
      if (other.mac && other.mac.equals(mac) && other.room === user.room) {
        throw new Error('duplicate MAC in room');
      }
    }
    user.mac = Buffer.from(mac);
    user.name = Buffer.from(packet.subarray(7, 135));
    user.game = Buffer.from(game);
    const ipBytes = Buffer.from(user.ipText.split('.').map(Number));
    sendBinary(user, Buffer.concat([Buffer.from('PA1', 'ascii'), ipBytes]));
  }

  connect(user: AdhocSocketClient, group: Buffer): void {
    if (!user.mac || !user.name) throw new Error('login required');
    if (group.length !== 8) throw new Error('invalid group');
    this.disconnect(user);
    user.group = Buffer.from(group);
    const peers = [...this.users.values()]
      .filter((u) => u !== user && this.sameGroup(u, user))
      .sort((a, b) => a.ip - b.ip);
    const bssid = peers[0]?.mac ?? user.mac;
    for (const peer of peers) {
      if (!peer.name || !peer.mac) continue;
      const toPeer = Buffer.alloc(1 + 128 + 6 + 4);
      toPeer[0] = 2;
      user.name.copy(toPeer, 1);
      user.mac.copy(toPeer, 129);
      toPeer.writeUInt32LE(user.ipU32, 135);
      sendBinary(peer, toPeer);

      const toUser = Buffer.alloc(1 + 128 + 6 + 4);
      toUser[0] = 2;
      peer.name.copy(toUser, 1);
      peer.mac.copy(toUser, 129);
      toUser.writeUInt32LE(peer.ipU32, 135);
      sendBinary(user, toUser);
    }
    const ack = Buffer.alloc(7);
    ack[0] = 6;
    bssid.copy(ack, 1);
    sendBinary(user, ack);
    this.syncSignals();
  }

  disconnect(user: AdhocSocketClient): void {
    if (!user.group) return;
    for (const peer of this.users.values()) {
      if (peer !== user && this.sameGroup(peer, user)) {
        const msg = Buffer.alloc(5);
        msg[0] = 3;
        msg.writeUInt32LE(user.ipU32, 1);
        sendBinary(peer, msg);
      }
    }
    user.group = null;
    user.session = crypto.randomBytes(16).toString('hex');
    this.syncSignals();
    for (const ep of [...this.endpoints]) {
      if (ep.owner === user && ep.mode.startsWith('tcp')) {
        this.stopClient(ep);
      }
    }
  }

  scan(user: AdhocSocketClient): void {
    if (!user.mac) throw new Error('login required');
    const seen = new Set<string>();
    const peers = [...this.users.values()].sort((a, b) => a.ip - b.ip);
    for (const peer of peers) {
      if (
        peer.room === user.room &&
        peer.game &&
        user.game &&
        peer.game.equals(user.game) &&
        peer.group &&
        peer.mac
      ) {
        const key = peer.group.toString('hex');
        if (!seen.has(key)) {
          seen.add(key);
          const msg = Buffer.alloc(15);
          msg[0] = 4;
          peer.group.copy(msg, 1);
          peer.mac.copy(msg, 9);
          sendBinary(user, msg);
        }
      }
    }
    sendBinary(user, Buffer.from([5]));
  }

  syncSignals(): void {
    for (const user of this.users.values()) {
      if (user.signalClient) {
        const peers = [...this.users.values()]
          .filter((p) => p !== user && p.signalClient && this.sameGroup(user, p))
          .map((p) => ({ ip: p.ipText, session: p.session }));
        sendJson(user.signalClient, { type: 'peers', session: user.session, peers });
      }
    }
  }

  signal(source: AdhocSocketClient, data: Buffer): void {
    if (data.length > 49152) throw new Error('signaling size limit');
    const message = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
    if (message.type !== 'signal') throw new Error('invalid signaling message');
    const owner = source.owner;
    if (!owner || owner.signalClient !== source) throw new Error('obsolete signaling connection');
    const target = [...this.users.values()].find((u) => u.ipText === message.to);
    if (
      !target ||
      !target.signalClient ||
      !this.sameGroup(owner, target) ||
      message.session !== owner.session ||
      message.targetSession !== target.session
    ) {
      return;
    }
    const payload: Record<string, unknown> = {};
    if ('description' in message) payload.description = message.description;
    if ('candidate' in message) payload.candidate = message.candidate;
    sendJson(target.signalClient, {
      type: 'signal',
      sender: owner.ipText,
      session: owner.session,
      targetSession: target.session,
      ...payload,
    });
  }

  chat(user: AdhocSocketClient, message: Buffer): void {
    if (!user.name) return;
    for (const peer of this.users.values()) {
      if (peer !== user && this.sameGroup(peer, user)) {
        const pkt = Buffer.alloc(1 + 64 + 128);
        pkt[0] = 7;
        message.copy(pkt, 1, 0, 64);
        user.name.copy(pkt, 65, 0, 128);
        sendBinary(peer, pkt);
      }
    }
  }

  owner(token: string, macHex: string): AdhocSocketClient {
    const user = this.users.get(token);
    if (!user || !user.mac) throw new Error('registered capability required');
    const formatted = [...user.mac].map((b) => b.toString(16).padStart(2, '0')).join(':');
    if (formatted !== macHex.toLowerCase()) throw new Error('MAC mismatch');
    return user;
  }

  relayUdp(source: AdhocSocketClient, host: string, port: number, payload: Buffer): void {
    if (!source.owner) return;
    for (const target of this.udp.values()) {
      if (target.port !== port || !target.owner || !this.sameGroup(source.owner, target.owner)) continue;
      if (host === '255.255.255.255') {
        if (target.owner === source.owner) continue;
      } else if (target.owner.ipText !== host) {
        continue;
      }
      const h = Buffer.from(source.owner.ipText, 'ascii');
      const header = Buffer.alloc(6 + h.length);
      header.write('PU1', 0, 'ascii');
      header[3] = h.length;
      h.copy(header, 4);
      header.writeUInt16BE(source.port, 4 + h.length);
      sendBinary(target, Buffer.concat([header, payload]));
    }
  }

  connectTcp(source: AdhocSocketClient): void {
    if (!source.owner) throw new Error('missing owner');
    const target = [...this.listeners.values()].find(
      (h) => h.port === source.dstport && h.owner?.ipText === source.dst && h.owner && this.sameGroup(h.owner, source.owner!)
    );
    if (!target || target.peers.size >= target.backlog) {
      throw new Error('no listener or accept backlog full');
    }
    source.peer = target;
    source.connId = this.nextId;
    this.nextId = (this.nextId % 0xffffffff) + 1;
    target.peers.set(source.connId, source);
    const h = Buffer.from(source.owner.ipText, 'ascii');
    const pkt = Buffer.alloc(10 + h.length);
    pkt.write('PT1', 0, 'ascii');
    pkt[3] = 1;
    pkt.writeUInt32BE(source.connId, 4);
    pkt[8] = h.length;
    h.copy(pkt, 9);
    pkt.writeUInt16BE(source.port, 9 + h.length);
    sendBinary(target, pkt);
  }
}

export function attachAdhocRelay(server: import('node:http').Server): void {
  const lobby = new AdhocLobby();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 2 * 1024 * 1024,
    handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : false),
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const parsed = new URL(req.url || '/', 'http://localhost');
    if (parsed.pathname !== '/adhoc' && !parsed.pathname.startsWith('/adhoc/')) {
      return;
    }

    const token = parsed.searchParams.get('token') || '';
    const v = parsed.searchParams.get('v') || '';
    if (v !== '1' || !/^[a-f0-9]{32}$/.test(token)) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const route = parsed.pathname.replace(/^\/adhoc/, '').replace(/\/$/, '');
      const room = parsed.searchParams.get('room') || 'public';
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(room)) {
        ws.close(1008, 'invalid room');
        return;
      }

      const client: AdhocSocketClient = {
        ws,
        mode: 'control',
        alive: true,
        token,
        room,
        ip: 0,
        ipText: '',
        ipU32: 0,
        mac: null,
        name: null,
        game: null,
        group: null,
        session: crypto.randomBytes(16).toString('hex'),
        signalClient: null,
        owner: null,
        port: 0,
        backlog: 16,
        dst: '',
        dstport: 0,
        connId: 0,
        peer: null,
        peers: new Map(),
        rx: Buffer.alloc(0),
        shareId: '',
        shareRoom: room,
        shareName: 'Player',
        shareHost: null,
        sharePublication: null,
      };

      try {
        if (route === '/sessions') {
          client.mode = 'sessions';
          lobby.shared.add(client, room, parsed.searchParams.get('name') || 'Player');
          lobby.shared.ready(client);
        } else if (route === '') {
          client.mode = 'control';
          lobby.add(client);
        } else if (route === '/udp' || route === '/tcp-listen' || route === '/tcp-connect' || route === '/signal') {
          client.mode = route.slice(1) as AdhocSocketClient['mode'];
          client.owner = lobby.owner(token, parsed.searchParams.get('mac') || '');
          if (client.mode === 'signal') {
            if (client.owner.signalClient) throw new Error('signaling already connected');
            lobby.endpoints.add(client);
            client.owner.session = crypto.randomBytes(16).toString('hex');
            client.owner.signalClient = client;
            lobby.syncSignals();
          } else {
            const port = Number(parsed.searchParams.get('port') || '0');
            if (!Number.isInteger(port) || port <= 0 || port >= 65536) throw new Error('invalid port');
            client.port = port;
            lobby.endpoints.add(client);
            if (client.mode === 'udp' || client.mode === 'tcp-listen') {
              const reg = client.mode === 'udp' ? lobby.udp : lobby.listeners;
              const key = `${token}:${port}`;
              if (reg.has(key)) throw new Error('port already bound');
              const backlog = Number(parsed.searchParams.get('backlog') || '16');
              client.backlog = Math.min(64, Math.max(1, Number.isFinite(backlog) ? backlog : 16));
              reg.set(key, client);
            } else {
              client.dst = parsed.searchParams.get('dst') || '';
              client.dstport = Number(parsed.searchParams.get('dstport') || '0');
              lobby.connectTcp(client);
            }
          }
        } else {
          throw new Error('unknown relay endpoint');
        }
      } catch {
        ws.close(1008, 'relay setup failed');
        return;
      }

      ws.on('message', (raw) => {
        const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
        if (data.length === 0) return;
        try {
          if (client.mode === 'sessions') {
            lobby.shared.message(client, data);
          } else if (client.mode === 'signal') {
            lobby.signal(client, data);
          } else if (client.mode === 'udp') {
            if (data.length < 7 || data.subarray(0, 3).toString('ascii') !== 'PU1') throw new Error('bad udp');
            const n = data[3];
            if (n < 7 || n > 15 || data.length < n + 6) throw new Error('bad udp hdr');
            const host = data.subarray(4, 4 + n).toString('ascii');
            const port = data.readUInt16BE(4 + n);
            lobby.relayUdp(client, host, port, data.subarray(6 + n));
          } else if (client.mode === 'tcp-connect') {
            if (client.peer && client.owner && client.peer.owner && (lobby as unknown as { sameGroup(a: AdhocSocketClient, b: AdhocSocketClient): boolean }).sameGroup(client.owner, client.peer.owner)) {
              const hdr = Buffer.alloc(8);
              hdr.write('PT1', 0, 'ascii');
              hdr[3] = 2;
              hdr.writeUInt32BE(client.connId, 4);
              sendBinary(client.peer, Buffer.concat([hdr, data]));
            }
          } else if (client.mode === 'tcp-listen') {
            if (data.length < 8 || data.subarray(0, 3).toString('ascii') !== 'PT1') throw new Error('bad tcp');
            const kind = data[3];
            const connId = data.readUInt32BE(4);
            const peer = client.peers.get(connId);
            if (peer) {
              if (kind === 2) sendBinary(peer, data.subarray(8));
              else if (kind === 3) lobby.stopClient(peer);
            }
          } else {
            client.rx = Buffer.concat([client.rx, data]);
            const sizes: Record<number, number> = { 0: 1, 1: 144, 2: 9, 3: 1, 4: 1, 7: 65 };
            while (client.rx.length > 0) {
              const op = client.rx[0];
              const size = sizes[op];
              if (!size || (op !== 1 && !client.mac)) throw new Error('invalid control opcode');
              if (client.rx.length < size) break;
              const pkt = client.rx.subarray(0, size);
              client.rx = client.rx.subarray(size);
              if (op === 1) lobby.login(client, pkt);
              else if (op === 2) lobby.connect(client, pkt.subarray(1));
              else if (op === 3) lobby.disconnect(client);
              else if (op === 4) lobby.scan(client);
              else if (op === 7) lobby.chat(client, pkt.subarray(1));
            }
          }
        } catch {
          ws.close(1008, 'protocol error');
        }
      });

      ws.on('close', () => {
        if (client.mode === 'sessions') {
          lobby.shared.remove(client);
        } else if (client.mode === 'control') {
          lobby.remove(client);
        } else {
          lobby.stopClient(client);
        }
      });
    });
  });
}
