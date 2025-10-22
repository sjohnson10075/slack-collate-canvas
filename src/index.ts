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

async function compressToJpeg(buf: Buffer): Promise<Buffer> {
  return await sharp(buf)
    .rotate() // respect EXIF
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 72, chromaSubsampling: "4:2:0", mozjpeg: true })
    .toBuffer();
}

// =======================================================
// SHORTCUT A: Collate thread to Canvas (GROUP BY MESSAGE)
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

    // Read thread
    const replies = await client.conversations.replies({ channel: channel_id, ts: thread_ts, limit: 200 });
    const messages = replies.messages || [];

    // Group by message: one caption, many images
    type Group = { caption: string; filePermalinks: string[] };
    const groups: Group[] = [];

    for (const m of messages) {
      const files = (m as any).files as Array<any> | undefined;
      if (!files || !files.length) continue;

      // caption from the message (or from first file metadata)
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
        groups.push({ caption, filePermalinks: permaList });
      }
    }

    if (!groups.length) {
      await client.chat.postMessage({ channel: channel_id, thread_ts, text: "I didn’t find any images in this thread." });
      return;
    }

    // Canvas content (Markdown): Caption once, then ALL images from that message
    const lines: string[] = [];
    lines.push(`# Collated — ${category}`, "");
    for (const g of groups) {
      if (g.caption) lines.push(g.caption, "");
      for (const link of g.filePermalinks) {
        lines.push(`![](${link})`);
      }
      lines.push("", "---", "");
    }
    const markdown = lines.join("\n");

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

