'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const sharp = require('sharp');

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder,
  MessageFlags
} = require('discord.js');

const { validate, result } = require('./engine');

const {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_GUILD_ID,
  ADMIN_ROLE_ID
} = process.env;

if (
  !DISCORD_TOKEN ||
  !DISCORD_CLIENT_ID ||
  !DISCORD_GUILD_ID
) {
  throw Error('Missing Discord environment variables.');
}

const dir =
  process.env.DATA_DIR || path.join(__dirname, 'data');

if (
  process.env.RAILWAY_ENVIRONMENT_ID &&
  !process.env.DATA_DIR
) {
  throw Error(
    'Set DATA_DIR to your persistent volume mount path.'
  );
}

fs.mkdirSync(dir, { recursive: true });

const file = path.join(dir, 'replay.json');

let db = fs.existsSync(file)
  ? JSON.parse(fs.readFileSync(file, 'utf8'))
  : {
      version: 1,
      season: 1,
      scenarios: {},
      rounds: {}
    };

if (
  db.version !== 1 ||
  !db.scenarios ||
  !db.rounds
) {
  throw Error(
    'Invalid database. Restore a backup; do not delete the volume.'
  );
}

function commit(fn) {
  const next = structuredClone(db);

  fn(next);

  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');

  try {
    fs.writeFileSync(fd, JSON.stringify(next));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  fs.renameSync(tmp, file);

  db = next;
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const E = MessageFlags.Ephemeral;
const green = 0x39D98A;

function emb(title, text) {
  return new EmbedBuilder()
    .setColor(green)
    .setTitle(title)
    .setDescription(text)
    .setFooter({
      text: 'THE FLOOR 8 • TRADE REPLAY • Simulation only'
    });
}

function button(
  id,
  label,
  style = ButtonStyle.Secondary
) {
  return new ButtonBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(style);
}

function row(...components) {
  return new ActionRowBuilder()
    .addComponents(components);
}

function admin(i) {
  return (
    i.memberPermissions?.has(
      PermissionFlagsBits.Administrator
    ) ||
    Boolean(
      ADMIN_ROLE_ID &&
      i.member?.roles?.cache?.has(ADMIN_ROLE_ID)
    )
  );
}

function round(id) {
  const r = db.rounds[id];

  if (!r) {
    throw Error('Replay not found.');
  }

  return r;
}

function scenario(r) {
  return db.scenarios[r.scenario];
}

function xml(value) {
  return String(value).replace(
    /[&<>"']/g,
    c => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&apos;'
    }[c])
  );
}

async function chart(s, full = false, p = null) {
  const candles = full
    ? s.candles
    : s.candles.slice(0, s.visible);

  const W = 1100;
  const H = 580;
  const L = 75;
  const R = 1025;
  const T = 75;
  const B = 500;

  let low = Math.min(...candles.map(c => c.low));
  let high = Math.max(...candles.map(c => c.high));

  const padding = (high - low) * 0.12 || high * 0.01;

  low -= padding;
  high += padding;

  const y = value =>
    B - (value - low) / (high - low) * (B - T);

  const dx = (R - L) / candles.length;

  let svg = `
    <svg xmlns="http://www.w3.org/2000/svg"
      width="${W}" height="${H}">
      <rect width="100%" height="100%" fill="#10181e"/>
      <text x="30" y="35" fill="#39d98a"
        font-size="22" font-family="sans-serif">
        TRADE REPLAY | ${xml(s.asset)} |
        ${xml(s.timeframe)}
        ${s.kind === 'demo' ? ' | DEMO' : ''}
      </text>
  `;

  for (let n = 0; n < 6; n++) {
    const value = low + (high - low) * n / 5;
    const Y = y(value);

    svg += `
      <path d="M${L},${Y}H${R}" stroke="#28333d"/>
      <text x="8" y="${Y + 4}"
        fill="#9daeb8" font-size="12">
        ${value.toPrecision(5)}
      </text>
    `;
  }

  candles.forEach((c, j) => {
    const X = L + dx * (j + 0.5);

    const color =
      c.close >= c.open ? '#39d98a' : '#fa6673';

    svg += `
      <path d="M${X},${y(c.high)}V${y(c.low)}"
        stroke="${color}"/>
      <rect
        x="${X - dx * 0.3}"
        y="${Math.min(y(c.open), y(c.close))}"
        width="${dx * 0.6}"
        height="${Math.max(
          2,
          Math.abs(y(c.open) - y(c.close))
        )}"
        fill="${color}"/>
    `;
  });

  const price = s.candles[s.visible - 1].close;

  function line(value, label, color) {
    if (value < low || value > high) return;

    svg += `
      <path d="M${L},${y(value)}H${R}"
        stroke="${color}" stroke-dasharray="6 5"/>
      <text x="${L + 5}" y="${y(value) - 6}"
        fill="${color}" font-size="13">
        ${label}
      </text>
    `;
  }

  line(price, 'ENTRY', '#f5cf68');

  if (full) {
    const X = L + dx * s.visible;

    svg += `
      <path d="M${X},${T}V${B}"
        stroke="white" stroke-dasharray="4 6"/>
    `;

    if (p && p.side !== 'skip') {
      const direction = p.side === 'long' ? 1 : -1;

      line(
        price * (1 - direction * p.stop / 100),
        'STOP',
        '#fa6673'
      );

      line(
        price * (1 + direction * p.target / 100),
        'TARGET',
        '#39d98a'
      );
    }
  }

  const caption = full
    ? 'AFTER THE DECISION | ' + xml(s.source)
    : 'FUTURE HIDDEN | Choose your plan before the reveal';

  svg += `
    <text x="75" y="545" fill="#adbac3"
      font-size="15" font-family="sans-serif">
      ${caption}
    </text>
    </svg>
  `;

  const image = await sharp(Buffer.from(svg))
    .png()
    .toBuffer();

  return new AttachmentBuilder(image, {
    name: 'chart.png'
  });
}

function controls(r) {
  return [
    row(
      button(
        `pick:${r.id}:long`,
        '↗ Buy',
        ButtonStyle.Success
      ),
      button(
        `pick:${r.id}:short`,
        '↘ Sell',
        ButtonStyle.Danger
      ),
      button(`pick:${r.id}:skip`, '⏸ No trade')
    ),
    row(
      button(`mine:${r.id}`, 'My decision'),
      button(`reveal:${r.id}`, 'View replay'),
      button('rank', '🏆 Leaderboard')
    )
  ];
}

function publicEmbed(r) {
  const s = scenario(r);

  const demo = s.kind === 'demo'
    ? '\n🧪 **Fictional demo, not historical prices.**'
    : '';

  return emb(
    s.title,
    `**${s.asset} · ${s.timeframe}**${demo}

${s.context}

📍 Entry: **${s.candles[s.visible - 1].close}**

**Buy, sell or sit this one out?**
Choose your direction, stop and target. Confirm once.

⏳ Decisions close <t:${Math.floor(r.close / 1000)}:F>

The full chart and results unlock after the deadline.

**One confirmed decision per member.**`
  ).setImage('attachment://chart.png');
}

function leaders() {
  const users = {};

  for (const r of Object.values(db.rounds)) {
    if (
      r.season !== db.season ||
      Date.now() < r.close ||
      r.cancelled
    ) {
      continue;
    }

    for (const [userId, pick] of Object.entries(r.picks)) {
      const value = result(scenario(r), pick);

      const member = users[userId] ??= {
        id: userId,
        points: 0,
        played: 0,
        r: 0
      };

      member.points += value.points;
      member.played++;
      member.r += value.r;
    }
  }

  return Object.values(users).sort(
    (a, b) =>
      b.points - a.points ||
      a.id.localeCompare(b.id)
  );
}

function board() {
  const list = leaders();

  const text = list.length
    ? list.slice(0, 10).map(member => {
        const rank =
          list.findIndex(
            item => item.points === member.points
          ) + 1;

        return (
          `**${rank}.** <@${member.id}> · ` +
          `**${member.points} pts** · ` +
          `${member.played} replays`
        );
      }).join('\n') +
      '\n\nEqual scores are tied. ' +
      'Display order does not break ties.'
    : 'No settled replays yet.';

  return emb(
    `Trade Replay · Season ${db.season}`,
    text
  );
}

const cmd = new SlashCommandBuilder()
  .setName('replay')
  .setDescription('Trade Replay');

cmd.addSubcommand(c =>
  c.setName('leaderboard')
    .setDescription('View the top 10')
);

cmd.addSubcommand(c =>
  c.setName('import')
    .setDescription('Admin: import a scenario JSON')
    .addAttachmentOption(o =>
      o.setName('file')
        .setDescription('Scenario JSON')
        .setRequired(true)
    )
);

cmd.addSubcommand(c =>
  c.setName('publish')
    .setDescription('Admin: publish a replay')
    .addStringOption(o =>
      o.setName('scenario')
        .setDescription('Scenario ID')
        .setRequired(true)
    )
    .addChannelOption(o =>
      o.setName('channel')
        .setDescription('Public game channel')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName('closes')
        .setDescription(
          'ISO date, e.g. 2026-11-05T18:00:00+01:00'
        )
        .setRequired(true)
    )
);

cmd.addSubcommand(c =>
  c.setName('list')
    .setDescription('Admin: list scenarios and rounds')
);

cmd.addSubcommand(c =>
  c.setName('close')
    .setDescription(
      'Admin: close now and unlock results'
    )
    .addStringOption(o =>
      o.setName('id')
        .setDescription('Replay ID')
        .setRequired(true)
    )
);

cmd.addSubcommand(c =>
  c.setName('export')
    .setDescription('Admin: export season standings')
);

cmd.addSubcommand(c =>
  c.setName('backup')
    .setDescription('Admin: download a full backup')
);

cmd.addSubcommand(c =>
  c.setName('reset')
    .setDescription(
      'Admin: start a new season; keep archives'
    )
    .addStringOption(o =>
      o.setName('confirmation')
        .setDescription('Type RESET')
        .setRequired(true)
    )
);

function check(r, i) {
  if (r.guild !== i.guildId || r.cancelled) {
    throw Error('Replay unavailable.');
  }
}

function open(r, i) {
  check(r, i);

  if (Date.now() >= r.close) {
    throw Error(
      'Decisions are closed. Use View replay.'
    );
  }

  if (r.picks[i.user.id]) {
    throw Error(
      'You already participated. ' +
      'Click My decision to see your choice.'
    );
  }
}

client.on('interactionCreate', async i => {
  if (i.guildId !== DISCORD_GUILD_ID) return;

  try {
    if (i.isChatInputCommand()) {
      if (i.commandName !== 'replay') return;

      const sub = i.options.getSubcommand();

      if (sub !== 'leaderboard' && !admin(i)) {
        await i.reply({
          content: 'Staff only.',
          flags: E
        });

        return;
      }

      await i.deferReply({
        flags: sub === 'leaderboard' ? undefined : E
      });

      if (sub === 'leaderboard') {
        await i.editReply({
          embeds: [board()],
          components: [
            row(button('myrank', 'My rank'))
          ],
          allowedMentions: { parse: [] }
        });

        return;
      }

      if (sub === 'import') {
        const attachment =
          i.options.getAttachment('file');

        if (attachment.size > 150000) {
          throw Error('JSON must be under 150 KB.');
        }

        const url = new URL(attachment.url);

        if (![
          'cdn.discordapp.com',
          'media.discordapp.net'
        ].includes(url.hostname)) {
          throw Error('Use a Discord attachment.');
        }

        const response = await fetch(url, {
          signal: AbortSignal.timeout(10000),
          redirect: 'error'
        });

        if (!response.ok) {
          throw Error('Attachment download failed.');
        }

        const raw = await response.text();

        if (Buffer.byteLength(raw) > 150000) {
          throw Error('File too large.');
        }

        const s = validate(JSON.parse(raw));

        if (db.scenarios[s.id]) {
          throw Error(
            'ID already imported. Use a new ID.'
          );
        }

        commit(d => {
          d.scenarios[s.id] = s;
        });

        await i.editReply(
          `Imported: ${s.id} (${s.kind}).`
        );

        return;
      }

      if (sub === 'publish') {
        const scenarioId =
          i.options.getString('scenario');

        const s = db.scenarios[scenarioId];

        if (!s) {
          throw Error('Import this scenario first.');
        }

        if (
          Object.values(db.rounds).some(
            r => r.scenario === scenarioId
          )
        ) {
          throw Error(
            'Already published. ' +
            'Do not reuse a known scenario.'
          );
        }

        const input = i.options.getString('closes');

        if (!/(Z|[+-]\d{2}:\d{2})$/.test(input)) {
          throw Error(
            'Use an ISO date with timezone offset.'
          );
        }

        const close = Date.parse(input);

        if (
          !Number.isFinite(close) ||
          close < Date.now() + 60000
        ) {
          throw Error(
            'Deadline must be at least one minute ahead.'
          );
        }

        const channel =
          i.options.getChannel('channel');

        const id = randomUUID().slice(0, 8);

        const r = {
          id,
          scenario: scenarioId,
          season: db.season,
          guild: i.guildId,
          channel: channel.id,
          close,
          picks: {},
          message: null
        };

        const image = await chart(s);

        if (
          Object.values(db.rounds).some(
            item => item.scenario === scenarioId
          )
        ) {
          throw Error('Already published.');
        }

        if (db.season !== r.season) {
          throw Error('Season changed. Try again.');
        }

        commit(d => {
          d.rounds[id] = r;
        });

        let message;

        try {
          message = await channel.send({
            embeds: [publicEmbed(r)],
            files: [image],
            components: controls(r),
            allowedMentions: { parse: [] }
          });
        } catch (error) {
          commit(d => {
            delete d.rounds[id];
          });

          throw error;
        }

        commit(d => {
          d.rounds[id].message = message.id;
        });

        await i.editReply(
          `Published ${id}: ${message.url}`
        );

        return;
      }

      if (sub === 'list') {
        const scenarios =
          'Scenarios: ' +
          Object.keys(db.scenarios).join(', ');

        const rounds = Object.values(db.rounds)
          .map(r =>
            `${r.id} | ${r.scenario} | ` +
            `season ${r.season} | ` +
            `${Date.now() >= r.close ? 'closed' : 'open'} | ` +
            `${Object.keys(r.picks).length} players`
          )
          .join('\n');

        await i.editReply({
          content: (scenarios + '\n\n' + rounds)
            .slice(0, 1900),
          allowedMentions: { parse: [] }
        });

        return;
      }

      if (sub === 'close') {
        const r = round(i.options.getString('id'));

        check(r, i);

        commit(d => {
          d.rounds[r.id].close =
            Math.min(Date.now(), r.close);
        });

        await i.editReply(
          'Closed. View replay is now available.'
        );

        return;
      }

      if (sub === 'export') {
        const list = leaders();

        const csv = [
          'Rank,Discord ID,Points,Replays,Total R',
          ...list.map(member => {
            const rank =
              list.findIndex(
                item => item.points === member.points
              ) + 1;

            return [
              rank,
              member.id,
              member.points,
              member.played,
              member.r.toFixed(4)
            ].join(',');
          })
        ].join('\r\n');

        await i.editReply({
          files: [
            new AttachmentBuilder(
              Buffer.from('\uFEFF' + csv),
              {
                name:
                  `replay-season-${db.season}.csv`
              }
            )
          ]
        });

        return;
      }

      if (sub === 'backup') {
        await i.editReply({
          files: [
            new AttachmentBuilder(
              Buffer.from(
                JSON.stringify(db, null, 2)
              ),
              { name: 'replay-backup.json' }
            )
          ]
        });

        return;
      }

      if (sub === 'reset') {
        if (
          i.options.getString('confirmation') !==
          'RESET'
        ) {
          throw Error('Type RESET to confirm.');
        }

        const active = Object.values(db.rounds)
          .some(r =>
            r.season === db.season &&
            Date.now() < r.close
          );

        if (active) {
          throw Error('Close active replays first.');
        }

        commit(d => {
          d.season++;
        });

        await i.editReply(
          `Season ${db.season} started. ` +
          'Previous data is archived.'
        );

        return;
      }
    }

    if (i.isButton()) {
      const [action, id, side] =
        i.customId.split(':');

      if (action === 'rank') {
        await i.deferReply({ flags: E });

        await i.editReply({
          embeds: [board()],
          components: [
            row(button('myrank', 'My rank'))
          ],
          allowedMentions: { parse: [] }
        });

        return;
      }

      if (action === 'myrank') {
        const list = leaders();
        const member =
          list.find(item => item.id === i.user.id);

        const rank = member
          ? list.findIndex(
              item => item.points === member.points
            ) + 1
          : null;

        await i.reply({
          content: member
            ? `Your rank: #${rank} · ` +
              `${member.points} pts · ` +
              `${member.played} replays.`
            : 'No settled participation yet.',
          flags: E
        });

        return;
      }

      const r = round(id);

      check(r, i);

      if (action === 'pick') {
        open(r, i);

        if (![
          'long',
          'short',
          'skip'
        ].includes(side)) {
          throw Error('Invalid side.');
        }

        if (side === 'skip') {
          await i.reply({
            content:
              '**No trade.** Confirm to lock your ' +
              'decision. You cannot change it afterwards.',
            components: [
              row(
                button(
                  `confirm:${id}:skip`,
                  'Confirm no trade',
                  ButtonStyle.Primary
                )
              )
            ],
            flags: E
          });

          return;
        }

        const modal = new ModalBuilder()
          .setCustomId(`plan:${id}:${side}`)
          .setTitle(
            `${side === 'long' ? 'Buy' : 'Sell'} · Risk plan`
          );

        const inputs = [
          [
            'stop',
            'Stop distance (%) · 0.1 to 5',
            'Example: 1'
          ],
          [
            'target',
            'Target distance (%) · 0.1 to 15',
            'Example: 2'
          ]
        ];

        for (const [key, label, placeholder] of inputs) {
          modal.addComponents(
            row(
              new TextInputBuilder()
                .setCustomId(key)
                .setLabel(label)
                .setStyle(TextInputStyle.Short)
                .setPlaceholder(placeholder)
                .setMaxLength(8)
                .setRequired(true)
            )
          );
        }

        await i.showModal(modal);

        return;
      }

      if (action === 'confirm') {
        open(r, i);

        const draft = side === 'skip'
          ? { side: 'skip' }
          : r.drafts?.[i.user.id];

        if (!draft || draft.side !== side) {
          throw Error('Open a new decision preview.');
        }

        commit(d => {
          d.rounds[id].picks[i.user.id] = {
            ...draft,
            at: Date.now()
          };

          if (d.rounds[id].drafts) {
            delete d.rounds[id].drafts[i.user.id];
          }
        });

        await i.update({
          content:
            '✅ **Your decision is locked.** ' +
            'Come back after the deadline to view the replay. ' +
            'Use My decision to review your choice.',
          embeds: [],
          components: []
        });

        return;
      }

      if (action === 'mine') {
        const pick = r.picks[i.user.id];

        if (!pick) {
          throw Error('No confirmed decision yet.');
        }

        const plan = pick.side === 'skip'
          ? ''
          : ` · Stop ${pick.stop}% · Target ${pick.target}%`;

        await i.reply({
          content:
            `**${pick.side.toUpperCase()}**${plan}\n` +
            (
              Date.now() < r.close
                ? 'Locked. Results unlock after the deadline.'
                : 'Use View replay for your result.'
            ),
          flags: E
        });

        return;
      }

      if (action === 'reveal') {
        if (Date.now() < r.close) {
          throw Error(
            'The future stays hidden until the deadline.'
          );
        }

        await i.deferReply({ flags: E });

        const s = scenario(r);
        const pick = r.picks[i.user.id];
        const value = pick ? result(s, pick) : null;

        const personal = value
          ? `**${pick.side.toUpperCase()} · ` +
            `${value.points} points**\n` +
            `${value.reason} · ${value.r.toFixed(2)}R` +
            (
              value.exit === null
                ? ''
                : ` · Exit ${value.exit.toPrecision(6)}`
            ) +
            '\n\n'
          : '';

        const model =
          'Model: entry at the last visible close. ' +
          'Stop and target are checked on subsequent candles. ' +
          'If both touch within one candle, stop comes first. ' +
          'No fees or slippage; opening gaps at stop use ' +
          'the opening price. Points: 100 + 50 × R, ' +
          'capped from 50 to 250. No trade: 100.';

        await i.editReply({
          embeds: [
            emb(
              'Replay revealed',
              personal +
              s.explanation +
              '\n\n**Source:** ' +
              s.source +
              '\n\n' +
              model
            ).setImage('attachment://chart.png')
          ],
          files: [
            await chart(s, true, pick)
          ]
        });

        return;
      }
    }

    if (
      i.isModalSubmit() &&
      i.customId.startsWith('plan:')
    ) {
      const [, id, side] = i.customId.split(':');
      const r = round(id);

      open(r, i);

      if (!['long', 'short'].includes(side)) {
        throw Error('Invalid side.');
      }

      const stop = Number(
        i.fields.getTextInputValue('stop')
          .replace(',', '.')
      );

      const target = Number(
        i.fields.getTextInputValue('target')
          .replace(',', '.')
      );

      if (
        !Number.isFinite(stop) ||
        !Number.isFinite(target) ||
        stop < 0.1 ||
        stop > 5 ||
        target < 0.1 ||
        target > 15 ||
        target / stop > 3
      ) {
        throw Error(
          'Stop: 0.1-5%. Target: 0.1-15%. ' +
          'Maximum reward/risk: 3R.'
        );
      }

      commit(d => {
        d.rounds[id].drafts ??= {};

        d.rounds[id].drafts[i.user.id] = {
          side,
          stop,
          target
        };
      });

      await i.reply({
        embeds: [
          emb(
            'Confirm your plan',
            `**${side.toUpperCase()}**

Stop: **${stop}%**
Target: **${target}%**
Reward/risk: **${(target / stop).toFixed(2)}R**

Once confirmed, your decision is final.
No result is shown before the deadline.`
          )
        ],
        components: [
          row(
            button(
              `confirm:${id}:${side}`,
              'Confirm decision',
              ButtonStyle.Primary
            )
          )
        ],
        flags: E
      });
    }
  } catch (error) {
    console.error(error);

    const message = {
      content: String(
        error.message || 'Unexpected error.'
      ).slice(0, 1500),
      allowedMentions: { parse: [] }
    };

    try {
      if (i.deferred) {
        await i.editReply(message);
      } else if (i.replied) {
        await i.followUp({
          ...message,
          flags: E
        });
      } else {
        await i.reply({
          ...message,
          flags: E
        });
      }
    } catch (responseError) {
      console.error(
        'Response failed',
        responseError.message
      );
    }
  }
});

client.once('clientReady', () => {
  console.log(
    `Trade Replay ready: ${client.user.tag}`
  );
});

async function start() {
  await new REST({ version: '10' })
    .setToken(DISCORD_TOKEN)
    .put(
      Routes.applicationGuildCommands(
        DISCORD_CLIENT_ID,
        DISCORD_GUILD_ID
      ),
      { body: [cmd.toJSON()] }
    );

  await client.login(DISCORD_TOKEN);
}

start().catch(error => {
  console.error('Startup:', error);
  process.exit(1);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    client.destroy();
    process.exit(0);
  });
}
