'use strict';

// A dependency-free Slack game. Pending moves stay on this server, never in buttons.
const http = require('node:http');
const crypto = require('node:crypto');
const MOVES = ['rock', 'paper', 'scissors'];
const LABEL = { rock: '🪨 Rock', paper: '📄 Paper', scissors: '✂️ Scissors' };
const BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
const COLOUR = { win: '#22C55E', lose: '#EF4444', tie: '#F59E0B', game: '#8B5CF6' };

function getOutcome(user, bot) {
  if (!MOVES.includes(user) || !MOVES.includes(bot)) throw new TypeError('Invalid move');
  return user === bot ? 'tie' : BEATS[user] === bot ? 'win' : 'lose';
}

function verifySlack(headers, rawBody, secret, nowMs = Date.now()) {
  const signature = headers['x-slack-signature'];
  const timestamp = headers['x-slack-request-timestamp'];
  if (typeof signature !== 'string' || !/^v0=[a-f0-9]{64}$/.test(signature)) return false;
  if (typeof timestamp !== 'string' || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > 300) return false;
  const expected = 'v0=' + crypto.createHmac('sha256', secret)
    .update(`v0:${timestamp}:`).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

function isSlackResponseUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      ['hooks.slack.com', 'hooks.slack-gov.com'].includes(url.hostname) &&
      /^\/actions\/[^/]+\/[^/]+\/[^/]+$/.test(url.pathname) && !url.search && !url.hash;
  } catch {
    return false;
  }
}

async function postResponse(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  if (response.body) await response.body.cancel();
  if (!response.ok) throw new Error('Slack message delivery failed');
}

