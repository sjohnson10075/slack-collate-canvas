import express from "express";
import crypto from "crypto";
import { App, ExpressReceiver } from "@slack/bolt";
import fetch from "node-fetch";
import sharp from "sharp";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

/**
 * ENV REQUIRED (Render):
 * - SLACK_BOT_TOKEN=xoxb-...
 * - SLACK_SIGNING_SECRET=...
 *
 * Optional (safe):
 * - ADD_SPANISH=1              -> turn on Spanish translation
 * - DEEPL_API_KEY=...          -> DeepL API key (Free or Pro)
 *
 * Scopes used:
 * chat:write, commands, files:read, files:write, channels:history, groups:history, canvases:write, canvases:read
 */

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET as string,
  endpoints: "/slack/events"
});
const bolt = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  receiver
});

function verifySlackSig(req: express.Request): boolean {
  const ts = req.headers["x-slack-request-timestamp"] as string;
  const sig = req.headers["x-slack-signature"] as string;
  if (!ts || !sig) return false;
  const fiveMinutes = 60 * 5;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(ts)) > fiveMinutes) return false;
  const body = (req as any).rawBody;
  const base = `v0:${ts}:${body}`;
  const hmac = crypto.createHmac("sha256", process.env.SLACK_SIGNING_SECRET as string).update(base).digest("hex");
  const expected = `v0=${hmac}`;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

// capture raw body for signature verification
const app = receiver.app as unknown as express.Express;
app.use("/slack", express.raw({ type: "*/*" }), (req, _res, next) => {
  (req as any).rawBody =
    (req as any).rawBody || (req as any).body?.toString?.() || req.body;
  next();
});

// ---------- Slash command (informational only) ----------
app.post("/slack/commands", async (req, res) => {
  if (!verifySlackSig(req)) return res.status(401).send("bad sig");
  const payload = new URLSearchParams((req as any).rawBody);
  const command = payload.get("command");
  if (command !== "/collate") return res.send("");
  return res.json({
    response_type: "ephemeral",
    text:
      "Use the message shortcut *Collate thread to Canvas* on any message inside the thread that contains your images. (Slash commands don’t carry thread context.)"
  });
});

// ---------- Helpers ----------
async function fetchFilePermalink(client: any, fileId: string): Promise<string | null> {
  try {
    const info = (await client.apiCall("files.info", { file: fileId })) as any;
    return (info?.file?.permalink as string) || null;
  } catch {
    return null;
  }
}

