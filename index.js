require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

console.log("Bot berjalan...");

// =======================
// ERROR HANDLER
// =======================
bot.on("polling_error", console.error);
process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);

// =======================
// CONFIG
// =======================
let ANTI_LINK = true;
let ANTI_SPAM = true;
let ANTI_FORWARD = true;

let DEFAULT_MUTE_DURATION = 60;

const SPAM_LIMIT = 5;
const TIME_WINDOW = 5000;
const MIN_MUTE_DURATION = 30;

const PROMO_CHANNEL = "https://t.me/seducteasech";

// Blacklist kata bawaan (berlaku di semua grup) — admin & owner tetap bisa
const DEFAULT_BLACKLIST_WORDS = ["vcs", "vc", "colmek", "omek", "bokep", "bkp", "okep", "sange", "ange", "vgk"];

// Blacklist tambahan dari command .blacklist — per grup
// customBlacklist[chatId] = Set(["kata1", "kata2"])
const customBlacklist = {};

const userMessages = {};

// Simpan ID pesan welcome & peringatan terakhir per grup
let lastWelcomeMessage = {};
const lastWarningMessage = {};

// Mutex agar welcome tidak dikirim bersamaan
let welcomeLock = {};

// Simpan jumlah warn per user per grup
const warnCount = {};

// =======================
// DATABASE (OPSIONAL)
// Kalau DATABASE_URL ada, kata blacklist disimpan di Postgres
// supaya tidak hilang saat bot restart / redeploy.
// Kalau tidak ada, blacklist hanya tersimpan di memori.
// =======================
let pool = null;

if (process.env.DATABASE_URL) {
  const { Pool } = require("pg");
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
}

(async () => {

  if (!pool) {
    console.log("⚠️ DATABASE_URL tidak ditemukan — blacklist custom hanya tersimpan di memori.");
    return;
  }

  try {

    await pool.query(`
      CREATE TABLE IF NOT EXISTS blacklist_words (
        chat_id BIGINT NOT NULL,
        word TEXT NOT NULL,
        PRIMARY KEY (chat_id, word)
      );
    `);

    const res = await pool.query("SELECT chat_id, word FROM blacklist_words");

    res.rows.forEach(r => {
      const key = String(r.chat_id);
      if (!customBlacklist[key]) customBlacklist[key] = new Set();
      customBlacklist[key].add(r.word);
    });

    console.log(`✅ Blacklist dimuat dari database (${res.rows.length} kata)`);

  } catch (err) {
    console.error("DB blacklist error:", err.message);
  }

})();

// =======================
// ESCAPE MARKDOWN
// =======================
function escapeMarkdown(text) {
  if (!text) return "";
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

// =======================
// FORMAT WAKTU WIB
// =======================
function formatDateTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

// =======================
// HAPUS PESAN SISTEM OTOMATIS
// =======================
bot.on("message", async (msg) => {

  if (msg.chat.type === "private") return;

  const chatId = msg.chat.id;

  if (
    msg.new_chat_members ||
    msg.left_chat_member ||
    msg.new_chat_title ||
    msg.new_chat_photo ||
    msg.delete_chat_photo ||
    msg.pinned_message ||
    msg.group_chat_created ||
    msg.supergroup_chat_created ||
    msg.channel_chat_created
  ) {
    try {
      await bot.deleteMessage(chatId, msg.message_id);
    } catch {}
  }

});

// =======================
// WELCOME MESSAGE
// =======================
bot.on("message", async (msg) => {

  if (!msg.new_chat_members) return;

  const chatId = msg.chat.id;

  while (welcomeLock[chatId]) {
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  welcomeLock[chatId] = true;

  try {

    const groupName = escapeMarkdown(msg.chat.title);

    for (const member of msg.new_chat_members) {

      const name = escapeMarkdown(member.first_name);

      const mentionUser = member.username
        ? `@${escapeMarkdown(member.username)}`
        : `[${name}](tg://user?id=${member.id})`;

      try {
        if (lastWelcomeMessage[chatId]) {
          await bot.deleteMessage(chatId, lastWelcomeMessage[chatId]);
          lastWelcomeMessage[chatId] = null;
        }
      } catch {}

      const sent = await bot.sendMessage(
        chatId,
`𝐖𝐞𝐥𝐜𝐨𝐦𝐞 ${name} 𝐓𝐨 ${groupName}
User: ${mentionUser}
ID: ${member.id}
JANGAN SPAM & KIRIM LINK SEMBARANGAN`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "ASUPAN FREE",
                  url: PROMO_CHANNEL
                }
              ]
            ]
          }
        }
      );

      lastWelcomeMessage[chatId] = sent.message_id;

    }

  } finally {
    welcomeLock[chatId] = false;
  }

});