function sendJson(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  const data = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identity(user, team, channel) {
  if (![user, team, channel].every(v => typeof v === 'string' && v.length > 0)) return null;
  return JSON.stringify([user, team, channel]);
}

function createServer({
  signingSecret = process.env.SLACK_SIGNING_SECRET,
  now = Date.now,
  pickBot = () => MOVES[crypto.randomInt(MOVES.length)],
  gameTtlMs = 10 * 60 * 1000,
  maxGames = 10000,
  maxBodyBytes = 64 * 1024,
  sendResponse = postResponse,
  onDeliveryError = () => console.error('Slack message delivery failed; start a new round with /rps.'),
} = {}) {
  if (typeof signingSecret !== 'string' || !signingSecret.trim() || signingSecret === 'dev-secret-change-me') {
    throw new Error('Set SLACK_SIGNING_SECRET to your Slack app signing secret before starting.');
  }
  if (![gameTtlMs, maxGames, maxBodyBytes].every(v => Number.isSafeInteger(v) && v > 0)) {
    throw new TypeError('Game lifetime, capacity and body limit must be positive integers.');
  }
  const rounds = new Map();
  const errorMessage = text => ({ response_type: 'ephemeral', replace_original: false, text });

  function prune() {
    for (const [id, round] of rounds) {
      if (round.expires <= now()) rounds.delete(id);
    }
  }

  function storeRound(owner, kind) {
    prune();
    if (rounds.size >= maxGames) return null;
    const id = crypto.randomBytes(24).toString('hex');
    rounds.set(id, { owner, kind, bot: kind === 'move' ? pickBot() : null, expires: now() + gameTtlMs });
    return id;
  }

  function gamePayload(owner, replace = false) {
    const id = storeRound(owner, 'move');
    if (!id) return errorMessage('The game is busy. Please try /rps again shortly.');
    return {
      text: 'Rock • Paper • Scissors: choose your move.',
      response_type: 'in_channel', replace_original: replace,
      attachments: [{ color: COLOUR.game, text: 'The bot has picked its move. Only the player who started this round can play.' }],
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: '*🎮 Rock • Paper • Scissors*\nPick your move — 🪨 beats ✂️, ✂️ beats 📄, 📄 beats 🪨.' } },
        { type: 'actions', elements: MOVES.map(move => ({
          type: 'button', action_id: `rps_${move}`, style: 'primary',
          text: { type: 'plain_text', text: LABEL[move], emoji: true }, value: `${id}:${move}`,
        })) },
      ],
    };
  }

  function resultPayload(user, bot, owner, replace) {
    const outcome = getOutcome(user, bot);
    const headline = outcome === 'win' ? `🎉 You win! ${LABEL[user]} beats ${LABEL[bot]}.`
      : outcome === 'lose' ? `💥 Bot wins! ${LABEL[bot]} beats ${LABEL[user]}.`
        : `🤝 It's a tie! Both chose ${LABEL[user]}.`;
    const again = storeRound(owner, 'again');
    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: `${headline}\nYou: ${LABEL[user]}  •  Bot: ${LABEL[bot]}` } }];
    if (again) blocks.push({ type: 'actions', elements: [{
      type: 'button', action_id: 'rps_again', style: 'primary',
      text: { type: 'plain_text', text: '🔁 Play again', emoji: true }, value: `${again}:again`,
    }] });
    return {
      text: headline, response_type: 'in_channel', replace_original: replace,
      attachments: [{ color: COLOUR[outcome], text: `You: ${LABEL[user]}  •  Bot: ${LABEL[bot]}` }], blocks,
    };
  }

  function handleCommand(params) {
    const owner = identity(params.get('user_id'), params.get('team_id'), params.get('channel_id'));
    if (!owner) return errorMessage('Missing player, workspace or channel. Please start again with /rps.');
    const text = (params.get('text') || '').trim().toLowerCase();
    if (!text) return gamePayload(owner);
    if (!MOVES.includes(text)) return errorMessage('Unknown move. Use /rps rock, /rps paper or /rps scissors.');
    return resultPayload(text, pickBot(), owner, false);
  }

  function handleInteraction(payload) {
    const action = payload.actions[0];
    const owner = identity(payload.user?.id, payload.team?.id, payload.channel?.id);
    const match = /^([a-f0-9]{48}):(rock|paper|scissors|again)$/.exec(action.value);
    if (!owner || !match || action.action_id !== `rps_${match[2]}`) {
      return errorMessage('Invalid action. Please start again with /rps.');
    }
    const [, id, move] = match;
    const round = rounds.get(id);
    if (!round || round.expires <= now() || round.owner !== owner || round.kind !== (move === 'again' ? 'again' : 'move')) {
      return errorMessage('That round is expired, already played or belongs to another player. Start a new round with /rps.');
    }
    // Consume before creating the next message, so double clicks cannot play twice.
    rounds.delete(id);
    return move === 'again' ? gamePayload(owner, true) : resultPayload(move, round.bot, owner, true);
  }

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      sendJson(res, 200, { ok: true, service: 'slack-rps', moves: MOVES });
      return;
    }
    if (req.method !== 'POST' || !['/slack/commands', '/slack/interactions'].includes(req.url)) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') {
      sendJson(res, 415, { error: 'expected form-encoded body' });
      req.resume();
      return;
    }
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('error', () => sendJson(res, 400, { error: 'invalid request body' }));
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        tooLarge = true;
        chunks.length = 0;
        sendJson(res, 413, { error: 'request body too large' });
      } else if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      const raw = Buffer.concat(chunks);
      if (!verifySlack(req.headers, raw, signingSecret, now())) {
        sendJson(res, 401, { error: 'invalid Slack signature' });
        return;
      }
      try {
        const params = new URLSearchParams(raw.toString('utf8'));
        if (req.url === '/slack/commands') {
          sendJson(res, 200, handleCommand(params));
          return;
        }
        let payload;
        try { payload = JSON.parse(params.get('payload')); } catch { /* Checked below. */ }
        if (!isObject(payload) || payload.type !== 'block_actions' || !Array.isArray(payload.actions) ||
            payload.actions.length !== 1 || !isObject(payload.actions[0]) ||
            typeof payload.actions[0].value !== 'string' || typeof payload.actions[0].action_id !== 'string' ||
            !isSlackResponseUrl(payload.response_url)) {
          sendJson(res, 400, { error: 'invalid interaction payload' });
          return;
        }
        const message = handleInteraction(payload);
        sendJson(res, 200, {}); // ACK immediately; Block Kit updates use the response URL.
        Promise.resolve().then(() => sendResponse(payload.response_url, message)).catch(error => {
          // A response URL is a credential. Never log it or the incoming payload.
          try { onDeliveryError(error); } catch { /* Logging must not crash the server. */ }
        });
      } catch {
        sendJson(res, 500, { error: 'unable to process request' });
      }
    });
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  return server;
}

if (require.main === module) {
  try {
    const port = Number(process.env.PORT || 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
    const server = createServer();
    server.on('error', () => {
      console.error('Unable to start server. Check PORT and whether it is already in use.');
      process.exitCode = 1;
    });
    server.listen(port, () => console.log(`Rock • Paper • Scissors listening on port ${port}`));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { createServer, verifySlack, getOutcome, isSlackResponseUrl };
