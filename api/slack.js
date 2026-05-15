import 'dotenv/config';
import pkg from '@slack/bolt';
import { registerHandlers } from '../handlers.js';

const { App, ExpressReceiver } = pkg;

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: true,
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

const botUserIdRef = { id: null };
registerHandlers(app, { botUserIdRef });

export default async function handler(req, res) {
  if (!botUserIdRef.id) {
    const auth = await app.client.auth.test();
    botUserIdRef.id = auth.user_id;
  }
  return receiver.app(req, res);
}
