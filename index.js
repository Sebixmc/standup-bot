import 'dotenv/config';
import pkg from '@slack/bolt';
import { registerHandlers } from './handlers.js';

const { App } = pkg;

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
});

const botUserIdRef = { id: null };
registerHandlers(app, { botUserIdRef });

(async () => {
  const auth = await app.client.auth.test();
  botUserIdRef.id = auth.user_id;
  console.log(`Bot user ID: ${botUserIdRef.id}`);

  await app.start();
  console.log('Standup bot is running (Socket Mode, local)');
})();
