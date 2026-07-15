/**
 * Discord bot: delete ALL messages from ONE fixed target user, triggered by chat commands
 * that only ONE fixed authorized user is allowed to run.
 *
 * Requirements:
 *   npm install discord.js
 *
 * Setup:
 *   1. Create a bot at https://discord.com/developers/applications
 *   2. Enable "Server Members Intent" and "Message Content Intent" in the Bot tab.
 *   3. Invite the bot to your server with "Manage Messages" and "Read Message History" permissions.
 *   4. Set DISCORD_BOT_TOKEN and GUILD_ID (env vars or edit CONFIG below).
 *   5. Run:  node deleteUserMessages.js
 *   6. In any channel the bot can see, the authorized user types:
 *        $start    -> begins (or resumes) the purge
 *        $howmuch  -> reports how many messages have been deleted so far and current status
 *      No one else can trigger either command, and it will only ever target the one
 *      hardcoded user ID below — these are not passed as arguments, so they can't be changed
 *      by typing something different in Discord.
 *
 * How it avoids getting your bot/account banned:
 *   - Uses individual message.delete() for anything older than 14 days (bulk delete
 *     silently fails / errors on those anyway).
 *   - Uses bulkDelete() only for messages under 14 days old, in batches of 100.
 *   - Adds a deliberate delay between delete calls: 1 message per 3 seconds.
 *   - Catches 429 (rate limited) responses and backs off using Discord's own Retry-After value
 *     instead of guessing.
 *   - Persists progress (last message ID processed per channel, total deleted) to a local JSON
 *     file, so if the process crashes or you restart it, it picks up where it left off.
 *   - $start refuses to run a second purge concurrently, so you can't accidentally double the
 *     request rate by triggering it twice.
 */

const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');
const fs = require('fs');
const path = require('path');

// ---------------------- CONFIG ----------------------
const CONFIG = {
  token: process.env.DISCORD_BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE',

  // Fixed and non-configurable at runtime — these are the only two IDs that matter.
  // They are hardcoded, not read from the command, so nobody can redirect the bot
  // by typing a different ID in chat.
  authorizedUserId: '1502611098765885602', // only this user can run $start / $howmuch
  targetUserId: '1453122306149974229', // this bot will only ever delete messages from this user

  guildId: process.env.GUILD_ID || 'YOUR_SERVER_ID', // set to null to scan all guilds the bot is in
  channelIds: null, // e.g. ['123456789012345678'] to restrict to specific channels; null = all text channels in the guild
  prefix: '$',
  delayBetweenDeletesMs: 3000, // pacing for individual deletes (>14 days old): 1 msg per 3 sec.
  delayBetweenBulkDeletesMs: 3000, // pacing for bulk-delete batches (<14 days old)
  fetchBatchSize: 100, // max allowed by Discord API per fetch
  progressFile: path.join(__dirname, 'purge-progress.json'),
};
// ------------------------------------------------------

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

// In-memory run state (not persisted) so $howmuch can report live status and $start can
// refuse to double-run.
const runState = {
  running: false,
  currentChannelName: null,
  channelsTotal: 0,
  channelsDone: 0,
};

function loadProgress() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG.progressFile, 'utf8'));
  } catch {
    return { channels: {}, totalDeleted: 0 };
  }
}

function saveProgress(progress) {
  fs.writeFileSync(CONFIG.progressFile, JSON.stringify(progress, null, 2));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wraps any Discord API call so that if it 429s, we wait the exact time Discord tells us to,
// then retry — instead of hammering the endpoint or giving up.
async function withRateLimitRetry(fn, label) {
  const maxRetries = 8;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRateLimit = err.httpStatus === 429 || err.status === 429 || err.code === 429;
      const retryAfterMs =
        (err.retry_after ?? err.retryAfter ?? (err.data && err.data.retry_after)) * 1000 ||
        2000 * attempt;

      if (isRateLimit) {
        console.warn(`[rate limit] ${label}: waiting ${Math.round(retryAfterMs)}ms (attempt ${attempt})`);
        await sleep(retryAfterMs);
        continue;
      }

      // Message already gone, unknown message, missing access etc. — log and move on.
      if ([10008, 50001, 50013].includes(err.code)) {
        console.warn(`[skip] ${label}: ${err.message}`);
        return null;
      }

      // Unknown error — brief backoff then retry, don't crash the whole run.
      console.error(`[error] ${label}: ${err.message} (attempt ${attempt})`);
      await sleep(3000 * attempt);
    }
  }
  console.error(`[giving up] ${label} after ${maxRetries} attempts`);
  return null;
}