async function downloadOriginal(client: any, botToken: string, fileId: string): Promise<Buffer | null> {
  try {
    const info = (await client.apiCall("files.info", { file: fileId })) as any;
    const url = info.file?.url_private_download || info.file?.url_private;
    if (!url) return null;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${botToken}` } } as any);
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch {
    return null;
  }
}

async function compressToJpeg(buf: Buffer, max: number): Promise<Buffer> {
  return await sharp(buf)
    .rotate()
    .resize({ width: max, height: max, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 72, chromaSubsampling: "4:2:0", mozjpeg: true })
    .toBuffer();
}

// --- Optional Spanish translation (DeepL) ---
const ADD_SPANISH = (process.env.ADD_SPANISH || "") === "1";
const DEEPL_API_KEY = process.env.DEEPL_API_KEY || "";
function deeplEndpointFromKey(k: string) {
  return k && k.includes(":fx")
    ? "https://api-free.deepl.com/v2/translate"
    : "https://api.deepl.com/v2/translate";
}
async function translateEs(text: string): Promise<{ ok: boolean; es: string }> {
  if (!ADD_SPANISH) return { ok: false, es: "" };
  if (!DEEPL_API_KEY) return { ok: false, es: "" };
  const t = (text || "").trim();
  if (!t) return { ok: true, es: "" };
  try {
    const body = new URLSearchParams({
      auth_key: DEEPL_API_KEY,
      text: t,
      target_lang: "ES",
      preserve_formatting: "1"
    });
    const res = await fetch(deeplEndpointFromKey(DEEPL_API_KEY), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body as any
    } as any);
    if (!res.ok) {
      console.log("[deepl] HTTP", res.status, res.statusText);
      return { ok: false, es: "" };
    }
    const data = await res.json();
    const translated = data?.translations?.[0]?.text;
    if (typeof translated === "string") return { ok: true, es: translated };
    console.log("[deepl] unexpected payload", data);
    return { ok: false, es: "" };
  } catch (e: any) {
    console.log("[deepl] error", e?.message || e);
    return { ok: false, es: "" };
  }
}

// Root title helpers
function sanitizeForFilename(s: string, max = 80): string {
  const cleaned = (s || "Export")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || "Export").slice(0, max);
}
function shortTitle(s: string, max = 120): string {
  const t = (s || "Export").replace(/\s+/g, " ").trim();
  return (t || "Export").slice(0, max);
}
function findRootText(messages: any[], root_ts: string): string {
  const root = messages.find((m: any) => m.ts === root_ts) || messages[0];
  const t = (root?.text || "").toString();
  return t.trim();
}

// =======================================================
// SHORTCUT A: Collate thread to Canvas (GROUP BY MESSAGE) + Spanish line BELOW English + NUMBERING
// =======================================================
bolt.shortcut("collate_thread", async ({ ack, shortcut, client, logger }) => {
  await ack();
  try {
    const { channel, message_ts, thread_ts, trigger_id } = shortcut as any;
    const root_ts = thread_ts || message_ts;
    const channel_id = channel.id as string;

    await client.views.open({
      trigger_id,
      view: {
        type: "modal",
        callback_id: "collate_modal",
        private_metadata: JSON.stringify({ channel_id, thread_ts: root_ts }),
        title: { type: "plain_text", text: "Collate to Canvas" },
        submit: { type: "plain_text", text: "Create Canvas" },
        close: { type: "plain_text", text: "Cancel" },
        blocks: [
          {
            type: "input",
            block_id: "category_block",
            label: { type: "plain_text", text: "Category" },
            element: {
              type: "static_select",
              action_id: "category_action",
              placeholder: { type: "plain_text", text: "Choose a category" },
              options: [
                { text: { type: "plain_text", text: "Maintenance" }, value: "maintenance" },
                { text: { type: "plain_text", text: "Construction" }, value: "construction" },
                { text: { type: "plain_text", text: "Irrigation" }, value: "irrigation" },
                { text: { type: "plain_text", text: "Bidding" }, value: "bidding" },
                { text: { type: "plain_text", text: "Other" }, value: "other" }
              ]
            }
          }
        ]
      }
    });
  } catch (e: any) {
    (logger || console).error("shortcut error:", e?.data || e?.message || e);
  }
});

bolt.view("collate_modal", async ({ ack, view, client, logger }) => {
  await ack();
  try {
    const meta = JSON.parse(view.private_metadata || "{}");
    const channel_id = meta.channel_id as string;
    const thread_ts = meta.thread_ts as string;
    const category = (view.state.values.category_block.category_action.selected_option?.value || "other") as string;

    const replies = await client.conversations.replies({ channel: channel_id, ts: thread_ts, limit: 200 });
    const messages = replies.messages || [];

    const rootText = findRootText(messages, thread_ts);
    const canvasTitle = shortTitle(rootText || `Collated — ${category}`);

    type Group = { caption: string; captionEs?: string; filePermalinks: string[] };
    const groups: Group[] = [];

    for (const m of messages) {
      const files = (m as any).files as Array<any> | undefined;
      if (!files || !files.length) continue;

      const caption =
        (m as any).text?.trim() ||
        (files[0]?.initial_comment?.comment?.trim?.() ?? "") ||
        (files[0]?.title?.trim?.() ?? "");

      const permaList: string[] = [];
      for (const f of files) {
        if (!/^image\//.test(f.mimetype || "")) continue;
        const perma = await fetchFilePermalink(client, f.id);
        if (perma) permaList.push(perma);
      }
      if (permaList.length) {
        let captionEs: string | undefined = undefined;
        if (ADD_SPANISH) {
          const res = await translateEs(caption);
          if (res.ok && res.es) captionEs = res.es;
        }
        groups.push({ caption, captionEs, filePermalinks: permaList });
      }
    }

    if (!groups.length) {
      await client.chat.postMessage({ channel: channel_id, thread_ts, text: "I didn’t find any images in this thread." });
      return;
    }

    // Canvas content — NUMBERED, Spanish on new line with blank spacer
    const lines: string[] = [];
    lines.push(`# ${canvasTitle}`, "");
    groups.forEach((g, idx) => {
      const num = idx + 1;
      // Bold number + caption
      lines.push(`**${num}.** ${g.caption}`, "");
      if (ADD_SPANISH && g.captionEs) {
        lines.push(`*ES:* ${g.captionEs}`, ""); // Spanish line then blank line
      }
      for (const link of g.filePermalinks) {
        lines.push(`![](${link})`, "");
      }
      lines.push("---", "");
    });
    const markdown = lines.join("\n");

    const created = (await client.apiCall("canvases.create", {
      title: canvasTitle,
      channel_id: channel_id,
      document_content: { type: "markdown", markdown }
    })) as any;

    if (!created?.ok) {
      (logger || console).error("canvases.create failed:", created);
      await client.chat.postMessage({ channel: channel_id, thread_ts, text: `⚠️ Canvas create failed.` });
      return;
    }

    await client.chat.postMessage({
      channel: channel_id,
      thread_ts,
      text: `✅ Created a Canvas: *${canvasTitle}*. Open the **Canvas** tab in this channel to view & edit.`
    });
  } catch (e: any) {
    (logger || console).error("modal submit error:", e?.data || e?.message || e);
  }
});

