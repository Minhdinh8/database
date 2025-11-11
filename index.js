/*
  index.js
  - Discord bot using discord.js v14
  - Express web UI server
  - No slash commands. Buttons + modals for interactions.

  Environment variables:
  - DISCORD_TOKEN (required)
  - PORT (optional, default 3000)
  - OWNER_ID (optional) - a numeric Discord ID allowed to use some admin APIs via web UI
*/

require('dotenv').config();
const fs = require('fs-extra');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  Events,
  EmbedBuilder,
  InteractionType
} = require('discord.js');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');

const DATA_DIR = path.join(__dirname, 'data');
fs.ensureDirSync(DATA_DIR);

const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const TRACKED_PATH = path.join(DATA_DIR, 'tracked.json');

// Default config
const defaultConfig = {
  trackedChannelIds: [], // channels to scan
  displayChannelId: null, // where to post summary
  displayMessageId: null, // saved message id of the summary to edit
  updateIntervalMinutes: 30,
  buckets: {
    weekly: true,
    biweekly: false,
    monthly: false,
    custom: []
  },
  ownerId: process.env.OWNER_ID || null
};

const defaultTracked = {
  entries: [], // {id, channelId, messageId, timestamp, coin, coinAmount, usdAmount, winnerId, source}
  summary: {
    totalsByBucket: {},
    leaderboard: {},
    distribution: { Tip: 0, 'Stream Giveaway': 0, Others: 0 }
  }
};

function loadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return fs.readJsonSync(filePath);
  } catch (e) {
    console.error('Failed to load', filePath, e);
    return fallback;
  }
}

function saveJson(filePath, obj) {
  fs.writeJsonSync(filePath, obj, { spaces: 2 });
}

let config = loadJson(CONFIG_PATH, defaultConfig);
let tracked = loadJson(TRACKED_PATH, defaultTracked);

// Save initial files if missing
saveJson(CONFIG_PATH, config);
saveJson(TRACKED_PATH, tracked);

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error('Missing DISCORD_TOKEN in environment. Exiting.');
  process.exit(1);
}

// Create Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// Regex to find patterns like 100TRX/50$ or 5BTC/200$
const GIVEAWAY_REGEX = /(?:(\d{1,6}(?:\.\d{1,6})?))\s*([A-Za-z]{1,5})\s*\/\s*(\d{1,6}(?:\.\d{1,2})?)\s*\$/g;

function parseGiveawaysFromText(text) {
  const results = [];
  let m;
  while ((m = GIVEAWAY_REGEX.exec(text)) !== null) {
    // m[1] coin amount, m[2] coin symbol, m[3] usd amount
    const coinAmount = parseFloat(m[1]);
    const coin = m[2].toUpperCase();
    const usdAmount = parseFloat(m[3]);
    results.push({ coin, coinAmount, usdAmount });
  }
  return results;
}

// Utility to add an entry
function addTrackedEntry(entry) {
  entry.id = `${Date.now()}-${Math.floor(Math.random()*10000)}`;
  tracked.entries.push(entry);
  // update leaderboard and distribution
  if (entry.winnerId) {
    tracked.summary.leaderboard[entry.winnerId] = tracked.summary.leaderboard[entry.winnerId] || { wins:0, totalUsd:0 };
    tracked.summary.leaderboard[entry.winnerId].wins += 1;
    tracked.summary.leaderboard[entry.winnerId].totalUsd += (entry.usdAmount || 0);
  }
  const src = entry.source || 'Others';
  tracked.summary.distribution[src] = (tracked.summary.distribution[src] || 0) + (entry.usdAmount || 0);
  saveJson(TRACKED_PATH, tracked);
}

// Rescan logic: fetch recent messages from configured channels and parse
async function rescanChannels() {
  console.log('Rescanning channels at', new Date().toISOString());
  for (const chId of config.trackedChannelIds) {
    try {
      const ch = await client.channels.fetch(chId).catch(()=>null);
      if (!ch || !ch.isTextBased()) continue;

      // Fetch last 200 messages
      const fetched = await ch.messages.fetch({ limit: 200 }).catch(()=>null);
      if (!fetched) continue;
      for (const msg of fetched.values()) {
        // ignore embeds (message contains embeds array) and skip bot messages
        if (msg.author?.bot) continue;
        if (msg.embeds && msg.embeds.length > 0) continue;
        if (!msg.content) continue;

        const found = parseGiveawaysFromText(msg.content);
        if (found.length === 0) continue;

        // check if we've already recorded this message
        const already = tracked.entries.find(e => e.messageId === msg.id && e.channelId === msg.channelId);
        if (already) continue;

        // attempt to get winner mention
        let winnerId = null;
        if (msg.mentions && msg.mentions.users && msg.mentions.users.size > 0) {
          winnerId = msg.mentions.users.first().id;
        }

        for (const f of found) {
          const entry = {
            channelId: msg.channelId,
            messageId: msg.id,
            timestamp: msg.createdTimestamp,
            coin: f.coin,
            coinAmount: f.coinAmount,
            usdAmount: f.usdAmount,
            winnerId,
            source: 'Others' // default; user can change via import or later edit in UI
          };
          addTrackedEntry(entry);
        }
      }
    } catch (e) {
      console.error('Error rescanning channel', chId, e);
    }
  }
}