// =======================
// MAIN MODERATION
// =======================
bot.on("message", async (msg) => {

  if (msg.chat.type === "private") return;
  if (!msg.from) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const now = Date.now();

  try {

    const member = await bot.getChatMember(chatId, userId);
    const isAdminOrOwner = ["administrator", "creator"].includes(member.status);

    // ===================
    // ANTI FORWARD
    // ===================
    if (!isAdminOrOwner && ANTI_FORWARD && (msg.forward_from || msg.forward_from_chat)) {

      await bot.deleteMessage(chatId, msg.message_id);

      await muteUser(
        chatId,
        userId,
        msg,
        "Meneruskan pesan tidak diperbolehkan."
      );

      return;
    }

    if (!isAdminOrOwner && msg.text) {

      // ===================
      // ANTI LINK
      // ===================
      if (ANTI_LINK) {

        const linkRegex = /(https?:\/\/|t\.me|www\.)/i;

        if (linkRegex.test(msg.text)) {

          await bot.deleteMessage(chatId, msg.message_id);

          await muteUser(
            chatId,
            userId,
            msg,
            "Mengirim link tidak diperbolehkan."
          );

          return;
        }
      }

      // ===================
      // BLACKLIST KATA (bawaan + custom per grup)
      // ===================
      const textLower = msg.text.toLowerCase();
      const chatWords = customBlacklist[chatId] ? [...customBlacklist[chatId]] : [];
      const allWords = [...DEFAULT_BLACKLIST_WORDS, ...chatWords];
      const foundWord = allWords.find(word => textLower.includes(word));

      if (foundWord) {

        try {
          await bot.deleteMessage(chatId, msg.message_id);
        } catch {}

        return;
      }

      // ===================
      // ANTI SPAM
      // ===================
      if (ANTI_SPAM) {

        if (!userMessages[userId]) {
          userMessages[userId] = [];
        }

        userMessages[userId].push(now);

        userMessages[userId] = userMessages[userId].filter(
          (time) => now - time < TIME_WINDOW
        );

        if (userMessages[userId].length > SPAM_LIMIT) {

          await muteUser(
            chatId,
            userId,
            msg,
            "Terlalu banyak pesan (spam)."
          );
        }
      }
    }

  } catch (err) {

    console.log("ERROR:", err.response?.body || err.message);

  }

});

// =======================
// MUTE FUNCTION
// =======================
async function muteUser(chatId, userId, msg, reason, customDuration, permanent = false) {

  const duration = customDuration || DEFAULT_MUTE_DURATION;

  if (permanent) {

    await bot.restrictChatMember(chatId, userId, {
      permissions: {
        can_send_messages: false,
        can_send_audios: false,
        can_send_documents: false,
        can_send_photos: false,
        can_send_videos: false,
        can_send_video_notes: false,
        can_send_voice_notes: false,
        can_send_polls: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false,
      }
    });

    const name = escapeMarkdown(msg.from.first_name);

    try {
      if (lastWarningMessage[chatId]) {
        await bot.deleteMessage(chatId, lastWarningMessage[chatId]);
        lastWarningMessage[chatId] = null;
      }
    } catch {}

    const sent = await bot.sendMessage(
      chatId,
`🚫 *PERINGATAN MODERASI*
\`\`\`
User  : ${name}
Muted : PERMANEN
Alasan: ${reason}
\`\`\``,
      { parse_mode: "Markdown" }
    );

    lastWarningMessage[chatId] = sent.message_id;
    return;
  }

  const until = Math.floor(Date.now() / 1000) + duration;

  await bot.restrictChatMember(chatId, userId, {
    permissions: {
      can_send_messages: false,
      can_send_audios: false,
      can_send_documents: false,
      can_send_photos: false,
      can_send_videos: false,
      can_send_video_notes: false,
      can_send_voice_notes: false,
      can_send_polls: false,
      can_send_other_messages: false,
      can_add_web_page_previews: false,
    },
    until_date: until
  });

  const name = escapeMarkdown(msg.from.first_name);
  const untilFormatted = formatDateTime(until * 1000);

  try {
    if (lastWarningMessage[chatId]) {
      await bot.deleteMessage(chatId, lastWarningMessage[chatId]);
      lastWarningMessage[chatId] = null;
    }
  } catch {}

  const sent = await bot.sendMessage(
    chatId,
`🚫 *PERINGATAN MODERASI*
\`\`\`
User  : ${name}
Muted : ${duration} detik
Sampai: ${untilFormatted}
Alasan: ${reason}
\`\`\``,
    { parse_mode: "Markdown" }
  );

  lastWarningMessage[chatId] = sent.message_id;

}

