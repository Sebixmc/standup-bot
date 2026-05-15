import 'dotenv/config';
import crypto from 'node:crypto';
import { WebClient } from '@slack/web-api';
import { waitUntil } from '@vercel/functions';
import {
  handleAppMentionEvent,
  handleMessageEvent,
} from '../handlers.js';
import { postStandup } from '../post-standup.js';

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

let cachedBotUserId = null;
async function getBotUserId() {
  if (cachedBotUserId) return cachedBotUserId;
  const auth = await slack.auth.test();
  cachedBotUserId = auth.user_id;
  return cachedBotUserId;
}

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function verifySlackSignature(rawBody, headers) {
  const signature = headers['x-slack-signature'];
  const timestamp = headers['x-slack-request-timestamp'];
  if (!signature || !timestamp) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 60 * 5) return false;

  const baseString = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${crypto
    .createHmac('sha256', process.env.SLACK_SIGNING_SECRET)
    .update(baseString)
    .digest('hex')}`;

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export const config = {
  api: { bodyParser: false },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    console.error('Failed to read body:', err);
    return res.status(400).json({ error: 'bad body' });
  }

  const contentType = req.headers['content-type'] || '';

  if (contentType.includes('application/json')) {
    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return res.status(400).json({ error: 'invalid json' });
    }

    if (payload.type === 'url_verification') {
      return res.status(200).json({ challenge: payload.challenge });
    }

    if (!verifySlackSignature(rawBody, req.headers)) {
      return res.status(401).json({ error: 'signature mismatch' });
    }

    if (payload.type === 'event_callback') {
      const event = payload.event;
      const work = (async () => {
        try {
          if (event.type === 'app_mention') {
            await handleAppMentionEvent({ event, slackClient: slack });
          } else if (event.type === 'message') {
            const botUserId = await getBotUserId();
            await handleMessageEvent({ event, slackClient: slack, botUserId });
          }
        } catch (err) {
          console.error(`Handler error for ${event.type}:`, err);
        }
      })();
      waitUntil(work);
      return res.status(200).end();
    }

    return res.status(200).json({ ok: true });
  }

  if (contentType.includes('application/x-www-form-urlencoded')) {
    if (!verifySlackSignature(rawBody, req.headers)) {
      return res.status(401).json({ error: 'signature mismatch' });
    }

    const params = new URLSearchParams(rawBody);
    const command = params.get('command');

    if (command === '/standup-now') {
      const work = postStandup({
        slackClient: slack,
        channelId: process.env.STANDUP_CHANNEL_ID,
      }).catch((err) => {
        console.error('Standup failed:', err);
      });
      waitUntil(work);
      return res.status(200).json({
        response_type: 'ephemeral',
        text: 'Triggering a standup now — Peter is warming up...',
      });
    }

    return res.status(200).json({
      response_type: 'ephemeral',
      text: `Unknown command: ${command}`,
    });
  }

  return res.status(400).json({ error: `unsupported content-type: ${contentType}` });
}
