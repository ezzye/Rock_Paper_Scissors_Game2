'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { once } = require('node:events');
const { Duplex } = require('node:stream');
const { test } = require('node:test');
const { createServer, verifySlack, getOutcome, isSlackResponseUrl } = require('../slack-rps.js');

// Deliberately fake test data: never use a Slack app secret or live response URL here.
const SECRET = 'test-signing-secret-not-a-real-credential';
const RESPONSE_URL = 'https://hooks.slack.com/actions/T_TEST/U_TEST/test-token';
const CONTEXT = { user_id: 'U_TEST', team_id: 'T_TEST', channel_id: 'C_TEST' };
const FIXED_TIME = 1_800_000_000_000;
const USE_HTTP = process.env.RPS_TEST_TRANSPORT === 'http';

function signedHeaders(body, timestamp = String(Math.floor(FIXED_TIME / 1000))) {
  const signature = crypto.createHmac('sha256', SECRET)
    .update(`v0:${timestamp}:`).update(body).digest('hex');
  return {
    'content-type': 'application/x-www-form-urlencoded',
    'x-slack-request-timestamp': timestamp,
    'x-slack-signature': `v0=${signature}`,
  };
}

async function fixture(t, options = {}) {
  const deliveries = [];
  const errors = [];
  const server = createServer({
    signingSecret: SECRET,
    now: () => FIXED_TIME,
    pickBot: () => 'rock',
    sendResponse: async (url, message) => { deliveries.push({ url, message }); },
    onDeliveryError: (error) => { errors.push(error); },
    ...options,
  });
  if (USE_HTTP) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    });
  }

  function requestHttp(path, { body = '', headers, method = 'POST' } = {}) {
    const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: server.address().port, path, method,
        headers: { ...signedHeaders(raw), 'content-length': raw.length, ...headers },
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, text, json: text ? JSON.parse(text) : null });
        });
      });
      req.on('error', reject);
      req.end(raw);
    });
  }

  // Dispatch through real IncomingMessage/ServerResponse streams without opening a
  // TCP port. Set RPS_TEST_TRANSPORT=http to also exercise the OS HTTP transport.
  function requestInMemory(path, { body = '', headers, method = 'POST' } = {}) {
    const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
    return new Promise((resolve, reject) => {
      const output = [];
      const socket = new Duplex({
        read() {},
        write(chunk, encoding, callback) { output.push(Buffer.from(chunk)); callback(); },
      });
      const req = new http.IncomingMessage(socket);
      req.method = method;
      req.url = path;
      req.headers = { ...signedHeaders(raw), 'content-length': String(raw.length), ...headers };
      const res = new http.ServerResponse(req);
      res.assignSocket(socket);
      res.on('error', reject);
      res.on('finish', () => {
        try {
          const wire = Buffer.concat(output).toString('utf8');
          const text = wire.slice(wire.indexOf('\r\n\r\n') + 4);
          resolve({ status: res.statusCode, text, json: text ? JSON.parse(text) : null });
        } catch (error) { reject(error); }
        finally { socket.destroy(); }
      });
      server.emit('request', req, res);
      req.push(raw);
      req.push(null);
    });
  }

  const request = USE_HTTP ? requestHttp : requestInMemory;

  const command = (text = '', context = CONTEXT) => request('/slack/commands', {
    body: new URLSearchParams({ ...context, command: '/rps', text }).toString(),
  });

  function payload(action, overrides = {}) {
    return {
      type: 'block_actions', user: { id: CONTEXT.user_id }, team: { id: CONTEXT.team_id },
      channel: { id: CONTEXT.channel_id }, response_url: RESPONSE_URL,
      actions: [{ type: 'button', ...action }], ...overrides,
    };
  }

  const interaction = (value) => request('/slack/interactions', {
    body: new URLSearchParams({ payload: JSON.stringify(value) }).toString(),
  });

  async function click(action, overrides) {
    const count = deliveries.length;
    const ack = await interaction(payload(action, overrides));
    // The webhook runs after acknowledgement; flush its immediate promise callbacks.
    await new Promise(setImmediate);
    return { ack, delivery: deliveries[count] };
  }

  return { server, deliveries, errors, request, command, payload, interaction, click };
}

function buttons(message) {
  return message.blocks.find((block) => block.type === 'actions').elements;
}

function resultText(message) {
  return message.blocks.find((block) => block.type === 'section').text.text;
}

