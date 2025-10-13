"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const crypto_1 = __importDefault(require("crypto"));
const bolt_1 = require("@slack/bolt");
/**
 * ENV REQUIRED (set in Render):
 * SLACK_BOT_TOKEN=xoxb-...
 * SLACK_SIGNING_SECRET=...
 *
 * App capabilities needed (already in your manifest):
 * - chat:write
 * - commands
 * - files:read
 * - files:write
 * - channels:history
 * - groups:history
 * - canvases:write
 * - (optional) canvases:read
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
// ---------- Slash command (informational) ----------
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
// ---------- Message Shortcut: primary trigger ----------
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
// ---------- Modal submission: create Canvas & notify ----------
bolt.view("collate_modal", async ({ ack, view, client, logger }) => {
    await ack();
    try {
        const meta = JSON.parse(view.private_metadata || "{}");
        const channel_id = meta.channel_id;
        const thread_ts = meta.thread_ts;
        const sel = (view.state.values.category_block.category_action.selected_option?.value ||
            "other");
        const category = sel;
        // 1) fetch replies in thread
        const replies = await client.conversations.replies({
            channel: channel_id,
            ts: thread_ts,
            limit: 200
        });
        const messages = replies.messages || [];
        // 2) collect pairs (Description -> Image)
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
        // 3) build markdown: Description first, then Image (with dividers)
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
        // 4) Create a canvas and attach it to this channel’s Canvas tab
        //    Passing channel_id here adds it as the channel canvas (Web API supports this). 
        //    Docs: canvases.create usage + channel_id. 
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
        const canvas_id = created.canvas_id;
        // 5) Post a message in the thread so it appears in the feed
        //    We can’t call share_canvas (not available in your workspace),
        //    so we notify the thread and tell users to open the Canvas tab.
        await client.chat.postMessage({
            channel: channel_id,
            thread_ts,
            text: `✅ Created a Canvas for *${category}*. Open the **Canvas** tab in this channel to view & edit. (Canvas ID: ${canvas_id})`
        });
    }
    catch (e) {
        (logger || console).error("modal submit error:", e?.data || e?.message || e);
    }
});
(async () => {
    await bolt.start(process.env.PORT || 3000);
    console.log("⚡ Collate-to-Canvas running");
})();