// =======================
// COMMAND .vip
// =======================
bot.onText(/^\.vip$/, async (msg) => {

  const chatId = msg.chat.id;
  const callerId = msg.from.id;

  const callerMember = await bot.getChatMember(chatId, callerId);

  if (!["administrator", "creator"].includes(callerMember.status)) {
    return bot.sendMessage(chatId, "❌ Hanya admin.");
  }

  // Hapus pesan .vip
  try { await bot.deleteMessage(chatId, msg.message_id); } catch {}

  bot.sendMessage(chatId,
`𝙑𝙡𝙋 𝙂𝙍𝙐𝙋 𝙎𝙀𝘿𝙐𝘾𝙏𝙀𝘼𝙎𝙀

𝟷𝟶.𝟶𝟶𝟶+ ᴋᴏɴᴛᴇɴ
ɪɴᴄʟᴜᴅᴇ ᴘʀᴇᴍɪᴜᴍ ᴠɪᴅᴇᴏ
- ᴏᴍᴇᴛᴠ
- ʙᴏᴡᴄɪʟ
- ᴀʟʟ ᴛᴀʟᴇɴᴛ/ᴛɪᴋᴛᴏᴋᴇʀ/sᴇʟᴇʙɢʀ ғᴜʟʟᴘᴀᴄᴋ
- ᴊᴇᴘᴀɴɢ
- ʙᴀʀᴀᴛ
- ᴋᴏʟᴇᴋsɪ ᴊɪʟʙᴀʙ
- ᴅʟʟ.

ᴜᴘᴅᴀᴛᴇ 𝟸𝟺/𝟽 ᴘʟᴀʏ ᴠɪᴅᴇᴏ ᴛᴀɴᴘᴀ ʟɪɴᴋ

ONLY 50K

ᴍɪɴᴀᴛ ᴄʜᴀᴛ ᴀᴅᴍɪɴ @mieayampangsit18

testi @testivipseductease`
  );

});

// =======================
// COMMAND .warn
// =======================
bot.onText(/^\.warn$/, async (msg) => {

  const chatId = msg.chat.id;
  const callerId = msg.from.id;

  const callerMember = await bot.getChatMember(chatId, callerId);
  const callerStatus = callerMember.status;

  if (!["administrator", "creator"].includes(callerStatus)) {
    return bot.sendMessage(chatId, "❌ Hanya admin.");
  }

  if (!msg.reply_to_message) {
    return bot.sendMessage(chatId, "⚠️ Reply pesan user yang ingin diberi warn.");
  }

  const targetId = msg.reply_to_message.from.id;
  const targetMember = await bot.getChatMember(chatId, targetId);
  const targetStatus = targetMember.status;

  if (targetStatus === "creator") {
    return bot.sendMessage(chatId, "❌ Tidak bisa warn owner.");
  }

  if (targetStatus === "administrator" && callerStatus === "creator") {
    return bot.sendMessage(chatId, "Jangan jahat bang 😭🙏");
  }

  if (targetStatus === "administrator" && callerStatus === "administrator") {
    return bot.sendMessage(chatId, "❌ Tidak bisa warn sesama admin.");
  }

  // Hapus pesan .warn dan pesan yang di-reply
  try { await bot.deleteMessage(chatId, msg.message_id); } catch {}
  try { await bot.deleteMessage(chatId, msg.reply_to_message.message_id); } catch {}

  // Tambah warn counter
  if (!warnCount[chatId]) warnCount[chatId] = {};
  if (!warnCount[chatId][targetId]) warnCount[chatId][targetId] = 0;

  warnCount[chatId][targetId]++;
  const warn = warnCount[chatId][targetId];

  if (warn === 1) {

    await muteUser(
      chatId,
      targetId,
      msg.reply_to_message,
      "Warn 1 — hati-hati!",
      30
    );

  } else if (warn === 2) {

    await muteUser(
      chatId,
      targetId,
      msg.reply_to_message,
      "Warn 2 — sekali lagi akan mute permanen!",
      DEFAULT_MUTE_DURATION
    );

  } else if (warn >= 3) {

    warnCount[chatId][targetId] = 0;

    await muteUser(
      chatId,
      targetId,
      msg.reply_to_message,
      "Warn 3 — telah melanggar rules, di-mute permanen.",
      null,
      true
    );

  }

});