test('startup requires a configured signing secret', () => {
  const configured = process.env.SLACK_SIGNING_SECRET;
  delete process.env.SLACK_SIGNING_SECRET;
  try {
    for (const signingSecret of [undefined, '', '   ', 'dev-secret-change-me']) {
      assert.throws(() => createServer({ signingSecret }));
    }
  } finally {
    if (configured !== undefined) process.env.SLACK_SIGNING_SECRET = configured;
  }
});

test('Slack signatures authenticate exact raw bytes, including Unicode', () => {
  const raw = Buffer.from('text=🪨&user_id=U_TEST');
  const headers = signedHeaders(raw);
  assert.equal(verifySlack(headers, raw, SECRET, FIXED_TIME), true);
  assert.equal(verifySlack(headers, Buffer.from('text=paper'), SECRET, FIXED_TIME), false);
  assert.equal(verifySlack(headers, raw, 'wrong-secret', FIXED_TIME), false);
});

test('stale, future and malformed timestamps are rejected even with matching signatures', () => {
  const raw = Buffer.from('text=rock');
  for (const ts of ['1799999699', '1800000301', 'NaN', 'Infinity', '1.8e9', '', '-1']) {
    assert.equal(verifySlack(signedHeaders(raw, ts), raw, SECRET, FIXED_TIME), false, ts);
  }
});

test('missing, malformed and wrong-length signatures are rejected without throwing', () => {
  const raw = Buffer.from('text=rock');
  for (const signature of [undefined, '', 'v0=abc', 'v1=' + '0'.repeat(64), 'v0=' + 'z'.repeat(64)]) {
    assert.equal(verifySlack({ ...signedHeaders(raw), 'x-slack-signature': signature }, raw, SECRET, FIXED_TIME), false);
  }
});

const outcomes = [
  ['rock', 'rock', 'tie'], ['rock', 'paper', 'lose'], ['rock', 'scissors', 'win'],
  ['paper', 'rock', 'win'], ['paper', 'paper', 'tie'], ['paper', 'scissors', 'lose'],
  ['scissors', 'rock', 'lose'], ['scissors', 'paper', 'win'], ['scissors', 'scissors', 'tie'],
];
for (const [user, bot, outcome] of outcomes) {
  test(`${user} versus ${bot} produces ${outcome}`, () => {
    assert.equal(getOutcome(user, bot), outcome);
  });
}

test('outcome logic rejects unsupported moves', () => {
  assert.throws(() => getOutcome('lizard', 'rock'));
  assert.throws(() => getOutcome('rock', undefined));
});

test('response URLs must be HTTPS Slack action webhooks with no credentials or custom port', () => {
  assert.equal(isSlackResponseUrl(RESPONSE_URL), true);
  for (const value of [
    undefined, null, 42, 'not-a-url', 'http://hooks.slack.com/actions/T/U/token',
    'https://hooks.slack.com.evil.example/actions/T/U/token',
    'https://hooks.slack.com@evil.example/actions/T/U/token',
    'https://user:password@hooks.slack.com/actions/T/U/token',
    'https://hooks.slack.com:8443/actions/T/U/token',
    'https://127.0.0.1/actions/T/U/token', 'https://hooks.slack.com/services/T/U/token',
  ]) assert.equal(isSlackResponseUrl(value), false, String(value));
});

test('health endpoint is public and unknown routes return 404', async (t) => {
  const app = await fixture(t);
  const health = await app.request('/', { method: 'GET' });
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  assert.equal((await app.request('/missing', { method: 'GET' })).status, 404);
  assert.equal((await app.request('/slack/commands', { method: 'GET' })).status, 404);
});

test('HTTP requests require valid signatures before executing a command', async (t) => {
  const app = await fixture(t);
  const response = await app.request('/slack/commands', {
    body: 'text=rock', headers: { 'x-slack-signature': 'v0=' + '0'.repeat(64) },
  });
  assert.equal(response.status, 401);
  assert.equal(app.deliveries.length, 0);
});

test('wrong content types and oversized bodies fail in a controlled way', async (t) => {
  const app = await fixture(t, { maxBodyBytes: 256 });
  assert.equal((await app.request('/slack/commands', { body: '{}', headers: { 'content-type': 'application/json' } })).status, 415);
  assert.equal((await app.request('/slack/commands', { body: 'x'.repeat(257) })).status, 413);
  assert.equal((await app.request('/', { method: 'GET' })).status, 200);
});

