import express from "express";
import crypto from "crypto";
import { App, ExpressReceiver } from "@slack/bolt";
import fetch from "node-fetch";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

/**
 * ENV REQUIRED (in Render):
 * - SLACK_BOT_TOKEN=xoxb-...
 * - SLACK_SIGNING_SECRET=...
 *
 * Scopes used (already in your app):
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

type Pair = { caption: string; permalink: string };
type Img = { caption: string; fileId: string; mimetype: string };

// ---------- Helpers ----------
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
  (req as any).rawBody = (req as any).rawBody || (req as any).body?.toString?.() || req.body;
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
    text: "Use the message shortcut *Collate thread to Canvas* on any message inside the thread that contains your images. (Slash commands don’t carry thread context.)"
  });
});

// ========== SHORTCUT A: Collate thread to Canvas ==========
bolt.shortcut("collate_thread", async ({ ack, shortcut, client, logger }) => {
  await ack();
  try {
    const { channel, message_ts, thread_ts, trigger_id } = shortcut as any;
    const root_ts = thread_ts || message_ts;

    await client.views.open({
      trigger_id,
      view: {
        type: "modal",
        callback_id: "collate_modal",
        private_metadata: JSON.stringify({ channel_id: channel.id, thread_ts: root_ts }),
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

    // Get replies
    const replies = await client.conversations.replies({ channel: channel_id, ts: thread_ts, limit: 200 });
    const messages = replies.messages || [];

    // Gather pairs
    const pairs: Pair[] = [];
    for (const m of messages) {
      const files = (m as any).files as Array<any> | undefined;
      if (!files || !files.length) continue;

      const caption =
        (m as any).text?.trim() ||
        (files[0]?.initial_comment?.comment?.trim?.() ?? "") ||
        (files[0]?.title?.trim?.() ?? "");

      for (const f of files) {
        if (!/^image\//.test(f.mimetype || "")) continue;
        const info = (await client.apiCall("files.info", { file: f.id })) as any;
        const permalink = info.file?.permalink as string;
        if (!permalink) continue;
        pairs.push({ caption, permalink });
      }
    }

    if (!pairs.length) {
      await client.chat.postMessage({ channel: channel_id, thread_ts, text: "I didn’t find any images in this thread." });
      return;
    }

    // Build markdown (Description → Image)
    const lines: string[] = [];
    lines.push(`# Collated — ${category}`, "");
    for (const p of pairs) {
      if (p.caption) lines.push(p.caption, "");
      lines.push(`![](${p.permalink})`, "", "---", "");
    }
    const markdown = lines.join("\n");

    // Create canvas attached to channel
    const created = (await client.apiCall("canvases.create", {
      title: `Collated — ${category}`,
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
      text: `✅ Created a Canvas for *${category}*. Open the **Canvas** tab in this channel to view & edit.`
    });
  } catch (e: any) {
    (logger || console).error("modal submit error:", e?.data || e?.message || e);
  }
});

// ========== SHORTCUT B: Export thread as PDF (2-column print-optimized) ==========
bolt.shortcut("export_pdf", async ({ ack, shortcut, client, logger }) => {
  await ack();
  try {
    const botToken = process.env.SLACK_BOT_TOKEN as string;
    const { channel, message_ts, thread_ts } = shortcut as any;
    const root_ts = thread_ts || message_ts;
    const channel_id = channel.id as string;

    // Post a quick "working" note (so users see activity)
    await client.chat.postMessage({ channel: channel_id, thread_ts: root_ts, text: "Generating print-optimized PDF…" });

    // 1) fetch replies
    const replies = await client.conversations.replies({ channel: channel_id, ts: root_ts, limit: 200 });
    const messages = replies.messages || [];

    // 2) collect images with file IDs
    const imgs: Img[] = [];
    for (const m of messages) {
      const files = (m as any).files as Array<any> | undefined;
      if (!files || !files.length) continue;
      const caption =
        (m as any).text?.trim() ||
        (files[0]?.initial_comment?.comment?.trim?.() ?? "") ||
        (files[0]?.title?.trim?.() ?? "");
      for (const f of files) {
        if (!/^image\//.test(f.mimetype || "")) continue;
        imgs.push({ caption, fileId: f.id, mimetype: f.mimetype });
      }
    }

    if (!imgs.length) {
      await client.chat.postMessage({ channel: channel_id, thread_ts: root_ts, text: "I didn’t find any images in this thread to export." });
      return;
    }

    // 3) download helper
    async function downloadBuffer(fileId: string): Promise<Uint8Array | null> {
      try {
        const info = (await client.apiCall("files.info", { file: fileId })) as any;
        const url = info.file?.url_private_download || info.file?.url_private;
        if (!url) {
          (logger || console).error("download: missing url_private*", { fileId });
          return null;
        }
        const res = await fetch(url, { headers: { Authorization: `Bearer ${botToken}` } } as any);
        if (!res.ok) {
          (logger || console).error("download: bad status", { fileId, status: (res as any).status, statusText: (res as any).statusText });
          return null;
        }
        const ab = await res.arrayBuffer();
        return new Uint8Array(ab);
      } catch (err: any) {
        (logger || console).error("download: fetch error", err?.message || err);
        return null;
      }
    }

    // 4) create PDF (Letter, portrait), two columns
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const pageW = 612, pageH = 792, margin = 36, gutter = 18;
    const colW = (pageW - margin * 2 - gutter) / 2;

    const captionSize = 10, lineHeight = captionSize + 2, maxCaptionLines = 6;
    const captionBlockH = maxCaptionLines * lineHeight + 6;
    const imageMaxH = 220;
    const cellH = captionBlockH + imageMaxH + 12;

    function addPage() {
      const p = pdf.addPage([pageW, pageH]);
      p.drawText("Print Export", { x: margin, y: pageH - margin + 6, size: 12, font, color: rgb(0,0,0) });
      return p;
    }
    let page = addPage();
    let curY = pageH - margin - 18;
    let col = 0;

    function wrapText(text: string, maxWidth: number, maxLines: number): string[] {
      const words = text.replace(/\r/g, "").split(/\s+/);
      const lines: string[] = [];
      let cur = "";
      for (const w of words) {
        const test = cur ? cur + " " + w : w;
        if (font.widthOfTextAtSize(test, captionSize) <= maxWidth) cur = test;
        else {
          lines.push(cur); cur = w;
          if (lines.length >= maxLines - 1) break;
        }
      }
      if (cur) lines.push(cur);
      return lines.slice(0, maxLines);
    }

    for (const it of imgs) {
      const x = margin + (col === 0 ? 0 : colW + gutter);
      if (curY - cellH < margin) {
        page = addPage();
        curY = pageH - margin - 18;
        col = 0;
      }

      // caption first
      const wrapped = wrapText(it.caption || "", colW, maxCaptionLines);
      let textY = curY - lineHeight;
      for (const line of wrapped) {
        page.drawText(line, { x, y: textY, size: captionSize, font, color: rgb(0,0,0) });
        textY -= lineHeight;
      }
      const afterCaptionY = textY - 6;

      // image
      const buf = await downloadBuffer(it.fileId);
      if (buf) {
        let img: any = null;
        try { img = await pdf.embedJpg(buf); } catch {}
        if (!img) { try { img = await pdf.embedPng(buf); } catch {} }
        if (img) {
          const iw = img.width, ih = img.height;
          const scale = Math.min(colW / iw, imageMaxH / ih);
          const w = iw * scale, h = ih * scale;
          page.drawImage(img, { x, y: afterCaptionY - h, width: w, height: h });
        } else {
          page.drawText("[unsupported image format]", { x, y: afterCaptionY - lineHeight, size: captionSize, font, color: rgb(0.4,0,0) });
        }
      } else {
        page.drawText("[failed to download image]", { x, y: afterCaptionY - lineHeight, size: captionSize, font, color: rgb(0.4,0,0) });
      }

      if (col === 0) col = 1; else { col = 0; curY = afterCaptionY - imageMaxH - 12; }
    }

    const pdfBytes = await pdf.save();
    const filename = `PrintExport_${new Date().toISOString().slice(0, 10)}.pdf`;

    // 5) Upload via new external upload flow
    const up = (await client.apiCall("files.getUploadURLExternal", { filename, length: pdfBytes.length })) as any;
    if (!up?.ok) {
      (logger || console).error("getUploadURLExternal failed:", up);
      await client.chat.postMessage({ channel: channel_id, thread_ts: root_ts, text: "⚠️ PDF upload init failed." });
      return;
    }
    const upload_url = up.upload_url as string;
    const file_id = up.file_id as string;

    const putRes = await fetch(upload_url, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: Buffer.from(pdfBytes) } as any);
    if (!(putRes as any).ok) {
      (logger || console).error("PUT upload failed", { status: (putRes as any).status, statusText: (putRes as any).statusText });
      await client.chat.postMessage({ channel: channel_id, thread_ts: root_ts, text: "⚠️ PDF upload transfer failed." });
      return;
    }

    await client.apiCall("files.completeUploadExternal", {
      files: [{ id: file_id, title: filename }],
      channel_id: channel_id,
      initial_comment: `📄 Print-optimized PDF ready (${imgs.length} photos).`,
      thread_ts: root_ts
    });
  } catch (e: any) {
    (logger || console).error("export_pdf error:", e?.data || e?.message || e);
    // Let users know something went wrong
    try {
      const { channel, message_ts, thread_ts }: any = (e && (e as any).shortcut) || {};
      const root_ts = thread_ts || message_ts;
      if (channel?.id && root_ts) {
        await (bolt.client.chat.postMessage as any)({ channel: channel.id, thread_ts: root_ts, text: "⚠️ Export failed." });
      }
    } catch {}
  }
});

(async () => {
  await bolt.start(process.env.PORT || 3000);
  console.log("⚡ Collate-to-Canvas running");
})();