// =======================
// COMMAND .setmute
// =======================
bot.onText(/^\.setmute (\d+)$/, async (msg, match) => {

  const chatId = msg.chat.id;
  const callerId = msg.from.id;

  const callerMember = await bot.getChatMember(chatId, callerId);

  if (!["administrator", "creator"].includes(callerMember.status)) {
    return bot.sendMessage(chatId, "❌ Hanya admin.");
  }

  let duration = parseInt(match[1]);

  if (duration < MIN_MUTE_DURATION) {
    return bot.sendMessage(chatId, `❌ Durasi minimum ${MIN_MUTE_DURATION} detik.`);
  }

  DEFAULT_MUTE_DURATION = duration;

  bot.sendMessage(chatId, `✅ Durasi mute default diubah menjadi *${DEFAULT_MUTE_DURATION} detik*`, {
    parse_mode: "Markdown"
  });

});

// =======================
// COMMAND .mute (dengan alasan custom)
// Format: .mute <detik> <alasan>
// =======================
bot.onText(/^\.mute (\d+)(?:\s+(.+))?$/, async (msg, match) => {

  const chatId = msg.chat.id;
  const callerId = msg.from.id;

  const callerMember = await bot.getChatMember(chatId, callerId);
  const callerStatus = callerMember.status;

  if (!["administrator", "creator"].includes(callerStatus)) {
    return bot.sendMessage(chatId, "❌ Hanya admin.");
  }

  if (!msg.reply_to_message) {
    return bot.sendMessage(chatId, "⚠️ Reply pesan user yang ingin dimute.");
  }

  const targetId = msg.reply_to_message.from.id;
  const targetMember = await bot.getChatMember(chatId, targetId);
  const targetStatus = targetMember.status;

  if (targetStatus === "creator") {
    return bot.sendMessage(chatId, "❌ Tidak bisa mute owner.");
  }

  if (targetStatus === "administrator" && callerStatus === "creator") {
    return bot.sendMessage(chatId, "Jangan jahat bang 😭🙏");
  }

  if (targetStatus === "administrator" && callerStatus === "administrator") {
    return bot.sendMessage(chatId, "❌ Tidak bisa mute sesama admin.");
  }

  let duration = parseInt(match[1]);
  const alasan = match[2] ? match[2].trim() : "Mute manual oleh admin.";

  if (duration < MIN_MUTE_DURATION) {
    await bot.sendMessage(chatId, `⚠️ Durasi minimum ${MIN_MUTE_DURATION} detik, otomatis diset ${MIN_MUTE_DURATION} detik.`);
    duration = MIN_MUTE_DURATION;
  }

  // Hapus pesan .mute dan pesan yang di-reply
  try { await bot.deleteMessage(chatId, msg.message_id); } catch {}
  try { await bot.deleteMessage(chatId, msg.reply_to_message.message_id); } catch {}

  await muteUser(
    chatId,
    targetId,
    msg.reply_to_message,
    alasan,
    duration
  );

});

// =======================
// COMMAND .kick
// =======================
bot.onText(/^\.kick$/, async (msg) => {

  const chatId = msg.chat.id;
  const callerId = msg.from.id;

  const callerMember = await bot.getChatMember(chatId, callerId);
  const callerStatus = callerMember.status;

  if (!["administrator", "creator"].includes(callerStatus)) {
    return bot.sendMessage(chatId, "❌ Hanya admin.");
  }

  if (!msg.reply_to_message) {
    return bot.sendMessage(chatId, "⚠️ Reply pesan user yang ingin di-kick.");
  }

  const targetId = msg.reply_to_message.from.id;
  const targetMember = await bot.getChatMember(chatId, targetId);
  const targetStatus = targetMember.status;

  if (targetStatus === "creator") {
    return bot.sendMessage(chatId, "❌ Tidak bisa kick owner.");
  }

  if (targetStatus === "administrator" && callerStatus === "creator") {
    return bot.sendMessage(chatId, "Jangan jahat bang 😭🙏");
  }

  if (targetStatus === "administrator" && callerStatus === "administrator") {
    return bot.sendMessage(chatId, "❌ Tidak bisa kick sesama admin.");
  }

  const name = escapeMarkdown(msg.reply_to_message.from.first_name);

  await bot.banChatMember(chatId, targetId);
  await bot.unbanChatMember(chatId, targetId);

  bot.sendMessage(
    chatId,
`✅ *KICK BERHASIL*
\`\`\`
User  : ${name}
Status: Telah dikeluarkan dari grup
\`\`\``,
    { parse_mode: "Markdown" }
  );

});

// =======================
// HELPER: CEK ADMIN UNTUK COMMAND BLACKLIST
// =======================
async function isGroupAdmin(msg) {

  if (msg.chat.type === "private") return false;
  if (!msg.from) return false;

  try {
    const member = await bot.getChatMember(msg.chat.id, msg.from.id);
    return ["administrator", "creator"].includes(member.status);
  } catch {
    return false;
  }

}