// =======================================================
// SHORTCUT B: Export thread as PDF (GROUP BY MESSAGE)
// =======================================================
bolt.shortcut("export_pdf", async ({ ack, shortcut, client }) => {
  await ack();
  const botToken = process.env.SLACK_BOT_TOKEN as string;
  const { channel, message_ts, thread_ts } = shortcut as any;
  const root_ts = thread_ts || message_ts;
  const channel_id = channel.id as string;

  // Step 0: start
  const startMsg = await client.chat.postMessage({ channel: channel_id, thread_ts: root_ts, text: "Step 0/4: Starting export…" });
  const progress_ts = (startMsg as any).ts as string;

  // Step 1: fetch replies
  await client.chat.update({ channel: channel_id, ts: progress_ts, text: "Step 1/4: Reading thread…" });
  const replies = await client.conversations.replies({ channel: channel_id, ts: root_ts, limit: 200 });
  const messages = replies.messages || [];

  // Step 2: collect groups (caption once, many fileIds)
  await client.chat.update({ channel: channel_id, ts: progress_ts, text: "Step 2/4: Grouping images by message…" });

  type Group = { caption: string; fileIds: string[] };
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
    if (fileIds.length) groups.push({ caption, fileIds });
  }
  if (!groups.length) {
    await client.chat.update({ channel: channel_id, ts: progress_ts, text: "No images found in this thread." });
    return;
  }

  // Step 3: build PDF (Letter portrait, 2 columns)
  await client.chat.update({ channel: channel_id, ts: progress_ts, text: `Step 3/4: Building PDF for ${groups.reduce((a,g)=>a+g.fileIds.length,0)} images…` });

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  // Page & layout
  const pageW = 612, pageH = 792, margin = 36, gutter = 18;
  const colW = (pageW - margin * 2 - gutter) / 2;
  const captionSize = 10, lineHeight = captionSize + 2, maxCaptionLines = 6;
  const imageMaxH = 220;

  // Heights
  const captionBlockH = maxCaptionLines * lineHeight + 6;
  const cellHFirst = captionBlockH + imageMaxH + 12; // first image under caption
  const cellHNoCaption = imageMaxH + 12;             // subsequent images in same message

  function addPage() {
    const p = pdf.addPage([pageW, pageH]);
    p.drawText("Print Export", { x: margin, y: pageH - margin + 6, size: 12, font, color: rgb(0,0,0) });
    return p;
  }

  let page = addPage();
  let curY = pageH - margin - 18;
  let col = 0;

  function wrapText(text: string, maxWidth: number, maxLines: number): string[] {
    const words = (text || "").replace(/\r/g, "").split(/\s+/);
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      const test = cur ? cur + " " + w : w;
      if (font.widthOfTextAtSize(test, captionSize) <= maxWidth) cur = test;
      else {
        if (cur) lines.push(cur);
        cur = w;
        if (lines.length >= maxLines - 1) break;
      }
    }
    if (cur) lines.push(cur);
    return lines.slice(0, maxLines);
  }

  // Draw one image scaled to fit the column width and imageMaxH
  async function drawImageBelow(yTop: number, x: number, fileId: string): Promise<number> {
    const orig = await downloadOriginal(client, botToken, fileId);
    if (!orig) {
      page.drawText("[failed to download image]", { x, y: yTop - lineHeight, size: captionSize, font, color: rgb(0.4,0,0) });
      return yTop - (imageMaxH + 12);
    }
    try {
      const jpg = await compressToJpeg(orig);
      const img = await pdf.embedJpg(jpg);
      const iw = img.width, ih = img.height;
      const scale = Math.min(colW / iw, imageMaxH / ih);
      const w = iw * scale, h = ih * scale;
      page.drawImage(img, { x, y: yTop - h, width: w, height: h });
      return yTop - (h + 12);
    } catch {
      page.drawText("[image processing failed]", { x, y: yTop - lineHeight, size: captionSize, font, color: rgb(0.4,0,0) });
      return yTop - (imageMaxH + 12);
    }
  }

  // Column/page management
  function ensureSpace(requiredH: number) {
    if ((curY - requiredH) < margin) {
      // next column or new page
      if (col === 0) {
        col = 1;
        curY = pageH - margin - 18;
      } else {
        page = addPage();
        col = 0;
        curY = pageH - margin - 18;
      }
    }
  }

  for (const g of groups) {
    const x = margin + (col === 0 ? 0 : colW + gutter);

    // FIRST image (with caption)
    ensureSpace(cellHFirst);

    // caption (wrap)
    const wrapped = wrapText(g.caption || "", colW, maxCaptionLines);
    let captionY = curY - lineHeight;
    for (const line of wrapped) {
      page.drawText(line, { x, y: captionY, size: captionSize, font, color: rgb(0,0,0) });
      captionY -= lineHeight;
    }
    let nextY = captionY - 6;

    if (g.fileIds.length) {
      // draw first image under caption
      nextY = await drawImageBelow(nextY, x, g.fileIds[0]);
    }

    // SUBSEQUENT images in the same group (no caption; stack them below)
    for (let idx = 1; idx < g.fileIds.length; idx++) {
      // if not enough space, move to next column/page before drawing next image
      ensureSpace(cellHNoCaption);
      const x2 = margin + (col === 0 ? 0 : colW + gutter);
      if (x2 !== x) {
        // we changed column/page; reset x and Y for the continuing images
        nextY = curY;
      }
      nextY = await drawImageBelow(nextY, x2, g.fileIds[idx]);
      // update column tracker Y only if we stayed in the same column
      curY = nextY;
    }

    // After finishing this group, set curY for next group if we drew at least one image.
    // If no images (edge case), just consume a minimal block to avoid overlap.
    if (g.fileIds.length) {
      curY = nextY;
    } else {
      curY = curY - (captionBlockH + 12);
    }

    // add a little spacing between groups
    curY -= 12;

    // if spacing pushes below margin, advance column/page
    if (curY < margin) {
      if (col === 0) {
        col = 1;
        curY = pageH - margin - 18;
      } else {
        page = addPage();
        col = 0;
        curY = pageH - margin - 18;
      }
    }
  }

  const pdfBytes = await pdf.save();
  const bodyBuf = Buffer.from(pdfBytes);
  const filename = `PrintExport_${new Date().toISOString().slice(0, 10)}.pdf`;

  // Step 4: upload via files.uploadV2 (multipart)
  await client.chat.update({ channel: channel_id, ts: progress_ts, text: "Step 4/4: Uploading PDF…" });

  const up2 = await (client as any).files.uploadV2({
    channel_id,
    thread_ts: root_ts,
    filename,
    initial_comment: `📄 Print-optimized PDF ready.`,
    file: bodyBuf,
    content_type: "application/pdf",
    title: filename
  });

  if (!up2?.ok) {
    await client.chat.update({ channel: channel_id, ts: progress_ts, text: `Upload failed: ${up2?.error || "unknown_error"}` });
    return;
  }

  await client.chat.update({ channel: channel_id, ts: progress_ts, text: "✅ Done: PDF posted in this thread." });
});

(async () => {
  await bolt.start(process.env.PORT || 3000);
  console.log("⚡ Collate-to-Canvas running");
})();