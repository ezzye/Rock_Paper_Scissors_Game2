# Rock • Paper • Scissors for Slack

A tiny, colourful Slack game with **no runtime dependencies**, plus a standalone browser demo.
Type `/rps`, choose 🪨 Rock, 📄 Paper or ✂️ Scissors, and see the result. `/rps paper` plays instantly.

The Slack game chooses its move before presenting the buttons and keeps that move on the server.
Button values contain an unpredictable round ID and your selected move. Each round belongs to the
player, workspace and channel that created it, expires after ten minutes and can be played once.

## Try the browser demo

Open [demo.html](demo.html) in a browser. Everything runs locally; it works offline without Slack,
a server or installation. Wins, losses and ties are counted until you close or reload the page.

Use **Save HTML** to download a fresh copy. **Share file** uses your device's file-sharing service
when supported; otherwise it downloads the HTML so you can attach it to a message or email.
Some messaging apps require the recipient to download the attachment and open it in a browser.

## Run the Slack server

Requires **Node.js 22 or later**. There are no packages to download to run the app.

1. Copy `.env.example` to `.env`.
2. Set `SLACK_SIGNING_SECRET` to the Signing Secret from your Slack app.
3. Start the server:

```sh
node --env-file=.env slack-rps.js
```

Alternatively, set `SLACK_SIGNING_SECRET` in your environment and run `npm start` or
`node slack-rps.js`. The default port is `3000`; set `PORT` to change it. `.env` is only
loaded when you pass `--env-file`. The app refuses to start without a signing secret.
Never commit your `.env` file or paste a real secret into an issue.

## Configure Slack

1. Create an app at <https://api.slack.com/apps>.
2. Under **Slash Commands**, create `/rps` with:
   - Request URL: `https://YOUR-HOST/slack/commands`
   - Description: `Play rock paper scissors`
   - Usage hint: `rock | paper | scissors`
3. Under **Interactivity & Shortcuts**, enable interactivity:
   - Request URL: `https://YOUR-HOST/slack/interactions`
4. Under **OAuth & Permissions**, add the `commands` scope and install the app to your workspace.
5. Copy the **Signing Secret** from **Basic Information** into your server's environment.

Slack must be able to reach your server over HTTPS. For local testing, use an HTTPS tunnel to
port 3000 and put its public URL into both Slack request URLs. The Node server itself serves HTTP;
terminate TLS at your tunnel, reverse proxy or hosting platform.

Then try `/rps`, `/rps rock`, `/rps paper`, `/rps scissors` and **🔁 Play again**.
Prompts and results are visible in the channel; only the player who started that round can use its buttons.

## How it works

| Request | Behaviour |
| --- | --- |
| `GET /` | Public JSON health check. |
| `POST /slack/commands` | Verifies Slack's signature, then returns a prompt or immediate result. |
| `POST /slack/interactions` | Verifies the request and action, acknowledges immediately, then posts the update to Slack's `response_url`. |

Request signatures use the original body bytes and a five-minute timestamp window. Signatures
are compared in constant time. Request bodies are limited to 64 KiB and malformed payloads return
controlled errors. Message updates only use HTTPS action webhooks on `hooks.slack.com` or
`hooks.slack-gov.com`; redirects are rejected. Callback URLs and incoming payloads are not logged.
The bot uses Node's cryptographic random number generator.

## Test

```sh
npm run check
npm test
```

The default suite uses in-process Node request/response streams, with no live Slack calls or
network listener. To exercise the same routes over real local HTTP sockets:

```sh
RPS_TEST_TRANSPORT=http npm test
```

GitHub Actions is configured to run both transports on Node 22 and 24. It covers all nine game
outcomes, request signatures, hidden bot moves, ownership, expiry, single-use rounds, malformed
payloads, body limits and message-delivery failure handling.

## Limits

- Pending rounds live in memory, with a maximum of 10,000. Restarting the server invalidates them.
  Use one running process; multiple instances need a shared round store or appropriate routing.
- The server is trusted to choose fairly. This is a casual game, without externally verifiable
  commitments, persistent scores, payments or prizes.
- A round is consumed before its Slack update is delivered. If delivery fails, run `/rps` again.
  The server logs a generic error and does not automatically retry webhook delivery.
- The browser demo has its own local score counters. Slack scores are not stored.
- End-to-end Slack installation and live message delivery need a configured Slack workspace;
  the automated suite mocks outbound delivery.

## Project files

| File | Purpose |
| --- | --- |
| [slack-rps.js](slack-rps.js) | Dependency-free Node server and game logic. |
| [demo.html](demo.html) | Offline browser game with save/share controls and accessible results. |
| [test/slack-rps.test.js](test/slack-rps.test.js) | Automated regression tests. |
| [docs/review.html](docs/review.html) | Offline review and release notes. |

Feedback and bug reports are welcome through this repository's **Issues** tab. Include the Node
version, what you tried and what happened; redact secrets and Slack response URLs.

Slack references: [request verification](https://docs.slack.dev/authentication/verifying-requests-from-slack/)
and [handling interactions](https://docs.slack.dev/interactivity/handling-user-interaction/).