// Pecah input jadi daftar kata (pisahkan dengan koma), huruf kecil, tanpa duplikat
function parseWords(input) {
  return [...new Set(
    input
      .split(",")
      .map(w => w.trim().toLowerCase())
      .filter(w => w.length > 0)
  )];
}

// =======================
// COMMAND .blacklist
// Format: .blacklist <kata>
// Contoh: .blacklist babi
//         .blacklist babi, anjing, kontol   (banyak kata, pisah koma)
// =======================
bot.onText(/^\.blacklist\s+(.+)$/i, async (msg, match) => {

  const chatId = msg.chat.id;

  if (msg.chat.type === "private") return;

  if (!(await isGroupAdmin(msg))) {
    return bot.sendMessage(chatId, "❌ Hanya admin.");
  }

  const words = parseWords(match[1]);

  if (words.length === 0) {
    return bot.sendMessage(chatId, "⚠️ Format: .blacklist <kata>\nContoh: .blacklist babi");
  }

  // Hapus pesan command supaya kata tidak terlihat di grup
  try { await bot.deleteMessage(chatId, msg.message_id); } catch {}

  if (!customBlacklist[chatId]) customBlacklist[chatId] = new Set();

  const added = [];
  const skipped = [];

  for (const word of words) {

    if (DEFAULT_BLACKLIST_WORDS.includes(word) || customBlacklist[chatId].has(word)) {
      skipped.push(word);
      continue;
    }

    customBlacklist[chatId].add(word);
    added.push(word);

    if (pool) {
      try {
        await pool.query(
          "INSERT INTO blacklist_words (chat_id, word) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [chatId, word]
        );
      } catch (err) {
        console.error("DB insert blacklist error:", err.message);
      }
    }

  }

  let text = "";
  if (added.length > 0) text += `✅ Ditambahkan ke blacklist: ${added.join(", ")}\n`;
  if (skipped.length > 0) text += `ℹ️ Sudah ada di blacklist: ${skipped.join(", ")}`;

  bot.sendMessage(chatId, text.trim());

});

// =======================
// COMMAND .unblacklist
// Format: .unblacklist <kata>
// (hanya untuk kata yang ditambah lewat .blacklist, bukan kata bawaan)
// =======================
bot.onText(/^\.unblacklist\s+(.+)$/i, async (msg, match) => {

  const chatId = msg.chat.id;

  if (msg.chat.type === "private") return;

  if (!(await isGroupAdmin(msg))) {
    return bot.sendMessage(chatId, "❌ Hanya admin.");
  }

  const words = parseWords(match[1]);

  try { await bot.deleteMessage(chatId, msg.message_id); } catch {}

  const removed = [];
  const notFound = [];

  for (const word of words) {

    if (DEFAULT_BLACKLIST_WORDS.includes(word)) {
      notFound.push(`${word} (kata bawaan, tidak bisa dihapus lewat command)`);
      continue;
    }

    if (customBlacklist[chatId] && customBlacklist[chatId].delete(word)) {

      removed.push(word);

      if (pool) {
        try {
          await pool.query(
            "DELETE FROM blacklist_words WHERE chat_id=$1 AND word=$2",
            [chatId, word]
          );
        } catch (err) {
          console.error("DB delete blacklist error:", err.message);
        }
      }

    } else {
      notFound.push(word);
    }

  }

  let text = "";
  if (removed.length > 0) text += `✅ Dihapus dari blacklist: ${removed.join(", ")}\n`;
  if (notFound.length > 0) text += `❌ Tidak ditemukan: ${notFound.join(", ")}`;

  bot.sendMessage(chatId, text.trim());

});

// =======================
// COMMAND .listblacklist
// =======================
bot.onText(/^\.listblacklist$/i, async (msg) => {

  const chatId = msg.chat.id;

  if (msg.chat.type === "private") return;

  if (!(await isGroupAdmin(msg))) {
    return bot.sendMessage(chatId, "❌ Hanya admin.");
  }

  try { await bot.deleteMessage(chatId, msg.message_id); } catch {}

  const custom = customBlacklist[chatId] ? [...customBlacklist[chatId]] : [];

  const text =
`📋 Daftar Blacklist

Bawaan (${DEFAULT_BLACKLIST_WORDS.length}):
${DEFAULT_BLACKLIST_WORDS.join(", ")}

Tambahan grup ini (${custom.length}):
${custom.length > 0 ? custom.join(", ") : "-"}`;

  bot.sendMessage(chatId, text);

});