// =======================================================
// SHORTCUT B: Export thread as PDF (title only on page 1) + NUMBERED groups
// =======================================================
bolt.shortcut("export_pdf", async ({ ack, shortcut, client }) => {
  await ack();
  const botToken = process.env.SLACK_BOT_TOKEN as string;
  const { channel, message_ts, thread_ts } = shortcut as any;
  const root_ts = thread_ts || message_ts;
  const channel_id = channel.id as string;

  const startMsg = await client.chat.postMessage({ channel: channel_id, thread_ts: root_ts, text: "Step 0/4: Starting export…" });
  const progress_ts = (startMsg as any).ts as string;

  await client.chat.update({ channel: channel_id, ts: progress_ts, text: "Step 1/4: Reading thread…" });
  const replies = await client.conversations.replies({ channel: channel_id, ts: root_ts, limit: 200 });
  const messages = replies.messages || [];

  const rootText = findRootText(messages, root_ts);
  const niceTitle = shortTitle(rootText || "Export");
  const fileBase = sanitizeForFilename(rootText || `PrintExport_${new Date().toISOString().slice(0, 10)}`);
  const filename = `${fileBase}.pdf`;

  await client.chat.update({ channel: channel_id, ts: progress_ts, text: "Step 2/4: Grouping images by message…" });
  type Group = { caption: string; captionEs?: string; fileIds: string[] };
  const groups: Group[] = [];

  for (const m of messages) {
    const files = (m as any).files as Array<any> | undefined;
    if (!files || !files.length) continue;

    const caption =
      (m as any).text?.trim() ||
      (files[0]?.initial_comment?.comment?.trim?.() ?? "") ||
      (files[0]?.title?.trim?.() ?? "");

    const fileIds: string[] = [];
    for (const f of files) {
      if (!/^image\//.test(f.mimetype || "")) continue;
      fileIds.push(f.id);
    }
    if (fileIds.length) {
      let captionEs: string | undefined = undefined;
      if (ADD_SPANISH) {
        const res = await translateEs(caption);
        if (res.ok && res.es) captionEs = res.es;
      }
      groups.push({ caption, captionEs, fileIds });
    }
  }
  if (!groups.length) {
    await client.chat.update({ channel: channel_id, ts: progress_ts, text: "No images found in this thread." });
    return;
  }

  await client.chat.update({ channel: channel_id, ts: progress_ts, text: `Step 3/4: Building PDF…` });

  const pdf = await PDFDocument.create();
  pdf.setTitle(niceTitle);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const pageW = 612, pageH = 792;
  const margin = 36;
  const contentW = pageW - margin * 2;
  const gutter = 16;

  const titleSize = 14;
  const captionSize = 11;
  const captionEsSize = 10;
  const lineH = captionSize + 3;
  const lineHes = captionEsSize + 2;
  const maxCaptionLines = 8;
  const maxCaptionEsLines = 8;

  const tileW = Math.floor((contentW - gutter) / 2);
  const tileHMax = 240;

  function addPageNoHeader() {
    const p = pdf.addPage([pageW, pageH]);
    return p;
  }

  // First page with big title only — add a little more space before first item
  let page = addPageNoHeader();
  let y = pageH - margin;
  page.drawText(niceTitle, { x: margin, y: y - titleSize, size: titleSize, font: fontBold, color: rgb(0,0,0) });
  y -= (titleSize + 20); // was 10; increased to 20 for a bigger gap

  function ensureSpace(required: number) {
    if (y - required < margin) {
      page = addPageNoHeader();
      y = pageH - margin; // no running header; full top margin available
    }
  }

  function wrap(text: string, maxWidth: number, size: number, maxLines: number): string[] {
    const words = (text || "").replace(/\r/g, "").split(/\s+/);
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      const test = cur ? cur + " " + w : w;
      if (font.widthOfTextAtSize(test, size) <= maxWidth) cur = test;
      else {
        if (cur) lines.push(cur);
        cur = w;
        if (lines.length >= maxLines - 1) break;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  async function drawTile(x: number, topY: number, fileId: string): Promise<number> {
    const orig = await downloadOriginal(client, (process as any).env.SLACK_BOT_TOKEN as string, fileId);
    if (!orig) {
      page.drawText("[download failed]", { x, y: topY - lineH, size: captionSize, font, color: rgb(0.4,0,0) });
      return tileHMax;
    }
    try {
      const jpg = await compressToJpeg(orig, 1800);
      const img = await pdf.embedJpg(jpg);
      const iw = img.width, ih = img.height;
      const scale = Math.min(tileW / iw, tileHMax / ih);
      const w = iw * scale, h = ih * scale;
      page.drawImage(img, { x, y: topY - h, width: w, height: h });
      return h;
    } catch {
      page.drawText("[image error]", { x, y: topY - lineH, size: captionSize, font, color: rgb(0.4,0,0) });
      return tileHMax;
    }
  }

  // NUMBERED groups + Spanish line under English
  for (let idx = 0; idx < groups.length; idx++) {
    const g = groups[idx];
    const num = idx + 1;

    // Prefix number to caption for wrapping
    const captionNumbered = `${num}. ${g.caption || ""}`;

    const capLines = wrap(captionNumbered, contentW, captionSize, maxCaptionLines);
    const capHeight = (capLines.length ? capLines.length * lineH + 2 : 0);

    const esLines = (ADD_SPANISH && g.captionEs ? wrap(g.captionEs, contentW, captionEsSize, maxCaptionEsLines) : []);
    const esHeight = esLines.length ? esLines.length * lineHes + 6 : 0;

    const firstRow = g.fileIds.length ? (tileHMax + 14) : 0;
    ensureSpace(capHeight + esHeight + firstRow);

    // English (numbered)
    if (capHeight) {
      let yy = y - captionSize;
      for (const line of capLines) {
        page.drawText(line, { x: margin, y: yy, size: captionSize, font, color: rgb(0,0,0) });
        yy -= lineH;
      }
      y = yy - 2;
    }

    // Spanish (below)
    if (esLines.length) {
      let yy = y - captionEsSize;
      for (const line of esLines) {
        page.drawText(line, { x: margin, y: yy, size: captionEsSize, font, color: rgb(0.2,0.2,0.2) });
        yy -= lineHes;
      }
      y = yy - 6;
    }

    // Images (2-across)
    for (let i = 0; i < g.fileIds.length; i += 2) {
      ensureSpace(tileHMax + 14);
      const hLeft = await drawTile(margin, y, g.fileIds[i]);
      let hRight = 0;
      if (i + 1 < g.fileIds.length) {
        hRight = await drawTile(margin + tileW + 16, y, g.fileIds[i + 1]);
      }
      const rowH = Math.max(hLeft, hRight);
      y -= (rowH + 14);
    }

    y -= 10; // gap between groups
  }

  const pdfBytes = await pdf.save();
  const bodyBuf = Buffer.from(pdfBytes);

  await client.chat.update({ channel: channel_id, ts: progress_ts, text: "Step 4/4: Uploading PDF…" });

  const up2 = await (client as any).files.uploadV2({
    channel_id,
    thread_ts: root_ts,
    filename,
    initial_comment: `📄 ${niceTitle}`,
    file: bodyBuf,
    content_type: "application/pdf",
    title: niceTitle
  });

  if (!up2?.ok) {
    await client.chat.update({ channel: channel_id, ts: progress_ts, text: `Upload failed: ${up2?.error || "unknown_error"}` });
    return;
  }

  await client.chat.update({ channel: channel_id, ts: progress_ts, text: "✅ Done: PDF posted in this thread." });
});

(async () => {
  await bolt.start(process.env.PORT || 3000);
  console.log("⚡ Collate-to-Canvas running | Spanish", ADD_SPANISH ? "ON" : "OFF", "| Key", DEEPL_API_KEY ? "present" : "absent");
})();