"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const crypto_1 = __importDefault(require("crypto"));
const bolt_1 = require("@slack/bolt");
const pdf_lib_1 = require("pdf-lib");
/**
 * ENV REQUIRED (set in Render):
 * SLACK_BOT_TOKEN=xoxb-...
 * SLACK_SIGNING_SECRET=...
 *
 * Scopes used (already in your app):
 * - chat:write, commands, files:read, files:write, channels:history, groups:history, canvases:write, canvases:read
 */
const receiver = new bolt_1.ExpressReceiver({
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    endpoints: "/slack/events"
});
const bolt = new bolt_1.App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    receiver
});
// ---------- Helpers ----------
function verifySlackSig(req) {
    const ts = req.headers["x-slack-request-timestamp"];
    const sig = req.headers["x-slack-signature"];
    if (!ts || !sig)
        return false;
    const fiveMinutes = 60 * 5;
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - Number(ts)) > fiveMinutes)
        return false;
    const body = req.rawBody;
    const base = `v0:${ts}:${body}`;
    const hmac = crypto_1.default
        .createHmac("sha256", process.env.SLACK_SIGNING_SECRET)
        .update(base)
        .digest("hex");
    const expected = `v0=${hmac}`;
    return crypto_1.default.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}
// capture raw body for signature verification
const app = receiver.app;
app.use("/slack", express_1.default.raw({ type: "*/*" }), (req, _res, next) => {
    req.rawBody =
        req.rawBody || req.body?.toString?.() || req.body;
    next();
});
// Slash command just educates users
app.post("/slack/commands", async (req, res) => {
    if (!verifySlackSig(req))
        return res.status(401).send("bad sig");
    const payload = new URLSearchParams(req.rawBody);
    const command = payload.get("command");
    if (command !== "/collate")
        return res.send("");
    return res.json({
        response_type: "ephemeral",
        text: "Use the message shortcut *Collate thread to Canvas* on any message inside the thread that contains your images. " +
            "(Slash commands don’t carry thread context.)"
    });
});
// ========== SHORTCUT A: Collate to Canvas (kept as-is) ==========
bolt.shortcut("collate_thread", async ({ ack, shortcut, client, logger }) => {
    await ack();
    try {
        const { channel, message_ts, thread_ts, trigger_id } = shortcut;
        const root_ts = thread_ts || message_ts;
        await client.views.open({
            trigger_id,
            view: {
                type: "modal",
                callback_id: "collate_modal",
                private_metadata: JSON.stringify({
                    channel_id: channel.id,
                    thread_ts: root_ts
                }),
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
    }
    catch (e) {
        (logger || console).error("shortcut error:", e?.data || e?.message || e);
    }
});
bolt.view("collate_modal", async ({ ack, view, client, logger }) => {
    await ack();
    try {
        const meta = JSON.parse(view.private_metadata || "{}");
        const channel_id = meta.channel_id;
        const thread_ts = meta.thread_ts;
        const category = (view.state.values.category_block.category_action.selected_option?.value ||
            "other");
        // get replies
        const replies = await client.conversations.replies({
            channel: channel_id,
            ts: thread_ts,
            limit: 200
        });
        const messages = replies.messages || [];
        // gather pairs
        const pairs = [];
        for (const m of messages) {
            const files = m.files;
            if (!files || !files.length)
                continue;
            const caption = m.text?.trim() ||
                (files[0]?.initial_comment?.comment?.trim?.() ?? "") ||
                (files[0]?.title?.trim?.() ?? "");
            for (const f of files) {
                if (!/^image\//.test(f.mimetype || ""))
                    continue;
                const info = (await client.apiCall("files.info", { file: f.id }));
                const permalink = info.file?.permalink;
                if (!permalink)
                    continue;
                pairs.push({ caption, permalink });
            }
        }
        if (!pairs.length) {
            await client.chat.postMessage({
                channel: channel_id,
                thread_ts,
                text: "I didn’t find any images in this thread."
            });
            return;
        }
        // build markdown (Description -> Image)
        const lines = [];
        lines.push(`# Collated — ${category}`);
        lines.push("");
        for (const p of pairs) {
            if (p.caption) {
                lines.push(p.caption);
                lines.push("");
            }
            lines.push(`![](${p.permalink})`);
            lines.push("");
            lines.push("---");
            lines.push("");
        }
        const markdown = lines.join("\n");
        // create canvas attached to channel
        const created = (await client.apiCall("canvases.create", {
            title: `Collated — ${category}`,
            channel_id: channel_id,
            document_content: { type: "markdown", markdown }
        }));
        if (!created?.ok) {
            (logger || console).error("canvases.create failed:", created);
            await client.chat.postMessage({
                channel: channel_id,
                thread_ts,
                text: `⚠️ Canvas create failed.`
            });
            return;
        }
        await client.chat.postMessage({
            channel: channel_id,
            thread_ts,
            text: `✅ Created a Canvas for *${category}*. Open the **Canvas** tab in this channel to view & edit.`
        });
    }
    catch (e) {
        (logger || console).error("modal submit error:", e?.data || e?.message || e);
    }
});
// ========== SHORTCUT B: Export thread as PDF (print-optimized 2-column) ==========
bolt.shortcut("export_pdf", async ({ ack, shortcut, client, logger }) => {
    await ack();
    try {
        const botToken = process.env.SLACK_BOT_TOKEN;
        const { channel, message_ts, thread_ts } = shortcut;
        const root_ts = thread_ts || message_ts;
        const channel_id = channel.id;
        // 1) fetch replies
        const replies = await client.conversations.replies({
            channel: channel_id,
            ts: root_ts,
            limit: 200
        });
        const messages = replies.messages || [];
        // 2) collect pairs, keeping file IDs & mimetypes for binary download
        const pairs = [];
        for (const m of messages) {
            const files = m.files;
            if (!files || !files.length)
                continue;
            const caption = m.text?.trim() ||
                (files[0]?.initial_comment?.comment?.trim?.() ?? "") ||
                (files[0]?.title?.trim?.() ?? "");
            for (const f of files) {
                if (!/^image\//.test(f.mimetype || ""))
                    continue;
                pairs.push({ caption, fileId: f.id, mimetype: f.mimetype });
            }
        }
        if (!pairs.length) {
            await client.chat.postMessage({
                channel: channel_id,
                thread_ts: root_ts,
                text: "I didn’t find any images in this thread to export."
            });
            return;
        }
        // 3) Download image binaries via url_private using bot token
        async function downloadBuffer(fileId) {
            const info = (await client.apiCall("files.info", { file: fileId }));
            const url = info.file?.url_private_download || info.file?.url_private;
            if (!url)
                return null;
            const res = await fetch(url, {
                headers: { Authorization: `Bearer ${botToken}` }
            });
            if (!res.ok)
                return null;
            const ab = await res.arrayBuffer();
            return new Uint8Array(ab);
        }
        // 4) Build a 2-column Letter PDF (portrait) with consistent sizing
        const pdf = await pdf_lib_1.PDFDocument.create();
        const font = await pdf.embedFont(pdf_lib_1.StandardFonts.Helvetica);
        const pageW = 612; // 8.5in * 72
        const pageH = 792; // 11in * 72
        const margin = 36; // 0.5in
        const gutter = 18; // space between columns
        const colW = (pageW - margin * 2 - gutter) / 2;
        // Box heights
        const captionSize = 10;
        const lineHeight = captionSize + 2;
        const maxCaptionLines = 6; // cap to keep things tight
        const captionBlockH = maxCaptionLines * lineHeight + 6;
        const imageMaxH = 220; // tweak as needed for density
        const cellH = captionBlockH + imageMaxH + 12;
        // Header
        const title = "Print Export";
        function addPage() {
            const p = pdf.addPage([pageW, pageH]);
            p.drawText(title, { x: margin, y: pageH - margin + 6, size: 12, font, color: (0, pdf_lib_1.rgb)(0, 0, 0) });
            return p;
        }
        let page = addPage();
        let curY = pageH - margin - 18; // start below header
        let col = 0; // 0 left, 1 right
        // simple text wrap by measuring width
        function wrapText(text, maxWidth, maxLines) {
            const words = text.replace(/\r/g, "").split(/\s+/);
            const lines = [];
            let cur = "";
            for (const w of words) {
                const test = cur ? cur + " " + w : w;
                if (font.widthOfTextAtSize(test, captionSize) <= maxWidth) {
                    cur = test;
                }
                else {
                    lines.push(cur);
                    cur = w;
                    if (lines.length >= maxLines - 1)
                        break;
                }
            }
            if (cur)
                lines.push(cur);
            return lines.slice(0, maxLines);
        }
        for (const p of pairs) {
            // new row if needed
            const x = margin + (col === 0 ? 0 : colW + gutter);
            if (curY - cellH < margin) {
                page = addPage();
                curY = pageH - margin - 18;
                col = 0;
            }
            // caption first (as requested)
            const caption = p.caption || "";
            const wrapped = wrapText(caption, colW, maxCaptionLines);
            let textY = curY - lineHeight;
            for (const line of wrapped) {
                page.drawText(line, { x, y: textY, size: captionSize, font, color: (0, pdf_lib_1.rgb)(0, 0, 0) });
                textY -= lineHeight;
            }
            const afterCaptionY = textY - 6;
            // image
            const buf = await downloadBuffer(p.fileId);
            if (buf) {
                // try JPEG then PNG
                let img = null;
                try {
                    img = await pdf.embedJpg(buf);
                }
                catch {
                    try {
                        img = await pdf.embedPng(buf);
                    }
                    catch {
                        img = null;
                    }
                }
                if (img) {
                    const iw = img.width;
                    const ih = img.height;
                    const scale = Math.min(colW / iw, imageMaxH / ih);
                    const w = iw * scale;
                    const h = ih * scale;
                    page.drawImage(img, { x, y: afterCaptionY - h, width: w, height: h });
                }
                else {
                    // fallback text if format not supported (e.g., HEIC)
                    page.drawText("[unsupported image format]", {
                        x,
                        y: afterCaptionY - lineHeight,
                        size: captionSize,
                        font,
                        color: (0, pdf_lib_1.rgb)(0.4, 0, 0)
                    });
                }
            }
            else {
                page.drawText("[failed to download image]", {
                    x,
                    y: afterCaptionY - lineHeight,
                    size: captionSize,
                    font,
                    color: (0, pdf_lib_1.rgb)(0.4, 0, 0)
                });
            }
            // advance column / row
            if (col === 0) {
                col = 1;
            }
            else {
                col = 0;
                curY = afterCaptionY - imageMaxH - 12; // next row
            }
        }
        const pdfBytes = await pdf.save();
        const filename = `PrintExport_${new Date().toISOString().slice(0, 10)}.pdf`;
        // 5) Upload using Slack's new external upload flow
        const up = (await client.apiCall("files.getUploadURLExternal", {
            filename,
            length: pdfBytes.length
        }));
        if (!up?.ok) {
            (logger || console).error("getUploadURLExternal failed:", up);
            await client.chat.postMessage({
                channel: channel_id,
                thread_ts: root_ts,
                text: "⚠️ PDF upload init failed."
            });
            return;
        }
        const upload_url = up.upload_url;
        const file_id = up.file_id;
        // PUT to upload_url
        const putRes = await fetch(upload_url, {
            method: "PUT",
            headers: { "Content-Type": "application/octet-stream" },
            body: Buffer.from(pdfBytes)
        });
        if (!putRes.ok) {
            await client.chat.postMessage({
                channel: channel_id,
                thread_ts: root_ts,
                text: "⚠️ PDF upload transfer failed."
            });
            return;
        }
        // Complete upload (post back to same channel/thread)
        await client.apiCall("files.completeUploadExternal", {
            files: [{ id: file_id, title: filename }],
            channel_id: channel_id,
            initial_comment: `📄 Print-optimized PDF ready (${pairs.length} photos).`,
            thread_ts: root_ts
        });
    }
    catch (e) {
        (logger || console).error("export_pdf error:", e?.data || e?.message || e);
    }
});
(async () => {
    await bolt.start(process.env.PORT || 3000);
    console.log("⚡ Collate-to-Canvas running");
})();
