import Anthropic from '@anthropic-ai/sdk';
import { Octokit } from '@octokit/rest';
import { postStandup } from './post-standup.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

const CLASSIFIER_SYSTEM_PROMPT = `You read a single Slack reply written by an engineer during a standup thread and decide whether it contains a durable architectural or product decision worth capturing in the project's specs.

A "decision" is a choice the team is making about how the system will work, and that someone reading the repo six months from now would want to know about. Examples that ARE decisions:
- "Let's use Zod for all validation at the API boundary."
- "The quote-rounding rule is always half-up to the nearest cent."
- "We're going to extract phone numbers in the LLM step, not in regex."
- "Caching layer skips Supabase RLS by design — service role only."

Examples that are NOT decisions:
- "Still working on it."
- "I'll look at PR #44 after lunch."
- "What do you think about X?" (a question, not a choice)
- "Yeah" / "Sounds good" / "+1" (acknowledgment without content)
- "Yesterday I fixed the Whisper timeout." (status update, not a forward-looking decision)

You must reply with valid JSON only — no prose, no markdown fences, no explanation. Schema:
{
  "is_decision": boolean,
  "summary": string,    // one sentence summarizing the decision in plain language. Empty string if is_decision is false.
  "topic_slug": string  // 2-4 word kebab-case slug describing the decision area, e.g. "json-validation" or "rounding-policy". Empty string if is_decision is false.
}`;

function sanitizeSlug(slug) {
  const cleaned = slug
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned || 'untitled';
}

function extractJson(text) {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return (fenceMatch ? fenceMatch[1] : text).trim();
}

async function classifyReply(text) {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 500,
    system: CLASSIFIER_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: text }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) return null;

  try {
    return JSON.parse(extractJson(textBlock.text));
  } catch {
    console.warn('Classifier returned non-JSON:', textBlock.text);
    return null;
  }
}

async function openDecisionPR({ summary, slug, sourceText, threadUrl }) {
  const owner = process.env.REPO_OWNER;
  const repo = process.env.REPO_NAME;
  const timestamp = Date.now();
  const safeSlug = sanitizeSlug(slug);
  const branch = `standup-decision-${safeSlug}-${timestamp}`;
  const path = `docs/decisions/${safeSlug}.md`;
  const today = new Date().toISOString().split('T')[0];

  const content = `# Decision: ${summary}

Captured from standup on ${today}.

## Summary

${summary}

## Source

This decision was surfaced in a standup Slack thread:
${threadUrl}

## Original message

> ${sourceText.split('\n').join('\n> ')}

---

_Auto-captured by Standup Bot. Edit this file as needed before merging._
`;

  const { data: mainRef } = await octokit.git.getRef({
    owner,
    repo,
    ref: 'heads/main',
  });

  await octokit.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branch}`,
    sha: mainRef.object.sha,
  });

  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    message: `Capture decision: ${summary}`,
    content: Buffer.from(content).toString('base64'),
    branch,
  });

  const { data: pr } = await octokit.pulls.create({
    owner,
    repo,
    title: `Capture decision: ${summary}`,
    head: branch,
    base: 'main',
    body: `Auto-captured from a standup reply.

**Decision:** ${summary}

**Source thread:** ${threadUrl}

Please review and merge if accurate, or close if this should not be persisted as a spec.`,
  });

  return pr;
}

function buildSlackThreadUrl(channel, threadTs) {
  return `https://slack.com/archives/${channel}/p${threadTs.replace('.', '')}`;
}

export function registerHandlers(app, { botUserIdRef }) {
  app.command('/standup-now', async ({ ack, respond }) => {
    await ack();
    try {
      await respond({
        response_type: 'ephemeral',
        text: 'Triggering a standup now — Peter is warming up...',
      });
      await postStandup({
        slackClient: app.client,
        channelId: process.env.STANDUP_CHANNEL_ID,
      });
    } catch (err) {
      console.error('Standup failed:', err);
      await respond({
        response_type: 'ephemeral',
        text: `Standup failed: ${err.message}`,
      });
    }
  });

  app.event('app_mention', async ({ event, say }) => {
    await say(
      `I hear you, <@${event.user}>. Type \`/standup-now\` to trigger a manual standup.`,
    );
  });

  app.event('message', async ({ event }) => {
    console.log('[msg event]', {
      channel: event.channel,
      thread_ts: event.thread_ts || null,
      user: event.user,
      subtype: event.subtype || 'none',
      textPreview: (event.text || '').slice(0, 60),
    });

    if (event.channel !== process.env.STANDUP_CHANNEL_ID) {
      console.log('  -> skipped: wrong channel');
      return;
    }
    if (!event.thread_ts) {
      console.log('  -> skipped: not a thread reply');
      return;
    }
    if (event.user === botUserIdRef.id) {
      console.log('  -> skipped: bot itself');
      return;
    }
    if (event.subtype) {
      console.log(`  -> skipped: subtype=${event.subtype}`);
      return;
    }
    if (!event.text || event.text.trim().length < 8) {
      console.log('  -> skipped: too short');
      return;
    }

    console.log(`Classifying reply from ${event.user}: ${event.text.slice(0, 60)}...`);

    let parsed;
    try {
      parsed = await classifyReply(event.text);
    } catch (err) {
      console.error('Classifier API error:', err.message);
      return;
    }

    if (!parsed || !parsed.is_decision) {
      console.log('Not a decision. Skipping.');
      return;
    }

    console.log(`Decision detected: ${parsed.summary}`);

    const threadUrl = buildSlackThreadUrl(event.channel, event.thread_ts);

    try {
      const pr = await openDecisionPR({
        summary: parsed.summary,
        slug: parsed.topic_slug,
        sourceText: event.text,
        threadUrl,
      });

      await app.client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts,
        text: `I captured this as a decision and opened ${pr.html_url} for review.`,
      });
      console.log(`Opened PR #${pr.number}: ${pr.html_url}`);
    } catch (err) {
      console.error('Failed to open PR:', err.message);
      await app.client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts,
        text: `I detected a decision here but couldn't open a PR: ${err.message}`,
      });
    }
  });
}