// Build a summary embed to post in display channel
function buildSummaryEmbed() {
  // compute totals per bucket (simple naive calcs here)
  const now = Date.now();
  const oneDay = 24*60*60*1000;
  const totals = { weekly:0, biweekly:0, monthly:0, all:0 };
  for (const e of tracked.entries) {
    const age = now - e.timestamp;
    totals.all += (e.usdAmount || 0);
    if (age <= 7*oneDay) totals.weekly += (e.usdAmount || 0);
    if (age <= 14*oneDay) totals.biweekly += (e.usdAmount || 0);
    if (age <= 30*oneDay) totals.monthly += (e.usdAmount || 0);
  }

  // leaderboard: sort by totalUsd then wins
  const lb = Object.entries(tracked.summary.leaderboard || {}).map(([id, obj]) => ({ id, wins: obj.wins, totalUsd: obj.totalUsd }));
  lb.sort((a,b) => {
    if (b.totalUsd !== a.totalUsd) return b.totalUsd - a.totalUsd;
    return b.wins - a.wins;
  });

  const embed = new EmbedBuilder()
    .setTitle('Giveaway Data Track - Summary')
    .setTimestamp(new Date())
    .setFooter({ text: `Updated every ${config.updateIntervalMinutes} minutes` });

  embed.addFields(
    { name: 'Totals (USD)', value: `All time: $${totals.all.toFixed(2)}\nWeekly: $${totals.weekly.toFixed(2)}\nBiweekly: $${totals.biweekly.toFixed(2)}\nMonthly: $${totals.monthly.toFixed(2)}`, inline: true },
    { name: 'Prize Distribution', value: `Tip: $${(tracked.summary.distribution['Tip']||0).toFixed(2)}\nStream Giveaway: $${(tracked.summary.distribution['Stream Giveaway']||0).toFixed(2)}\nOthers: $${(tracked.summary.distribution['Others']||0).toFixed(2)}`, inline: true }
  );

  let lbText = lb.length ? lb.slice(0,10).map((row, i) => `#${i+1} <@${row.id}> — $${row.totalUsd.toFixed(2)} (${row.wins} wins)`).join('\n') : 'No winners tracked yet';
  embed.addFields({ name: 'Leaderboard (top)', value: lbText, inline: false });

  return embed;
}

// Post or edit display message
async function updateDisplayMessage() {
  if (!config.displayChannelId) return;
  try {
    const ch = await client.channels.fetch(config.displayChannelId).catch(()=>null);
    if (!ch || !ch.isTextBased()) return;

    const embed = buildSummaryEmbed();

    // Buttons: Import
    const importBtn = new ButtonBuilder().setCustomId('import_manual').setLabel('Import').setStyle(ButtonStyle.Success);
    const components = [ new ActionRowBuilder().addComponents(importBtn) ];

    if (config.displayMessageId) {
      // try edit
      try {
        const msg = await ch.messages.fetch(config.displayMessageId);
        if (msg) {
          await msg.edit({ embeds: [embed], components });
          return;
        }
      } catch (e) {
        // will create new
      }
    }

    const sent = await ch.send({ embeds: [embed], components });
    config.displayMessageId = sent.id;
    saveJson(CONFIG_PATH, config);

  } catch (e) {
    console.error('Failed to update display message', e);
  }
}

// Interval loop to rescan and update display
async function periodicWork() {
  await rescanChannels();
  await updateDisplayMessage();
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  // run immediately then start interval
  periodicWork().catch(console.error);
  setInterval(periodicWork, config.updateIntervalMinutes * 60 * 1000);
});

// messageCreate listener to catch new messages in tracked channels in near-real-time
client.on('messageCreate', async (msg) => {
  if (msg.author?.bot) return;
  if (!config.trackedChannelIds.includes(msg.channelId)) return;
  if (msg.embeds && msg.embeds.length > 0) return;
  if (!msg.content) return;

  const found = parseGiveawaysFromText(msg.content);
  if (!found.length) return;

  let winnerId = null;
  if (msg.mentions && msg.mentions.users && msg.mentions.users.size > 0) {
    winnerId = msg.mentions.users.first().id;
  }

  for (const f of found) {
    addTrackedEntry({
      channelId: msg.channelId,
      messageId: msg.id,
      timestamp: msg.createdTimestamp,
      coin: f.coin,
      coinAmount: f.coinAmount,
      usdAmount: f.usdAmount,
      winnerId,
      source: 'Others'
    });
  }
});