async function purgeChannel(channel, progress) {
  const channelId = channel.id;
  progress.channels[channelId] = progress.channels[channelId] || { before: null, done: false };
  const state = progress.channels[channelId];

  runState.currentChannelName = channel.name;

  if (state.done) {
    console.log(`[skip] #${channel.name} already marked complete.`);
    runState.channelsDone += 1;
    return;
  }

  console.log(`\n== Scanning #${channel.name} (${channelId}) ==`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const fetchOptions = { limit: CONFIG.fetchBatchSize };
    if (state.before) fetchOptions.before = state.before;

    const messages = await withRateLimitRetry(
      () => channel.messages.fetch(fetchOptions),
      `fetch messages in #${channel.name}`
    );

    if (!messages || messages.size === 0) {
      console.log(`#${channel.name}: reached the beginning of the channel history.`);
      state.done = true;
      saveProgress(progress);
      runState.channelsDone += 1;
      break;
    }

    // Track oldest message id in this batch for the next `before` cursor,
    // regardless of author, so we keep walking backward through history.
    const sorted = [...messages.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
    const oldestInBatch = sorted[sorted.length - 1];
    state.before = oldestInBatch.id;

    const targetMessages = sorted.filter((m) => m.author.id === CONFIG.targetUserId);

    if (targetMessages.length > 0) {
      const now = Date.now();
      const recent = targetMessages.filter((m) => now - m.createdTimestamp < FOURTEEN_DAYS_MS);
      const old = targetMessages.filter((m) => now - m.createdTimestamp >= FOURTEEN_DAYS_MS);

      // Bulk delete for anything under 14 days (max 100 per call, needs 2+ messages).
      if (recent.length >= 2) {
        await withRateLimitRetry(
          () => channel.bulkDelete(recent, true),
          `bulkDelete ${recent.length} msgs in #${channel.name}`
        );
        progress.totalDeleted += recent.length;
        console.log(`  bulk-deleted ${recent.length} recent messages (running total: ${progress.totalDeleted})`);
        await sleep(CONFIG.delayBetweenBulkDeletesMs);
      } else if (recent.length === 1) {
        old.push(recent[0]); // single message must go through individual delete path
      }

      // Individual delete for anything 14+ days old, paced at 1 per 3 seconds.
      for (const msg of old) {
        await withRateLimitRetry(() => msg.delete(), `delete msg ${msg.id}`);
        progress.totalDeleted += 1;
        if (progress.totalDeleted % 25 === 0) {
          console.log(`  ...running total deleted: ${progress.totalDeleted}`);
        }
        await sleep(CONFIG.delayBetweenDeletesMs);
      }

      saveProgress(progress);
    }
  }
}

async function runPurge(client, replyChannel) {
  if (runState.running) {
    await replyChannel.send('A purge is already running — use `$howmuch` to check progress.');
    return;
  }

  runState.running = true;
  runState.channelsDone = 0;

  try {
    const progress = loadProgress();
    const guilds = CONFIG.guildId ? [client.guilds.cache.get(CONFIG.guildId)] : [...client.guilds.cache.values()];

    let allTargetChannels = [];
    for (const guild of guilds) {
      if (!guild) {
        console.error('Guild not found — check GUILD_ID.');
        continue;
      }
      const me = await guild.members.fetchMe();
      if (!me.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
        console.error(`Bot lacks Manage Messages permission in ${guild.name}, skipping.`);
        continue;
      }
      const allChannels = [...guild.channels.cache.values()].filter((c) => c.isTextBased() && !c.isThread());
      const targetChannels = CONFIG.channelIds
        ? allChannels.filter((c) => CONFIG.channelIds.includes(c.id))
        : allChannels;
      allTargetChannels = allTargetChannels.concat(targetChannels);
    }

    runState.channelsTotal = allTargetChannels.length;
    await replyChannel.send(
      `Starting purge on <@${CONFIG.targetUserId}> across ${allTargetChannels.length} channel(s), ` +
        `pacing 1 delete / 3 sec. Use \`$howmuch\` anytime for progress.`
    );

    for (const channel of allTargetChannels) {
      try {
        await purgeChannel(channel, progress);
      } catch (err) {
        console.error(`Unrecoverable error in #${channel.name}, moving to next channel:`, err.message);
        runState.channelsDone += 1;
      }
    }

    await replyChannel.send(
      `Purge finished. Total messages deleted so far (all-time): ${progress.totalDeleted}.`
    );
  } finally {
    runState.running = false;
    runState.currentChannelName = null;
  }
}

async function main() {
  if (CONFIG.token === 'YOUR_BOT_TOKEN_HERE') {
    console.error('Set DISCORD_BOT_TOKEN (env var or in the CONFIG block) before running.');
    process.exit(1);
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}. Waiting for ${CONFIG.prefix}start / ${CONFIG.prefix}howmuch`);
  });

  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.content.startsWith(CONFIG.prefix)) return;

    // Hard-gated: only the one hardcoded authorized user can trigger anything, no matter
    // what channel or server the command is typed in.
    if (message.author.id !== CONFIG.authorizedUserId) return;

    const command = message.content.slice(CONFIG.prefix.length).trim().toLowerCase();

    if (command === 'start') {
      runPurge(client, message.channel).catch((err) => {
        console.error('runPurge crashed:', err);
        runState.running = false;
        message.channel.send('Purge stopped due to an unexpected error — check the bot logs.');
      });
      return;
    }

    if (command === 'howmuch') {
      const progress = loadProgress();
      const deleted = progress.totalDeleted || 0;

      if (!runState.running) {
        await message.channel.send(
          `Not currently running. Total deleted so far (all-time): ${deleted}. ` +
            `Run \`$start\` to begin or resume.`
        );
        return;
      }

      const channelsLeft = Math.max(runState.channelsTotal - runState.channelsDone, 0);
      await message.channel.send(
        `Still running. Total deleted so far: ${deleted}.\n` +
          `Currently scanning: #${runState.currentChannelName ?? 'unknown'}\n` +
          `Channels finished: ${runState.channelsDone}/${runState.channelsTotal} (${channelsLeft} left to scan).\n` +
          `Note: the exact number of remaining messages from this user isn't knowable until each ` +
          `channel's full history has been scanned, since old messages have to be found one page at a time.`
      );
      return;
    }
  });

  client.login(CONFIG.token);
}

main();
