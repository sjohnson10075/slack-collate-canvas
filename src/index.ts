import express from "express";
import crypto from "crypto";
import { App, ExpressReceiver } from "@slack/bolt";

/**
 * ENV REQUIRED (set in Render):
 * SLACK_BOT_TOKEN=xoxb-...
 * SLACK_SIGNING_SECRET=...
 */

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET as string,
  endpoints: "/slack/events" // endpoint must exist even if unused
});
const bolt = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  receiver
});

// ---------- Helpers ----------
type Pair = { caption: string; permalink: string };

function verifySlackSig(req: express.Request): boolean {
  const ts = req.headers["x-slack-request-timestamp"] as string;
  const sig = req.headers["x-slack-signature"] as string;
  if (!ts || !sig) return false;
  const fiveMinutes = 60 * 5;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(ts)) > fiveMinutes) return false;
  const body = (req as any).rawBody;
  const base = `v0:${ts}:${body}`;
  const hmac = crypto
    .createHmac("sha256", process.env.SLACK_SIGNING_SECRET as string)
    .update(base)
    .digest("hex");
  const expected = `v0=${hmac}`;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

// capture raw body for signature verification
const app = receiver.app as unknown as express.Express;
app.use("/slack", express.raw({ type: "*/*" }), (req, _res, next) => {
  (req as any).rawBody = (req as any).rawBody || (req as any).body?.toString?.() || req.body;
  next();
});

// ---------- Slash command: just educate users to use the shortcut ----------
app.post("/slack/commands", async (req, res) => {
  if (!verifySlackSig(req)) return res.status(401).send("bad sig");
  const payload = new URLSearchParams((req as any).rawBody);
  const command = payload.get("command");
  if (command !== "/collate") return res.send("");
  return res.json({
    response_type: "ephemeral",
    text:
      "Use the message shortcut *Collate thread to Canvas* on any message inside the thread that contains your images. " +
      "(Slash commands don’t carry thread context.)"
  });
});

// ---------- Message Shortcut: primary trigger ----------
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
    // log but avoid user-facing spam
    (logger || console).error("shortcut error:", e?.data || e?.message || e);
  }
});

// ---------- Modal submission: do the work ----------
bolt.view("collate_modal", async ({ ack, view, client, logger }) => {
  await ack();
  try {
    const meta = JSON.parse(view.private_metadata || "{}");
    const channel_id = meta.channel_id as string;
    const thread_ts = meta.thread_ts as string;

    const sel = (view.state.values.category_block.category_action.selected_option?.value || "other") as string;
    const category = sel;

    // 1) fetch replies in thread
    const replies = await client.conversations.replies({ channel: channel_id, ts: thread_ts, limit: 200 });
    const messages = replies.messages || [];

    // 2) collect pairs (Description -> Image)
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
        // Use generic API call to avoid missing TS types
        const info = (await client.apiCall("files.info", { file: f.id })) as any;
        const permalink = info.file?.permalink as string;
        if (!permalink) continue;
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

    // 3) build markdown: Description first, then Image
    const lines: string[] = [];
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

    // 4) create a Canvas with initial content (generic API call)
    const created = (await client.apiCall("canvases.create", {
      title: `Collated — ${category}`,
      document_content: { type: "markdown", markdown }
    })) as any;

    if (!created?.ok) {
      (logger || console).error("canvases.create failed:", created);
      await client.chat.postMessage({
        channel: channel_id,
        thread_ts,
        text: `⚠️ Canvas create failed.`
      });
      return;
    }

    const canvas_id = created.canvas_id as string;

    // 5) post the Canvas into the channel feed (generic API call)
    const share = (await client.apiCall("functions.execute", {
      function: "share_canvas",
      inputs: {
        canvas_id,
        channel_ids: [channel_id],
        message: `Collated **${pairs.length}** images for *${category}* (Description → Image). This Canvas stays editable in place.`
      }
    })) as any;

    if (!share?.ok) {
      (logger || console).error("functions.execute share_canvas failed:", share);
      await client.chat.postMessage({
        channel: channel_id,
        thread_ts,
        text: `⚠️ Share Canvas failed.`
      });
      return;
    }

    // 6) notify the thread
    await client.chat.postMessage({
      channel: channel_id,
      thread_ts,
      text: "✅ Canvas posted to the channel feed."
    });
  } catch (e: any) {
    (logger || console).error("modal submit error:", e?.data || e?.message || e);
  }
});

(async () => {
  await bolt.start(process.env.PORT || 3000);
  console.log("⚡ Collate-to-Canvas running");
})();