import { gatherActivity } from './gather.js';
import { generateStandup } from './summarize.js';

export async function postStandup({ slackClient, channelId }) {
  console.log('Gathering activity...');
  const activity = await gatherActivity();
  console.log(
    `Activity: ${activity.commits.length} commits, ${activity.pulls.length} PRs`,
  );

  console.log('Generating standup with Claude...');
  const message = await generateStandup(activity);

  console.log('Posting to Slack...');
  await slackClient.chat.postMessage({
    channel: channelId,
    text: message,
    mrkdwn: true,
  });
  console.log('Posted at', new Date().toISOString());
}