test('prompt preselects a bot move without disclosing it in button values', async (t) => {
  let selections = 0;
  const app = await fixture(t, { pickBot: () => { selections++; return 'scissors'; } });
  const response = await app.command();
  assert.equal(response.status, 200);
  assert.equal(response.json.response_type, 'in_channel');
  assert.equal(selections, 1);
  const moves = buttons(response.json);
  assert.deepEqual(moves.map((button) => button.action_id), ['rps_rock', 'rps_paper', 'rps_scissors']);
  assert.deepEqual(moves.map((button) => button.value.split(':')[1]), ['rock', 'paper', 'scissors']);
  assert.equal(new Set(moves.map((button) => button.value.split(':')[0])).size, 1);
  for (const button of moves) assert.match(button.value, /^[a-f0-9]{48}:(rock|paper|scissors)$/);
  assert.doesNotMatch(JSON.stringify(moves), /bot:|token:/);
});

test('direct commands calculate the result and do not replace another message', async (t) => {
  const app = await fixture(t);
  const response = await app.command(' PaPeR ');
  assert.equal(response.status, 200);
  assert.match(resultText(response.json), /You win/);
  assert.equal(response.json.replace_original, false);
  assert.match(buttons(response.json)[0].value, /^[a-f0-9]{48}:again$/);
});

test('unknown moves and missing command context return controlled responses', async (t) => {
  const app = await fixture(t);
  const invalid = await app.command('<!channel>');
  assert.equal(invalid.status, 200);
  assert.equal(invalid.json.response_type, 'ephemeral');
  assert.doesNotMatch(JSON.stringify(invalid.json), /<!channel>/);
  for (const omitted of Object.keys(CONTEXT)) {
    const context = { ...CONTEXT };
    delete context[omitted];
    const response = await app.command('', context);
    assert.ok(response.status === 400 || response.json.response_type === 'ephemeral');
  }
});

test('button click is acknowledged and the result is delivered through response_url', async (t) => {
  const app = await fixture(t);
  const prompt = await app.command();
  const { ack, delivery } = await app.click(buttons(prompt.json)[1]);
  assert.equal(ack.status, 200);
  assert.deepEqual(ack.json, {});
  assert.equal(delivery.url, RESPONSE_URL);
  assert.match(resultText(delivery.message), /You win/);
  assert.equal(delivery.message.replace_original, true);
});

test('a slow webhook does not delay the interaction acknowledgement', { timeout: 2000 }, async (t) => {
  let finishDelivery;
  const pendingDelivery = new Promise((resolve) => { finishDelivery = resolve; });
  t.after(() => finishDelivery());
  const app = await fixture(t, { sendResponse: () => pendingDelivery });
  const prompt = await app.command();
  const response = await app.interaction(app.payload(buttons(prompt.json)[1]));
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, {});
});

test('a round can be used only once, including a different second move', async (t) => {
  const app = await fixture(t);
  const prompt = await app.command();
  const moves = buttons(prompt.json);
  await app.click(moves[1]);
  for (const move of [moves[1], moves[2]]) {
    const { delivery } = await app.click(move);
    assert.equal(delivery.message.response_type, 'ephemeral');
    assert.equal(delivery.message.replace_original, false);
  }
});

test('another user, workspace or channel cannot consume the owner’s round', async (t) => {
  const app = await fixture(t);
  const prompt = await app.command();
  const move = buttons(prompt.json)[1];
  for (const overrides of [{ user: { id: 'U_OTHER' } }, { team: { id: 'T_OTHER' } }, { channel: { id: 'C_OTHER' } }]) {
    const { delivery } = await app.click(move, overrides);
    assert.equal(delivery.message.response_type, 'ephemeral');
    assert.equal(delivery.message.replace_original, false);
  }
  const { delivery } = await app.click(move);
  assert.match(resultText(delivery.message), /You win/);
});

test('action ID must match its selected move and an invented token cannot play', async (t) => {
  const app = await fixture(t);
  const prompt = await app.command();
  const move = buttons(prompt.json)[1];
  const mismatched = await app.click({ ...move, action_id: 'rps_rock' });
  assert.equal(mismatched.delivery.message.response_type, 'ephemeral');
  const invented = await app.click({ ...move, value: '0'.repeat(48) + ':paper' });
  assert.equal(invented.delivery.message.response_type, 'ephemeral');
  const owner = await app.click(move);
  assert.match(resultText(owner.delivery.message), /You win/);
});

test('rounds expire and new commands remain usable after expiry', async (t) => {
  let currentTime = FIXED_TIME;
  const app = await fixture(t, { now: () => currentTime, gameTtlMs: 1000 });
  const prompt = await app.command();
  currentTime += 1001;
  const { delivery } = await app.click(buttons(prompt.json)[1]);
  assert.equal(delivery.message.response_type, 'ephemeral');
  assert.equal(delivery.message.replace_original, false);
  const next = await app.command();
  assert.equal(next.json.response_type, 'in_channel');
});

