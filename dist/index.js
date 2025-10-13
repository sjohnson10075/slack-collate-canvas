"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const crypto_1 = __importDefault(require("crypto"));
const bolt_1 = require("@slack/bolt");
const node_fetch_1 = __importDefault(require("node-fetch"));
const pdf_lib_1 = require("pdf-lib");
/**
 * ENV REQUIRED (Render):
 * - SLACK_BOT_TOKEN=xoxb-...
 * - SLACK_SIGNING_SECRET=...
 *
 * Scopes used:
 * chat:write, commands, files:read, files:write, channels:history, groups:history, canvases:write, canvases:read
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
    const hmac = crypto_1.default.createHmac("sha256", process.env.SLACK_SIGNING_SECRET).update(base).digest("hex");
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
// ---------- Slash command (informational only) ----------
app.post("/slack/commands", async (req, res) => {
    if (!verifySlackSig(req))
        return res.status(401).send("bad sig");
    const payload = new URLSearchParams(req.rawBody);
    const command = payload.get("command");
    if (command !== "/collate")
        return res.send("");
    return res.json({
        response_type: "ephemeral",
        text: "Use the message shortcut *Collate thread to Canvas* on any message inside the thread that contains your images. (Slash commands don’t carry thread context.)"
    });
});
// ========== SHORTCUT A: Collate thread to Canvas ==========
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
        const category = (view.state.values.category_block.category_action.selected_option?.value || "other");
        const replies = await client.conversations.replies({ channel: channel_id, ts: thread_ts, limit: 200 });
        const messages = replies.messages || [];
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
            await client.chat.postMessage({ channel: channel_id, thread_ts, text: "I didn’t find any images in this thread." });
            return;
        }
        const lines = [];
        lines.push(`# Collated — ${category}`, "");
        for (const p of pairs) {
            if (p.caption)
                lines.push(p.caption, "");
            lines.push(`![](${p.permalink})`, "", "---", "");
        }
        const markdown = lines.join("\n");
        const created = (await client.apiCall("canvases.create", {
            title: `Collated — ${category}`,
            channel_id: channel_id,
            document_content: { type: "markdown", markdown }
        }));
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
    }
    catch (e) {
        (logger || console).error("modal submit error:", e?.data || e?.message || e);
    }
});
// ========== SHORTCUT B: Export thread as PDF (robust upload + verify) ==========
bolt.shortcut("export_pdf", async ({ ack, shortcut, client }) => {
    await ack();
    const botToken = process.env.SLACK_BOT_TOKEN;
    const { channel, message_ts, thread_ts } = shortcut;
    const root_ts = thread_ts || message_ts;
    const channel_id = channel.id;
    // Step 0: start
    const startMsg = await client.chat.postMessage({ channel: channel_id, thread_ts: root_ts, text: "Step 0/6: Starting export…" });
    const progress_ts = startMsg.ts;
    // Step 1: fetch replies
    await client.chat.update({ channel: channel_id, ts: progress_ts, text: "Step 1/6: Reading thread…" });
    const replies = await client.conversations.replies({ channel: channel_id, ts: root_ts, limit: 200 });
    const messages = replies.messages || [];
    // Step 2: collect images
    await client.chat.update({ channel: channel_id, ts: progress_ts, text: "Step 2/6: Collecting images…" });
    const imgs = [];
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
            imgs.push({ caption, fileId: f.id });
        }
    }
    if (!imgs.length) {
        await client.chat.update({ channel: channel_id, ts: progress_ts, text: "No images found in this thread." });
        return;
    }
    // Step 3: build PDF (Letter portrait, 2 columns)
    await client.chat.update({ channel: channel_id, ts: progress_ts, text: `Step 3/6: Building PDF for ${imgs.length} images…` });
    async function downloadBuffer(fileId) {
        try {
            const info = (await client.apiCall("files.info", { file: fileId }));
            const url = info.file?.url_private_download || info.file?.url_private;
            if (!url)
                return null;
            const res = await (0, node_fetch_1.default)(url, { headers: { Authorization: `Bearer ${botToken}` } });
            if (!res.ok)
                return null;
            const ab = await res.arrayBuffer();
            return new Uint8Array(ab);
        }
        catch {
            return null;
        }
    }
    const pdf = await pdf_lib_1.PDFDocument.create();
    const font = await pdf.embedFont(pdf_lib_1.StandardFonts.Helvetica);
    const pageW = 612, pageH = 792, margin = 36, gutter = 18;
    const colW = (pageW - margin * 2 - gutter) / 2;
    const captionSize = 10, lineHeight = captionSize + 2, maxCaptionLines = 6;
    const captionBlockH = maxCaptionLines * lineHeight + 6;
    const imageMaxH = 220;
    const cellH = captionBlockH + imageMaxH + 12;
    function addPage() {
        const p = pdf.addPage([pageW, pageH]);
        p.drawText("Print Export", { x: margin, y: pageH - margin + 6, size: 12, font, color: (0, pdf_lib_1.rgb)(0, 0, 0) });
        return p;
    }
    let page = addPage();
    let curY = pageH - margin - 18;
    let col = 0;
    function wrapText(text, maxWidth, maxLines) {
        const words = (text || "").replace(/\r/g, "").split(/\s+/);
        const lines = [];
        let cur = "";
        for (const w of words) {
            const test = cur ? cur + " " + w : w;
            if (font.widthOfTextAtSize(test, captionSize) <= maxWidth)
                cur = test;
            else {
                if (cur)
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
    for (const [i, it] of imgs.entries()) {
        const x = margin + (col === 0 ? 0 : colW + gutter);
        if (curY - cellH < margin) {
            page = addPage();
            curY = pageH - margin - 18;
            col = 0;
        }
        const wrapped = wrapText(it.caption, colW, maxCaptionLines);
        let textY = curY - lineHeight;
        for (const line of wrapped) {
            page.drawText(line, { x, y: textY, size: captionSize, font, color: (0, pdf_lib_1.rgb)(0, 0, 0) });
            textY -= lineHeight;
        }
        const afterCaptionY = textY - 6;
        const buf = await downloadBuffer(it.fileId);
        if (buf) {
            let img = null;
            try {
                img = await pdf.embedJpg(buf);
            }
            catch { }
            if (!img) {
                try {
                    img = await pdf.embedPng(buf);
                }
                catch { }
            }
            if (img) {
                const iw = img.width, ih = img.height;
                const scale = Math.min(colW / iw, imageMaxH / ih);
                const w = iw * scale, h = ih * scale;
                page.drawImage(img, { x, y: afterCaptionY - h, width: w, height: h });
            }
            else {
                page.drawText("[unsupported image format]", { x, y: afterCaptionY - lineHeight, size: captionSize, font, color: (0, pdf_lib_1.rgb)(0.4, 0, 0) });
            }
        }
        else {
            page.drawText("[failed to download image]", { x, y: afterCaptionY - lineHeight, size: captionSize, font, color: (0, pdf_lib_1.rgb)(0.4, 0, 0) });
        }
        if (i % 4 === 3) {
            await client.chat.update({ channel: channel_id, ts: progress_ts, text: `Step 3/6: Building PDF… (${i + 1}/${imgs.length})` });
        }
        if (col === 0)
            col = 1;
        else {
            col = 0;
            curY = afterCaptionY - imageMaxH - 12;
        }
    }
    const pdfBytes = await pdf.save();
    const bodyBuf = Buffer.from(pdfBytes);
    const byteLen = bodyBuf.length;
    // Step 4: init upload
    await client.chat.update({ channel: channel_id, ts: progress_ts, text: "Step 4/6: Initializing upload…" });
    const filename = `PrintExport_${new Date().toISOString().slice(0, 10)}.pdf`;
    const up = (await client.apiCall("files.getUploadURLExternal", {
        filename,
        length: byteLen
    }));
    if (!up?.ok) {
        await client.chat.update({ channel: channel_id, ts: progress_ts, text: `Upload init failed: ${up?.error || "unknown_error"}` });
        return;
    }
    const upload_url = up.upload_url;
    const file_id = up.file_id;
    // Step 4b: PUT with explicit headers
    const putRes = await (0, node_fetch_1.default)(upload_url, {
        method: "PUT",
        headers: {
            "Content-Type": "application/pdf",
            "Content-Length": byteLen.toString()
        },
        body: bodyBuf
    });
    if (!putRes.ok) {
        await client.chat.update({ channel: channel_id, ts: progress_ts, text: `Upload transfer failed: ${putRes.status} ${putRes.statusText}` });
        return;
    }
    // Step 5: complete upload (share directly to thread)
    await client.chat.update({ channel: channel_id, ts: progress_ts, text: "Step 5/6: Finalizing upload…" });
    const done = (await client.apiCall("files.completeUploadExternal", {
        files: [{ id: file_id, title: filename }],
        channel_id: channel_id,
        initial_comment: `📄 Print-optimized PDF ready (${imgs.length} photos).`,
        thread_ts: root_ts
    }));
    if (!done?.ok) {
        await client.chat.update({ channel: channel_id, ts: progress_ts, text: `Finalize failed: ${done?.error || "unknown_error"}` });
        return;
    }
    // Step 6: verify + post permalink (in case Slack delays file card)
    await client.chat.update({ channel: channel_id, ts: progress_ts, text: "Step 6/6: Verifying file…" });
    let permalink = null;
    for (let i = 0; i < 8; i++) { // try up to ~8s
        try {
            const info = (await client.apiCall("files.info", { file: file_id }));
            permalink = info?.file?.permalink || null;
            if (permalink)
                break;
        }
        catch { }
        await new Promise(r => setTimeout(r, 1000));
    }
    if (permalink) {
        await client.chat.postMessage({
            channel: channel_id,
            thread_ts: root_ts,
            text: `📎 PDF: ${permalink}`
        });
    }
    await client.chat.update({ channel: channel_id, ts: progress_ts, text: "✅ Done: PDF posted in this thread." });
});
(async () => {
    await bolt.start(process.env.PORT || 3000);
    console.log("⚡ Collate-to-Canvas running");
})();