// Interaction handler for buttons and modals
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton()) {
      if (interaction.customId === 'import_manual') {
        // show a modal to input amount (usd) and coin (optional)
        const modal = new ModalBuilder().setCustomId('modal_import_manual').setTitle('Import manual giveaway');

        const amountInput = new TextInputBuilder().setCustomId('usdAmount').setLabel('USD amount').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. 50');
        const coinInput = new TextInputBuilder().setCustomId('coinSymbol').setLabel('Coin (optional)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('e.g. TRX');

        const row1 = new ActionRowBuilder().addComponents(amountInput);
        const row2 = new ActionRowBuilder().addComponents(coinInput);
        modal.addComponents(row1, row2);

        await interaction.showModal(modal);
      }

      // other buttons can be added here
    } else if (interaction.type === InteractionType.ModalSubmit) {
      if (interaction.customId === 'modal_import_manual') {
        const usdAmount = parseFloat(interaction.fields.getTextInputValue('usdAmount')) || 0;
        const coin = (interaction.fields.getTextInputValue('coinSymbol') || 'N/A').toUpperCase();

        // Ask how this money was given — present buttons (Tip / Stream Giveaway / Others)
        const tipBtn = new ButtonBuilder().setCustomId(`import_src_Tip_${Date.now()}`).setLabel('Tip').setStyle(ButtonStyle.Primary);
        const streamBtn = new ButtonBuilder().setCustomId(`import_src_Stream Giveaway_${Date.now()}`).setLabel('Stream Giveaway').setStyle(ButtonStyle.Primary);
        const othersBtn = new ButtonBuilder().setCustomId(`import_src_Others_${Date.now()}`).setLabel('Others').setStyle(ButtonStyle.Secondary);

        await interaction.reply({ content: `Importing $${usdAmount.toFixed(2)} (coin ${coin}). Choose source:`, components: [ new ActionRowBuilder().addComponents(tipBtn, streamBtn, othersBtn) ], ephemeral: true });

        // store a temporary record in-memory to be used when the user presses source button
        // simple approach: keep it in a small map
        interaction.client._lastImport = { byUser: interaction.user.id, usdAmount, coin };
      }
    } else if (interaction.isButton()) {
      // handled earlier
    }

    // Handle import source buttons by matching customId prefix
    if (interaction.isButton() && interaction.customId.startsWith('import_src_')) {
      const parts = interaction.customId.split('_');
      // format import_src_{Source}_{ts}
      const source = parts.slice(2, parts.length-1).join('_') || parts[2];
      const payload = interaction.client._lastImport;
      if (!payload || payload.byUser !== interaction.user.id) {
        await interaction.reply({ content: 'No recent import found or you are not the owner of the import.', ephemeral: true });
        return;
      }
      // commit entry
      addTrackedEntry({
        channelId: 'manual_import',
        messageId: `import-${Date.now()}`,
        timestamp: Date.now(),
        coin: payload.coin,
        coinAmount: 0,
        usdAmount: payload.usdAmount,
        winnerId: interaction.user.id,
        source: source
      });

      await interaction.update({ content: `Imported $${payload.usdAmount.toFixed(2)} as ${source}.`, components: [] });
      // update display too
      await updateDisplayMessage();
    }

  } catch (e) {
    console.error('Interaction error', e);
    try { if (interaction.replied || interaction.deferred) await interaction.followUp({ content: 'Error handling interaction', ephemeral: true }); else await interaction.reply({ content: 'Error handling interaction', ephemeral: true }); } catch(e){}
  }
});

// Start Express web UI
const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// simple auth middleware: only allow ownerId if configured (optional), else open
function requireOwner(req, res, next) {
  if (!config.ownerId) return next();
  const user = req.header('x-user-id');
  if (!user || user !== config.ownerId) return res.status(403).json({ error: 'forbidden' });
  next();
}

app.get('/api/config', (req, res) => {
  res.json(config);
});

app.post('/api/config', requireOwner, (req, res) => {
  const body = req.body;
  // allow updating trackedChannelIds, displayChannelId, buckets, updateIntervalMinutes
  if (Array.isArray(body.trackedChannelIds)) config.trackedChannelIds = body.trackedChannelIds;
  if (body.displayChannelId) config.displayChannelId = body.displayChannelId;
  if (body.updateIntervalMinutes) config.updateIntervalMinutes = body.updateIntervalMinutes;
  if (body.buckets) config.buckets = body.buckets;
  saveJson(CONFIG_PATH, config);
  res.json({ ok: true, config });
});

app.get('/api/tracked', (req, res) => {
  res.json(tracked);
});

app.post('/api/triggerScan', requireOwner, async (req, res) => {
  try {
    await rescanChannels();
    await updateDisplayMessage();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'failed' });
  }
});

// run server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Web UI available at http://localhost:${PORT}`));

// login bot
client.login(TOKEN);