test('Play again validates its token, starts a new round and cannot be replayed', async (t) => {
  const app = await fixture(t);
  const direct = await app.command('paper');
  const again = buttons(direct.json)[0];
  const first = await app.click(again);
  assert.equal(first.delivery.message.response_type, 'in_channel');
  assert.equal(first.delivery.message.replace_original, true);
  assert.equal(buttons(first.delivery.message).length, 3);
  const replay = await app.click(again);
  assert.equal(replay.delivery.message.response_type, 'ephemeral');
  const forged = await app.click({ ...again, value: '0'.repeat(48) + ':again' });
  assert.equal(forged.delivery.message.response_type, 'ephemeral');
});

test('bounded storage refuses excess games and recovers after old games expire', async (t) => {
  let currentTime = FIXED_TIME;
  const app = await fixture(t, { now: () => currentTime, maxGames: 1, gameTtlMs: 1000 });
  assert.equal((await app.command()).json.response_type, 'in_channel');
  assert.equal((await app.command()).json.response_type, 'ephemeral');
  currentTime += 1001;
  assert.equal((await app.command()).json.response_type, 'in_channel');
});

test('expiry pruning handles a clock rollback between round insertions', async (t) => {
  let currentTime = FIXED_TIME;
  const app = await fixture(t, { now: () => currentTime, maxGames: 2, gameTtlMs: 1000 });
  assert.equal((await app.command()).json.response_type, 'in_channel');
  currentTime -= 500;
  assert.equal((await app.command()).json.response_type, 'in_channel');
  currentTime = FIXED_TIME + 600;
  assert.equal((await app.command()).json.response_type, 'in_channel');
});

test('signed malformed interaction JSON and shapes do not crash the server', async (t) => {
  const app = await fixture(t);
  const malformed = [null, [], 42, 'text', {}, app.payload(null, { actions: null }),
    app.payload(null, { actions: [] }), app.payload(null, { actions: [null] }),
    app.payload({ action_id: 'rps_rock', value: 42 }),
  ];
  for (const payload of malformed) {
    const response = await app.interaction(payload);
    assert.equal(response.status, 400, JSON.stringify(payload));
  }
  const brokenJson = await app.request('/slack/interactions', { body: 'payload=%7Bbad' });
  assert.equal(brokenJson.status, 400);
  assert.equal((await app.command('rock')).status, 200);
});

test('empty action values and missing player context are handled as invalid actions', async (t) => {
  const app = await fixture(t);
  const prompt = await app.command();
  const move = buttons(prompt.json)[1];
  for (const [action, overrides] of [[{ ...move, value: '' }, {}], [move, { user: null }]]) {
    const { ack, delivery } = await app.click(action, overrides);
    assert.equal(ack.status, 200);
    assert.equal(delivery.message.response_type, 'ephemeral');
    assert.equal(delivery.message.replace_original, false);
  }
});

test('untrusted response_url is rejected before delivery or round consumption', async (t) => {
  const app = await fixture(t);
  const prompt = await app.command();
  const move = buttons(prompt.json)[1];
  const rejected = await app.click(move, { response_url: 'https://evil.example/steal' });
  assert.equal(rejected.ack.status, 400);
  assert.equal(rejected.delivery, undefined);
  const valid = await app.click(move);
  assert.match(resultText(valid.delivery.message), /You win/);
});

test('webhook failure is contained after acknowledgement and does not crash the server', async (t) => {
  const failure = new Error('simulated network failure');
  const app = await fixture(t, { sendResponse: async () => { throw failure; } });
  const prompt = await app.command();
  const { ack } = await app.click(buttons(prompt.json)[1]);
  assert.equal(ack.status, 200);
  assert.equal(app.errors.length, 1);
  assert.equal(app.errors[0], failure);
  assert.equal((await app.request('/', { method: 'GET' })).json.ok, true);
});

test('a throwing delivery error reporter cannot crash the request handler', async (t) => {
  const app = await fixture(t, {
    sendResponse: async () => { throw new Error('simulated delivery error'); },
    onDeliveryError: () => { throw new Error('simulated logger error'); },
  });
  const prompt = await app.command();
  assert.equal((await app.click(buttons(prompt.json)[1])).ack.status, 200);
  assert.equal((await app.request('/', { method: 'GET' })).json.ok, true);
});
