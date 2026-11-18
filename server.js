'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { Game } = require('./src/game');
const { RateLimiter } = require('./src/ratelimit');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Constant-time comparison that does not leak the key length. */
function keyMatches(candidate, secret) {
  if (typeof candidate !== 'string' || !secret || candidate.length > 512) return false;
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

function clientIp(socket) {
  const fwd = socket.handshake.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return socket.handshake.address;
}

function createServer({ hostKey = process.env.HOST_KEY, game = new Game(), logger = console } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
        "connect-src 'self' ws: wss:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    });
    next();
  });
  app.get('/healthz', (req, res) => res.json({ ok: true, phase: game.phase }));
  app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], index: 'index.html' }));

  const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 16 * 1024, serveClient: true });

  const eventLimiter = new RateLimiter({ capacity: 30, perSeconds: 5 });
  const chatLimiter = new RateLimiter({ capacity: 5, perSeconds: 10 });
  const authLimiter = new RateLimiter({ capacity: 5, perSeconds: 60 });
  const joinLimiter = new RateLimiter({ capacity: 10, perSeconds: 60 });
  const sweeper = setInterval(() => {
    for (const l of [eventLimiter, chatLimiter, authLimiter, joinLimiter]) l.sweep();
  }, 60000);
  sweeper.unref();

  if (!hostKey) logger.warn('HOST_KEY is not set: the Game Master dashboard cannot be used.');

  // ----- broadcasting: coalesce bursts of changes into one round of per-socket views -----
  let pending = false;
  function broadcast() {
    pending = false;
    const hostView = game.hostView();
    const views = new Map();
    for (const socket of io.of('/').sockets.values()) {
      if (socket.data.isHost) socket.emit('host:state', hostView);
      const pid = socket.data.playerId;
      if (pid) {
        if (!views.has(pid)) views.set(pid, game.playerView(pid));
        const view = views.get(pid);
        if (view) socket.emit('state', view);
      } else if (!socket.data.isHost) {
        socket.emit('lobby', lobbyInfo());
      }
    }
  }
  function scheduleBroadcast() {
    if (pending) return;
    pending = true;
    setImmediate(broadcast);
  }
  game.on('change', scheduleBroadcast);

  function lobbyInfo() {
    return {
      phase: game.phase,
      joinable: game.phase === 'LOBBY',
      players: game.players.size,
    };
  }

  function bindPlayer(socket, player) {
    socket.data.playerId = player.id;
    socket.data.team = player.team;
    socket.join(`team:${player.team}`);
    game.attachSocket(player.id, socket.id);
    socket.emit('chat:history', game.chatHistory(player.team));
  }

  function unbindPlayer(socket, message) {
    if (socket.data.team) socket.leave(`team:${socket.data.team}`);
    socket.data.playerId = null;
    socket.data.team = null;
    socket.emit('player:removed', { message });
  }

  io.on('connection', (socket) => {
    socket.data.playerId = null;
    socket.data.team = null;
    socket.data.isHost = false;
    const ip = clientIp(socket);

    /** Wraps a handler with structure validation, rate limiting and a safe ack. */
    function on(event, handler, { limiter = eventLimiter, key = () => socket.id } = {}) {
      socket.on(event, (payload, ack) => {
        if (typeof payload === 'function') { ack = payload; payload = {}; }
        const reply = typeof ack === 'function' ? ack : () => {};
        if (!eventLimiter.take(socket.id) || (limiter !== eventLimiter && !limiter.take(key()))) {
          reply({ ok: false, error: 'Too many requests. Slow down.' });
          return;
        }
        if (payload === undefined || payload === null) payload = {};
        if (!isObject(payload)) {
          reply({ ok: false, error: 'Invalid message.' });
          return;
        }
        try {
          reply(handler(payload) || { ok: true });
        } catch (err) {
          logger.error(`Error in ${event}:`, err);
          reply({ ok: false, error: 'Server error.' });
        }
      });
    }

    function requireHost(fn) {
      return (payload) => {
        if (!socket.data.isHost) return { ok: false, error: 'Game Master authentication required.' };
        return fn(payload);
      };
    }

    // ----- players -----

    on('player:join', ({ name }) => {
      if (socket.data.playerId) return { ok: false, error: 'Already joined.' };
      if (socket.data.isHost) return { ok: false, error: 'The Game Master cannot join as a player.' };
      const res = game.addPlayer(name);
      if (!res.ok) return res;
      bindPlayer(socket, res.player);
      return { ok: true, token: res.player.token, id: res.player.id, team: res.player.team, name: res.player.name };
    }, { limiter: joinLimiter, key: () => ip });

    on('player:resume', ({ token }) => {
      if (socket.data.playerId) return { ok: false, error: 'Already joined.' };
      const player = game.playerByToken(token);
      if (!player) return { ok: false, error: 'Session not found. Please join again.' };
      bindPlayer(socket, player);
      return { ok: true, id: player.id, team: player.team, name: player.name };
    }, { limiter: joinLimiter, key: () => ip });

    on('vote', ({ value }) => {
      if (!socket.data.playerId) return { ok: false, error: 'Join the game first.' };
      return game.vote(socket.data.playerId, value);
    });

    on('chat:send', ({ text }) => {
      const pid = socket.data.playerId;
      if (!pid) return { ok: false, error: 'Join the game first.' };
      const res = game.chat(pid, text);
      if (!res.ok) return res;
      io.to(`team:${res.team}`).emit('chat:message', res.msg);
      return { ok: true };
    }, { limiter: chatLimiter, key: () => socket.data.playerId || socket.id });

    // ----- Game Master -----

    on('host:auth', ({ key }) => {
      if (!hostKey) return { ok: false, error: 'Game Master access is not configured on this server.' };
      if (socket.data.playerId) return { ok: false, error: 'Players cannot become the Game Master.' };
      if (!keyMatches(key, hostKey)) return { ok: false, error: 'Invalid host key.' };
      socket.data.isHost = true;
      socket.emit('host:state', game.hostView());
      return { ok: true };
    }, { limiter: authLimiter, key: () => ip });

    on('host:start', requireHost(() => game.start()));
    on('host:pause', requireHost(() => game.pause()));
    on('host:resume', requireHost(() => game.resume()));

    on('host:reset', requireHost(({ confirm, removePlayers }) => {
      if (confirm !== true) return { ok: false, error: 'Reset must be confirmed.' };
      const res = game.reset({ removePlayers: removePlayers === true });
      const removedIds = new Set(res.removed.map((p) => p.id));
      for (const s of io.of('/').sockets.values()) {
        if (s.data.playerId && removedIds.has(s.data.playerId)) {
          unbindPlayer(s, 'The Game Master removed all players. Join again to play.');
        } else if (s.data.playerId) {
          s.emit('chat:history', []);
        }
      }
      return { ok: true, removed: res.removed.length };
    }));

    socket.on('disconnect', () => {
      eventLimiter.forget(socket.id);
      if (socket.data.playerId) game.detachSocket(socket.data.playerId, socket.id);
    });

    socket.emit('lobby', lobbyInfo());
  });

  return {
    app,
    server,
    io,
    game,
    listen(port = 0) {
      return new Promise((resolve) => {
        server.listen(port, () => resolve(server.address().port));
      });
    },
    close() {
      clearInterval(sweeper);
      return new Promise((resolve) => {
        io.close();
        server.close(() => resolve());
      });
    },
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createServer().listen(port).then((p) => {
    console.log(`Battleships — Team Wars listening on port ${p}`);
  });
}

module.exports = { createServer, keyMatches };
