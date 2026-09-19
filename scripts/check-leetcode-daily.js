#!/usr/bin/env node

/*
 * Required environment variables:
 *   LEETCODE_USERS=username1,username2
 *   TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
 *   TELEGRAM_CHAT_ID=-1001234567890
 *
 * Node 20+ is used because it provides the built-in fetch API; no packages are
 * required.  A user counts as complete only when an accepted submission for
 * the active daily question was made on the daily challenge's UTC date.
 */

const LEETCODE_GRAPHQL_URL = 'https://leetcode.com/graphql';
const RECENT_SUBMISSION_LIMIT = 20;

const DAILY_CHALLENGE_QUERY = `
  query activeDailyCodingChallengeQuestion {
    activeDailyCodingChallengeQuestion {
      date
      link
      question {
        title
        titleSlug
      }
    }
  }
`;

const RECENT_ACCEPTED_SUBMISSIONS_QUERY = `
  query recentAcSubmissionList($username: String!, $limit: Int!) {
    recentAcSubmissionList(username: $username, limit: $limit) {
      title
      titleSlug
      timestamp
    }
  }
`;

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function leetCodeGraphQL(query, variables = {}) {
  const response = await fetch(LEETCODE_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'leetcode-daily-streak-checker/1.0',
      Referer: 'https://leetcode.com/',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`LeetCode GraphQL returned HTTP ${response.status}: ${await response.text()}`);
  }

  const body = await response.json();
  if (body.errors?.length) {
    throw new Error(`LeetCode GraphQL error: ${body.errors.map((error) => error.message).join('; ')}`);
  }
  return body.data;
}

function startOfUtcDayUnixSeconds(dateString) {
  // LeetCode supplies the active challenge date as YYYY-MM-DD. Appending Z
  // makes the boundary explicit and avoids depending on the runner timezone.
  const milliseconds = Date.parse(`${dateString}T00:00:00Z`);
  if (Number.isNaN(milliseconds)) throw new Error(`Unexpected LeetCode daily date: ${dateString}`);
  return Math.floor(milliseconds / 1000);
}

function formatList(usernames, emoji, emptyText) {
  return usernames.length ? usernames.map((username) => `${emoji} ${username}`).join('\n') : emptyText;
}

async function main() {
  const usernames = [...new Set(
    requiredEnvironment('LEETCODE_USERS')
      .split(',')
      .map((username) => username.trim())
      .filter(Boolean),
  )];
  if (!usernames.length) throw new Error('LEETCODE_USERS must contain at least one username.');

  const telegramBotToken = requiredEnvironment('TELEGRAM_BOT_TOKEN');
  const telegramChatId = requiredEnvironment('TELEGRAM_CHAT_ID');
  const dailyData = await leetCodeGraphQL(DAILY_CHALLENGE_QUERY);
  const daily = dailyData.activeDailyCodingChallengeQuestion;
  if (!daily?.question?.titleSlug || !daily.date) {
    throw new Error('LeetCode did not return an active daily challenge.');
  }

  const dailyStart = startOfUtcDayUnixSeconds(daily.date);
  const results = await Promise.all(usernames.map(async (username) => {
    try {
      const data = await leetCodeGraphQL(RECENT_ACCEPTED_SUBMISSIONS_QUERY, {
        username,
        limit: RECENT_SUBMISSION_LIMIT,
      });
      const submissions = data.recentAcSubmissionList ?? [];
      const completed = submissions.some((submission) =>
        submission.titleSlug === daily.question.titleSlug
        && Number(submission.timestamp) >= dailyStart,
      );
      return { username, completed };
    } catch (error) {
      // Treat inaccessible/unknown profiles as incomplete, while preserving
      // the reason in GitHub Actions logs for diagnosis.
      console.error(`Could not check ${username}: ${error.message}`);
      return { username, completed: false };
    }
  }));

  const completed = results.filter((result) => result.completed).map((result) => result.username);
  const notCompleted = results.filter((result) => !result.completed).map((result) => result.username);
  const message = [
    '🚀 Heyy Coders! 👋',
    `📌 Today\'s LeetCode Daily: ${daily.question.title}`,
    '⏳ There is still time—solve it now and don\'t lose your streak! 🔥',
    '',
    '✅ Completed 🎉',
    formatList(completed, '🥳', 'No one yet — go get it! 💪'),
    '',
    '⚠️ Still Pending 🚨',
    formatList(notCompleted, '👀', '🎊 Everyone has completed it!'),
  ].join('\n');

  const telegramResponse = await fetch(
    `https://api.telegram.org/bot${telegramBotToken}/sendMessage`,
    {
    method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegramChatId,
        text: message,
      }),
    },
  );
  if (!telegramResponse.ok) {
    throw new Error(`Telegram sendMessage returned HTTP ${telegramResponse.status}: ${await telegramResponse.text()}`);
  }
  const telegramBody = await telegramResponse.json();
  if (!telegramBody.ok) {
    throw new Error(`Telegram sendMessage failed: ${telegramBody.description ?? 'Unknown Telegram error'}`);
  }

  console.log(`Posted daily challenge status for ${daily.date}: ${daily.question.titleSlug}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
