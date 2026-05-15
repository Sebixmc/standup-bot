import 'dotenv/config';
import { WebClient } from '@slack/web-api';
import { postStandup } from '../post-standup.js';

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

export default async function handler(req, res) {
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (req.headers.authorization !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    await postStandup({
      slackClient: slack,
      channelId: process.env.STANDUP_CHANNEL_ID,
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Cron standup failed:', err);
    return res.status(500).json({ error: err.message });
  }
}
