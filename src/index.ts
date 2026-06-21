import express from "express";
import crypto from "crypto";
import { App, ExpressReceiver } from "@slack/bolt";
import fetch from "node-fetch";
import sharp from "sharp";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import FormData from "form-data";

/**
 * ENV REQUIRED (Render):
 * - SLACK_BOT_TOKEN=xoxb-...
 * - SLACK_SIGNING_SECRET=...
 *
 * Optional:
 * - ADD_SPANISH=1              -> turn on Spanish translation
 * - DEEPL_API_KEY=...          -> DeepL API key (Free or Pro)
 *
 * Scopes used:
 * chat:write,
 * chat:write.public,
 * commands,
 * files:read,
 * files:write,
 * channels:history,
 * groups:history,
 * canvases:write,
 * canvases:read,
 * im:write
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

const PRINT_POST_FIELD_GID = "1215741454712160";
const PRINT_POST_YES_OPTION_GID = "1215741454712161";

const RELATED_CLIENT_FIELD_GID = "1212624226113795";

const CHANNEL_TO_CLIENT_OPTION_GID: Record<string, string> = {
  "C072737735W": "1212624226113796",
  "C072M81E3D0": "1212624226113797",
  "C0718P2BV1B": "1212624226113798",
  "C08SHAKU2AG": "1212665761384986",
  "C07398Y7NV8": "1212624226113799",
  "C07764XCAG7": "1212624898657908",
  "C072LBLJRM4": "1212624226113800",
  "C07AX3M0XPB": "1212665761385011",
  "C07469XC8SD": "1212624226113801",
  "C071Z06KCGK": "1212665761385036",
  "C09718DQF3J": "1212624226113802",
  "C0714S1LX7X": "1212624226113803",
  "C09N8SW3X5L": "1212665761385061",
  "C070XAT2GGK": "1212624226113804",
  "C07Q2KR4Y3B": "1212665761385086",
  "C07289MDP1Q": "1212624226113805",
  "C0723FG6AVB": "1212624226113806",
  "C0738TZ063D": "1212624226113807",
  "C09ARQNRZ3M": "1212665761385111",
  "C071DFJD2FQ": "1212624226113808",
  "C071LKDGAQL": "1212624226113809",
  "C071J6MBW8K": "1213061729527566",
  "C095CP47GJK": "1212665761385137",
  "C071JS64AE7": "1212624226113810",
  "C08PRAKNSGL": "1212665761385162",
  "C0797097V7S": "1212665761385187",
  "C071WDSTAQ0": "1212624226113811",
  "C07312JK2AJ": "1212624226113812",
  "C0724ULHE0Z": "1212624226113813",
  "C072LDKRELT": "1212624226113814",
  "C0764QWSDRN": "1212665761385212",
  "C0747TTMPLZ": "1212624226113815",
  "C09EXNHP9DM": "1212590718034692",
  "C072FQBLD4Y": "1212665761385237",
  "C072K0X24CR": "1212665060825725",
  "C09AV135Z6U": "1212665761385262",
  "C0725FA5QES": "1213062442858784",
  "C072HN0KZD3": "1213062442858785",
  "C0AB4LLB7QA": "1213062442858786",
  "C0AF4DXACR4": "1213292631078095",
  "C0AFMK5S5DJ": "1213397882208779",
  "C0AKLPYT9KM": "1213605224727606",
  "C0AN4HKRXEV": "1213740418137735",
  "C0AQH3ZM536": "1213903169605010",
  "C0AQT94MPM0": "1213914294991509",
  "C0ARSR9T1K5": "1213999263938327",
  "C0B45PWUTQV": "1215602158763208",
  "C0B9KGTB6JH": "1215602158763209",
  "C0899GVK30W": "1215639645557259",
  "C0AT0FXP54L": "1214079498509826"
};

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
  (req as any).rawBody =
    (req as any).rawBody || (req as any).body?.toString?.() || req.body;
  next();
});

// ---------- Slash command (info only) ----------
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

// === DeepL helper (Latin American Spanish, Free/Pro aware, with logging) ===
async function translateToEs(text: string): Promise<string> {
  try {
    const key = process.env.DEEPL_API_KEY;
    if (!key || !text?.trim()) return "";

    const target = (process.env.DEEPL_TARGET_LANG || "ES-419").trim();
    const base = (process.env.DEEPL_BASE_URL?.trim() || "https://api-free.deepl.com/v2").replace(/\/+$/, "");

    const params = new URLSearchParams();
    params.append("text", text);
    params.append("target_lang", target);
    params.append("model_type", "quality_optimized");

    const resp = await fetch(`${base}/translate`, {
      method: "POST",
      headers: {
        Authorization: `DeepL-Auth-Key ${key}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    } as any);

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.error("deepl error:", resp.status, resp.statusText, body);
      return "";
    }
    const data = await resp.json();
    const out = data?.translations?.[0]?.text || "";
    return typeof out === "string" ? out : "";
  } catch (e: any) {
    console.error("deepl exception:", e?.message || e);
    return "";
  }
}

type ExportPdfInput = {
  client: any;
  channel_id: string;
  root_ts: string;
  slackUser: string;
};

async function exportPdfFromThread(
  input: ExportPdfInput
): Promise<void> {
  const { channel_id, root_ts, slackUser } = input;
  const client = input.client;
  const botToken = process.env.SLACK_BOT_TOKEN as string;

  console.log("EXPORT PDF FUNCTION CALLED", {
    channel_id,
    root_ts
  });
  
  const replies = await client.conversations.replies({
  channel: channel_id,
  ts: root_ts,
  limit: 200
});

  const messages = replies.messages || [];
const rootText = findRootText(messages, root_ts);

console.log("THREAD ROOT TEXT", {
  rootText
});

  const niceTitle = shortTitle(rootText || "Export");

console.log("THREAD TITLE", {
  niceTitle
});

  const fileBase = sanitizeForFilename(
  rootText || `PrintExport_${new Date().toISOString().slice(0, 10)}`
);

console.log("FILE BASE", {
  fileBase
});

  const filename = `${fileBase}.pdf`;

console.log("PDF FILENAME", {
  filename
});

type Group = {
  caption: string;
  captionEs?: string;
  fileIds: string[];
};

const groups: Group[] = [];

for (const m of messages) {
  // Never include the root/header message
  if ((m as any).ts === root_ts) continue;

// Skip only this app's own status/output messages, not Slack Workflow messages
const text = ((m as any).text || "").trim();

if (
  (m as any).bot_id &&
  (
    text.includes("Auto Work Order triggered") ||
    text.includes("PDF generation completed") ||
    text.includes("Auto PDF failed")
  )
) {
  continue;
}

  const files = ((m as any).files as Array<any> | undefined) || [];

  const caption =
    (m as any).text?.trim() ||
    (files[0]?.initial_comment?.comment?.trim?.() ?? "") ||
    (files[0]?.title?.trim?.() ?? "");

  const fileIds: string[] = [];

  for (const f of files) {
    if (!/^image\//.test(f.mimetype || "")) continue;
    fileIds.push(f.id);
  }

  if (!caption && !fileIds.length) continue;

  let captionEs: string | undefined = undefined;

if (ADD_SPANISH && caption) {
  const res = await translateEs(caption);
  if (res.ok && res.es) captionEs = res.es;
}

groups.push({
  caption,
  captionEs,
  fileIds
});
}
  
console.log("GROUPS BUILT", {
  group_count: groups.length
});

if (!groups.length) {
  await client.chat.postMessage({
    channel: channel_id,
    thread_ts: root_ts,
    text: "No text or images found in this thread."
  });
  return;
}
  
// STEP 3: build PDF
  console.log("PDF BUILD STARTED");
  
  const pdf = await PDFDocument.create();
  pdf.setTitle(niceTitle);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const pageW = 612,
    pageH = 792;
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

  let page = addPageNoHeader();
  let y = pageH - margin;

  function sanitizePdfText(text: string): string {
  return (text || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
  
function wrapSimple(
  text: string,
  maxWidth: number,
  size: number,
  maxLines: number
): string[] {
  const words = (text || "").replace(/\r/g, "").split(/\s+/);
  const lines: string[] = [];
  let cur = "";

  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (fontBold.widthOfTextAtSize(test, size) <= maxWidth) {
      cur = test;
    } else {
      if (cur) {
        lines.push(cur);
        if (lines.length >= maxLines) break;
      }
      cur = w;
    }
  }

  if (cur && lines.length < maxLines) {
    lines.push(cur);
  }

  return lines.slice(0, maxLines);
}
  
  // Title once, top of first page, wrapped to page width
const titleLines = wrapSimple(sanitizePdfText(niceTitle), contentW, titleSize, 4);

let titleY = y - titleSize;
for (const line of titleLines) {
  page.drawText(line, {
    x: margin,
    y: titleY,
    size: titleSize,
    font: fontBold,
    color: rgb(0, 0, 0)
  });
  titleY -= titleSize + 4;
}

// extra spacing under wrapped title
y = titleY - 10;

  function ensureSpace(required: number) {
    if (y - required < margin) {
      page = addPageNoHeader();
      y = pageH - margin;
    }
  }

function wrapPreserveLines(
  text: string,
  maxWidth: number,
  size: number,
  maxLines: number
): string[] {
  const sourceLines = (text || "").replace(/\r/g, "").split("\n");
  const lines: string[] = [];

  for (const rawLine of sourceLines) {
    const line = rawLine ?? "";

    // Preserve intentionally blank lines
    if (!line.trim()) {
      lines.push("");
      if (lines.length >= maxLines) break;
      continue;
    }

    const words = line.split(/\s+/);
    let cur = "";

    for (const w of words) {
      const test = cur ? `${cur} ${w}` : w;
      if (font.widthOfTextAtSize(test, size) <= maxWidth) {
        cur = test;
      } else {
        if (cur) {
          lines.push(cur);
          if (lines.length >= maxLines) break;
        }
        cur = w;
      }
    }

    if (lines.length >= maxLines) break;

    if (cur) {
      lines.push(cur);
      if (lines.length >= maxLines) break;
    }
  }

  return lines.slice(0, maxLines);
}
  async function drawTile(
  x: number,
  topY: number,
  fileId: string
): Promise<number> {
  console.log("DRAW TILE STARTED", { fileId });
    
  const orig = await downloadOriginal(
    client,
    (process as any).env.SLACK_BOT_TOKEN as string,
    fileId
  );

console.log("DOWNLOAD RESULT", {
  fileId,
  success: !!orig,
  bytes: orig?.length || 0
});
    
  if (!orig) {
    page.drawText("[download failed]", {
      x,
      y: topY - lineH,
      size: captionSize,
      font,
      color: rgb(0.4, 0, 0)
    });
    return tileHMax;
  }

  try {
    let jpg: Buffer;

    try {
      // Original working pipeline
console.log("JPEG COMPRESS STARTED", { fileId });
jpg = await compressToJpeg(orig, 1800);
console.log("JPEG COMPRESS DONE", {
  fileId,
  bytes: jpg.length
});
      
    } catch {
      // Fallback for HEIC files Render cannot decode:
      // use Slack's generated preview image instead
      const preview = await downloadSlackPreview(
        client,
        (process as any).env.SLACK_BOT_TOKEN as string,
        fileId
      );

      if (!preview) throw new Error("No Slack preview available for unsupported image");

      jpg = await compressToJpeg(preview, 1800);
    }

    const img = await pdf.embedJpg(jpg);
    const iw = img.width,
      ih = img.height;
    const scale = Math.min(tileW / iw, tileHMax / ih);
    const w = iw * scale,
      h = ih * scale;

    page.drawImage(img, {
      x,
      y: topY - h,
      width: w,
      height: h
    });

    return h;
  } catch (err: any) {
    console.error("PDF image error:", err?.message || err);

    page.drawText("[image error]", {
      x,
      y: topY - lineH,
      size: captionSize,
      font,
      color: rgb(0.4, 0, 0)
    });

    return tileHMax;
  }
}

  // number + captions + Spanish + images
  for (let idx = 0; idx < groups.length; idx++) {
    const g = groups[idx];
    const num = idx + 1;

    const englishBlock = `${num}. ${g.caption || ""}`;
    const capLines = wrapPreserveLines(
  englishBlock,
  contentW,
  captionSize,
  maxCaptionLines
);
    const capHeight = capLines.length
      ? capLines.length * lineH + 2
      : 0;

    const esLines =
  ADD_SPANISH && g.captionEs
    ? wrapPreserveLines(
        g.captionEs,
        contentW,
        captionEsSize,
        maxCaptionEsLines
      )
    : [];
    const esHeight = esLines.length
      ? esLines.length * lineHes + 6
      : 0;

    const firstRow = g.fileIds.length ? tileHMax + 14 : 0;
    ensureSpace(capHeight + esHeight + firstRow);

    // English caption
    if (capHeight) {
      let yy = y - captionSize;
      for (const line of capLines) {
        page.drawText(sanitizePdfText(line), {
          x: margin,
          y: yy,
          size: captionSize,
          font,
          color: rgb(0, 0, 0)
        });
        yy -= lineH;
      }
      y = yy - 2;
    }

    // Spanish caption below
    if (esLines.length) {
      let yy = y - captionEsSize;
      for (const line of esLines) {
        page.drawText(sanitizePdfText(line), {
          x: margin,
          y: yy,
          size: captionEsSize,
          font,
          color: rgb(0.2, 0.2, 0.2)
        });
        yy -= lineHes;
      }
      y = yy - 6;
    }

    // draw images 2-up
    for (let i = 0; i < g.fileIds.length; i += 2) {
      ensureSpace(tileHMax + 14);

      const hLeft = await drawTile(margin, y, g.fileIds[i]);
      let hRight = 0;
      if (i + 1 < g.fileIds.length) {
        hRight = await drawTile(margin + (contentW - gutter) / 2 + gutter, y, g.fileIds[i + 1]);
        // NOTE: we changed x positioning here in earlier iterations; keeping consistent.
        // But to avoid drift, let's explicitly recompute tileW each loop:
      }

      const rowH = Math.max(hLeft, hRight);
      y -= rowH + 14;
    }

    y -= 10; // gap between groups
  }

  const pdfBytes = await pdf.save();
const bodyBuf = Buffer.from(pdfBytes);

console.log("AUTO PDF BYTES READY", {
  bytes: bodyBuf.length
});

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
  console.error("AUTO PDF UPLOAD FAILED", up2);
  throw new Error(up2?.error || "pdf_upload_failed");
}

const uploadedPdf = up2?.files?.[0]?.files?.[0];

console.log("AUTO PDF UPLOAD SUCCESS", {
  file_id: uploadedPdf?.id || null,
  permalink: uploadedPdf?.permalink || null,
  url_private_download: uploadedPdf?.url_private_download || null
});

console.log("ASANA CONFIG CHECK", {
  has_pat: !!process.env.ASANA_PAT,
  project_id: process.env.ASANA_WORK_ORDERS_PROJECT_ID || null
});

const taskGid = await createAsanaWorkOrderTask({
  taskName: niceTitle,
  pdfUrl: uploadedPdf?.permalink || "",
  channelId: channel_id,
  slackPermalink: null
});

console.log("ASANA TASK TEST SUCCESS", {
  taskGid
});

await addSlackSubmitterComment({
  taskGid,
  slackUser
});

await attachPdfToAsanaTask({
  taskGid,
  filename,
  pdfBuffer: bodyBuf
});

console.log("ASANA PDF ATTACH TEST SUCCESS", {
  taskGid
});
  
}

async function compressToJpeg(buf: Buffer, max: number): Promise<Buffer> {
  return await sharp(buf)
    .rotate()
    .resize({
      width: max,
      height: max,
      fit: "inside",
      withoutEnlargement: true
    })
    .jpeg({ quality: 72, chromaSubsampling: "4:2:0", mozjpeg: true })
    .toBuffer();
}

// --- Optional Spanish translation (DeepL) ---
const ADD_SPANISH = (process.env.ADD_SPANISH || "") === "1";
const DEEPL_API_KEY = process.env.DEEPL_API_KEY || "";

// Use the modern helper above (translateToEs) so we honor ES-419 and log errors.
async function translateEs(
  text: string
): Promise<{ ok: boolean; es: string }> {
  if (!ADD_SPANISH || !DEEPL_API_KEY) return { ok: false, es: "" };
  const t = (text || "").trim();
  if (!t) return { ok: true, es: "" };
  const es = await translateToEs(t);
  return es ? { ok: true, es } : { ok: false, es: "" };
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
// --- Slack file helpers (permalink + original download) ---
async function fetchFilePermalink(client: any, fileId: string): Promise<string | null> {
  try {
    const info = await client.apiCall("files.info", { file: fileId }) as any;
    return info?.file?.permalink || null;
  } catch {
    return null;
  }
}

async function downloadOriginal(client: any, botToken: string, fileId: string): Promise<Buffer | null> {
  try {
    const info = await client.apiCall("files.info", { file: fileId }) as any;
    const url: string | undefined = info?.file?.url_private_download || info?.file?.url_private;
    if (!url) return null;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${botToken}` } } as any);
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch {
    return null;
  }
}

async function downloadSlackPreview(client: any, botToken: string, fileId: string): Promise<Buffer | null> {
  try {
    const info = await client.apiCall("files.info", { file: fileId }) as any;
    const f = info?.file || {};

    const url: string | undefined =
      f.thumb_2048 ||
      f.thumb_1920 ||
      f.thumb_1600 ||
      f.thumb_1024 ||
      f.thumb_960 ||
      f.thumb_720 ||
      f.thumb_480 ||
      f.thumb_360;

    if (!url) return null;

    const res = await fetch(url, { headers: { Authorization: `Bearer ${botToken}` } } as any);
    if (!res.ok) return null;

    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch {
    return null;
  }
}

async function createAsanaWorkOrderTask(input: {
  taskName: string;
  pdfUrl: string;
  channelId: string;
  slackPermalink?: string | null;
}): Promise<string> {
  const asanaPat = process.env.ASANA_PAT;
  const projectGid = process.env.ASANA_WORK_ORDERS_PROJECT_ID;

  if (!asanaPat) throw new Error("Missing ASANA_PAT");
  if (!projectGid) throw new Error("Missing ASANA_WORK_ORDERS_PROJECT_ID");

  const customFields = {
  [PRINT_POST_FIELD_GID]: PRINT_POST_YES_OPTION_GID,

  ...(CHANNEL_TO_CLIENT_OPTION_GID[input.channelId]
    ? {
        [RELATED_CLIENT_FIELD_GID]:
          CHANNEL_TO_CLIENT_OPTION_GID[input.channelId]
      }
    : {})
};

console.log("CUSTOM FIELDS", customFields);
  
const resp = await fetch("https://app.asana.com/api/1.0/tasks", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${asanaPat}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    data: {
      name: input.taskName,
      projects: [projectGid],
      custom_fields: customFields,
      notes: [
        "Auto-generated from Slack Work Order thread.",
        input.slackPermalink ? `Slack thread: ${input.slackPermalink}` : "",
        `PDF: ${input.pdfUrl}`
      ].filter(Boolean).join("\n")
    }
  })
} as any);

  const data = await resp.json();

  console.log("ASANA TASK RESPONSE", JSON.stringify(data, null, 2));

  if (!resp.ok) {
    console.error("ASANA TASK CREATE FAILED", data);
    throw new Error(data?.errors?.[0]?.message || "asana_task_create_failed");
  }

  const taskGid = data?.data?.gid;
  console.log("ASANA TASK CREATED", { taskGid });

  return taskGid;
}

async function attachPdfToAsanaTask(input: {
  taskGid: string;
  filename: string;
  pdfBuffer: Buffer;
}): Promise<void> {
  const asanaPat = process.env.ASANA_PAT;
  if (!asanaPat) throw new Error("Missing ASANA_PAT");

  const form = new FormData();

form.append(
  "file",
  input.pdfBuffer,
  {
    filename: input.filename,
    contentType: "application/pdf"
  }
);

  const attachRes = await fetch(
  `https://app.asana.com/api/1.0/tasks/${input.taskGid}/attachments`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.ASANA_PAT}`
    },
    body: form as any
  } as any
);

if (!attachRes.ok) {
  const t = await attachRes.text();
  console.log("Asana attachment failed:", t);
  throw new Error(t);
} else {
  console.log("Attached:", input.filename);
  }
}

async function addSlackSubmitterComment(input: {
  taskGid: string;
  slackUser: string;
}): Promise<void> {
  try {
    await fetch(`https://app.asana.com/api/1.0/tasks/${input.taskGid}/stories`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.ASANA_PAT}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        data: {
          text: `Work Order submitted via Slack by ${input.slackUser}`
        }
      })
    } as any);

    console.log("ASANA SUBMITTER COMMENT ADDED", {
      taskGid: input.taskGid,
      slackUser: input.slackUser
    });
  } catch (e: any) {
    console.log("Failed to add Slack submitter comment:", e?.message || e);
  }
}

// =======================================================
// SHORTCUT A: Collate thread to Canvas
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
        private_metadata: JSON.stringify({
          channel_id,
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

    const replies = await client.conversations.replies({
      channel: channel_id,
      ts: thread_ts,
      limit: 200
    });
    const messages = replies.messages || [];

    const rootText = findRootText(messages, thread_ts);
    const canvasTitle = shortTitle(rootText || `Collated — ${category}`);

    type Group = {
      caption: string;
      captionEs?: string;
      filePermalinks: string[];
    };
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
        groups.push({
          caption,
          captionEs,
          filePermalinks: permaList
        });
      }
    }

    if (!groups.length) {
      await client.chat.postMessage({
        channel: channel_id,
        thread_ts,
        text: "I didn’t find any images in this thread."
      });
      return;
    }

    // Build Canvas markdown with numbering + Spanish below English
    const lines: string[] = [];
    lines.push(`# ${canvasTitle}`, "");
    groups.forEach((g, idx) => {
      const num = idx + 1;
      lines.push(`**${num}.** ${g.caption}`, "");
      if (ADD_SPANISH && g.captionEs) {
        lines.push(`*ES:* ${g.captionEs}`, "");
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
      text: `✅ Created a Canvas: *${canvasTitle}*. Open the **Canvas** tab in this channel to view & edit.`
    });
  } catch (e: any) {
    (logger || console).error("modal submit error:", e?.data || e?.message || e);
  }
});
// =======================================================
// EMOJI TRIGGER TEST
// =======================================================
bolt.event("reaction_added", async ({ event, client, logger }) => {
  try {
    const e = event as any;

    if (e.reaction !== "work-orders-bot") return;
    if (e.item?.type !== "message") return;

    const channel_id = e.item.channel;
    const message_ts = e.item.ts;
    let slackUser = e.user || "Unknown User";

try {
  const userInfo = await client.users.info({
    user: e.user
  });

  const profile = (userInfo as any)?.user?.profile || {};
  slackUser =
    profile.display_name ||
    profile.real_name ||
    (userInfo as any)?.user?.name ||
    e.user ||
    "Unknown User";
} catch (err: any) {
  console.log("Slack user lookup failed:", err?.data || err?.message || err);
}

    await client.chat.postMessage({
      channel: channel_id,
      thread_ts: message_ts,
      text: "✅ Auto Work Order triggered. Next step will be PDF generation."
    });

    console.log("WORKORDER AUTO EMOJI DETECTED", {
  channel_id,
  message_ts
});
    
    try {
  await exportPdfFromThread({
  client,
  channel_id,
  root_ts: message_ts,
  slackUser
});

  await client.chat.postMessage({
    channel: channel_id,
    thread_ts: message_ts,
    text: "✅ PDF generation completed."
  });
} catch (err: any) {
  console.error("AUTO PDF FAILED", err?.data || err?.message || err);

  await client.chat.postMessage({
    channel: channel_id,
    thread_ts: message_ts,
    text: `⚠️ Auto PDF failed: ${err?.message || "unknown error"}`
  });
}
    
  } catch (err: any) {
    (logger || console).error(
      "workorder_auto error:",
      err?.data || err?.message || err
    );
  }
});
// =======================================================
// SHORTCUT B: Export thread as PDF
// =======================================================
bolt.shortcut("export_pdf", async ({ ack, shortcut, client, logger }) => {
  await ack();
  const botToken = process.env.SLACK_BOT_TOKEN as string;
  const { channel, message_ts, thread_ts } = shortcut as any;
  const root_ts = thread_ts || message_ts;
const channel_id = channel.id as string;

console.log("PDF EXPORT STARTED", {
  channel_id,
  root_ts
});

  // progress message
  const startMsg = await client.chat.postMessage({
    channel: channel_id,
    thread_ts: root_ts,
    text: "Step 0/4: Starting export…"
  });
  const progress_ts = (startMsg as any).ts as string;

  // STEP 1: get replies
  await client.chat.update({
    channel: channel_id,
    ts: progress_ts,
    text: "Step 1/4: Reading thread…"
  });
  const replies = await client.conversations.replies({
    channel: channel_id,
    ts: root_ts,
    limit: 200
  });
  const messages = replies.messages || [];

  const rootText = findRootText(messages, root_ts);
  const niceTitle = shortTitle(rootText || "Export");
  const fileBase = sanitizeForFilename(
    rootText || `PrintExport_${new Date().toISOString().slice(0, 10)}`
  );
  const filename = `${fileBase}.pdf`;

  // STEP 2: group by message
  await client.chat.update({
    channel: channel_id,
    ts: progress_ts,
    text: "Step 2/4: Grouping images by message…"
  });
  type Group = {
    caption: string;
    captionEs?: string;
    fileIds: string[];
  };
  const groups: Group[] = [];

  for (const m of messages) {
  // Never include the root/header message
  if ((m as any).ts === root_ts) continue;

  // Never include this bot's own progress/status messages
  if ((m as any).ts === progress_ts) continue;
  if ((m as any).bot_id) continue;

  const files = ((m as any).files as Array<any> | undefined) || [];

  const caption =
    (m as any).text?.trim() ||
    (files[0]?.initial_comment?.comment?.trim?.() ?? "") ||
    (files[0]?.title?.trim?.() ?? "");

  const fileIds: string[] = [];
  for (const f of files) {
    if (!/^image\//.test(f.mimetype || "")) continue;
    fileIds.push(f.id);
  }

  // Skip only if the reply has neither usable text nor images
  if (!caption && !fileIds.length) continue;

  let captionEs: string | undefined = undefined;
  if (ADD_SPANISH && caption) {
    const res = await translateEs(caption);
    if (res.ok && res.es) captionEs = res.es;
  }

  groups.push({
    caption,
    captionEs,
    fileIds
  });
}

  if (!groups.length) {
    await client.chat.update({
      channel: channel_id,
      ts: progress_ts,
      text: "No text or images found in this thread."
    });
    return;
  }

  // STEP 3: build PDF
  const pdf = await PDFDocument.create();
  pdf.setTitle(niceTitle);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const pageW = 612,
    pageH = 792;
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

  let page = addPageNoHeader();
  let y = pageH - margin;

  function sanitizePdfText(text: string): string {
  return (text || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
  
function wrapSimple(
  text: string,
  maxWidth: number,
  size: number,
  maxLines: number
): string[] {
  const words = (text || "").replace(/\r/g, "").split(/\s+/);
  const lines: string[] = [];
  let cur = "";

  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (fontBold.widthOfTextAtSize(test, size) <= maxWidth) {
      cur = test;
    } else {
      if (cur) {
        lines.push(cur);
        if (lines.length >= maxLines) break;
      }
      cur = w;
    }
  }

  if (cur && lines.length < maxLines) {
    lines.push(cur);
  }

  return lines.slice(0, maxLines);
}
  
  // Title once, top of first page, wrapped to page width
const titleLines = wrapSimple(sanitizePdfText(niceTitle), contentW, titleSize, 4);

let titleY = y - titleSize;
for (const line of titleLines) {
  page.drawText(line, {
    x: margin,
    y: titleY,
    size: titleSize,
    font: fontBold,
    color: rgb(0, 0, 0)
  });
  titleY -= titleSize + 4;
}

// extra spacing under wrapped title
y = titleY - 10;

  function ensureSpace(required: number) {
    if (y - required < margin) {
      page = addPageNoHeader();
      y = pageH - margin;
    }
  }

function wrapPreserveLines(
  text: string,
  maxWidth: number,
  size: number,
  maxLines: number
): string[] {
  const sourceLines = (text || "").replace(/\r/g, "").split("\n");
  const lines: string[] = [];

  for (const rawLine of sourceLines) {
    const line = rawLine ?? "";

    // Preserve intentionally blank lines
    if (!line.trim()) {
      lines.push("");
      if (lines.length >= maxLines) break;
      continue;
    }

    const words = line.split(/\s+/);
    let cur = "";

    for (const w of words) {
      const test = cur ? `${cur} ${w}` : w;
      if (font.widthOfTextAtSize(test, size) <= maxWidth) {
        cur = test;
      } else {
        if (cur) {
          lines.push(cur);
          if (lines.length >= maxLines) break;
        }
        cur = w;
      }
    }

    if (lines.length >= maxLines) break;

    if (cur) {
      lines.push(cur);
      if (lines.length >= maxLines) break;
    }
  }

  return lines.slice(0, maxLines);
}
  async function drawTile(
  x: number,
  topY: number,
  fileId: string
): Promise<number> {
  const orig = await downloadOriginal(
    client,
    (process as any).env.SLACK_BOT_TOKEN as string,
    fileId
  );

  if (!orig) {
    page.drawText("[download failed]", {
      x,
      y: topY - lineH,
      size: captionSize,
      font,
      color: rgb(0.4, 0, 0)
    });
    return tileHMax;
  }

  try {
    let jpg: Buffer;

    try {
      // Original working pipeline
      jpg = await compressToJpeg(orig, 1800);
    } catch {
      // Fallback for HEIC files Render cannot decode:
      // use Slack's generated preview image instead
      const preview = await downloadSlackPreview(
        client,
        (process as any).env.SLACK_BOT_TOKEN as string,
        fileId
      );

      if (!preview) throw new Error("No Slack preview available for unsupported image");

      jpg = await compressToJpeg(preview, 1800);
    }

    const img = await pdf.embedJpg(jpg);
    const iw = img.width,
      ih = img.height;
    const scale = Math.min(tileW / iw, tileHMax / ih);
    const w = iw * scale,
      h = ih * scale;

    page.drawImage(img, {
      x,
      y: topY - h,
      width: w,
      height: h
    });

    return h;
  } catch (err: any) {
    console.error("PDF image error:", err?.message || err);

    page.drawText("[image error]", {
      x,
      y: topY - lineH,
      size: captionSize,
      font,
      color: rgb(0.4, 0, 0)
    });

    return tileHMax;
  }
}

  // number + captions + Spanish + images
  for (let idx = 0; idx < groups.length; idx++) {
    const g = groups[idx];
    const num = idx + 1;

    const englishBlock = `${num}. ${g.caption || ""}`;
    const capLines = wrapPreserveLines(
  englishBlock,
  contentW,
  captionSize,
  maxCaptionLines
);
    const capHeight = capLines.length
      ? capLines.length * lineH + 2
      : 0;

    const esLines =
  ADD_SPANISH && g.captionEs
    ? wrapPreserveLines(
        g.captionEs,
        contentW,
        captionEsSize,
        maxCaptionEsLines
      )
    : [];
    const esHeight = esLines.length
      ? esLines.length * lineHes + 6
      : 0;

    const firstRow = g.fileIds.length ? tileHMax + 14 : 0;
    ensureSpace(capHeight + esHeight + firstRow);

    // English caption
    if (capHeight) {
      let yy = y - captionSize;
      for (const line of capLines) {
        page.drawText(sanitizePdfText(line), {
          x: margin,
          y: yy,
          size: captionSize,
          font,
          color: rgb(0, 0, 0)
        });
        yy -= lineH;
      }
      y = yy - 2;
    }

    // Spanish caption below
    if (esLines.length) {
      let yy = y - captionEsSize;
      for (const line of esLines) {
        page.drawText(sanitizePdfText(line), {
          x: margin,
          y: yy,
          size: captionEsSize,
          font,
          color: rgb(0.2, 0.2, 0.2)
        });
        yy -= lineHes;
      }
      y = yy - 6;
    }

    // draw images 2-up
    for (let i = 0; i < g.fileIds.length; i += 2) {
      ensureSpace(tileHMax + 14);

      const hLeft = await drawTile(margin, y, g.fileIds[i]);
      let hRight = 0;
      if (i + 1 < g.fileIds.length) {
        hRight = await drawTile(margin + (contentW - gutter) / 2 + gutter, y, g.fileIds[i + 1]);
        // NOTE: we changed x positioning here in earlier iterations; keeping consistent.
        // But to avoid drift, let's explicitly recompute tileW each loop:
      }

      const rowH = Math.max(hLeft, hRight);
      y -= rowH + 14;
    }

    y -= 10; // gap between groups
  }

  const pdfBytes = await pdf.save();
  const bodyBuf = Buffer.from(pdfBytes);

  // STEP 4: upload via files.uploadV2

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
    return;
}
});

// =======================================================
// SHORTCUT C: FOLLOW-UP REMINDER
// (Clutter-reduced version: keep Jump back link, DROP the manual quoted line)
// =======================================================

// --- Time helpers (America/Los_Angeles) ---
function toPST(dateUTC: Date): Date {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  const partsArr = fmt.formatToParts(dateUTC) as Array<{
    type: string;
    value: string;
  }>;
  const parts: Record<string, string> = {};
  for (const p of partsArr) {
    parts[p.type] = p.value;
  }
  const y = parts.year || "1970";
  const m = parts.month || "01";
  const d = parts.day || "01";
  const hh = parts.hour || "00";
  const mm = parts.minute || "00";
  const ss = parts.second || "00";

  return new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}.000-08:00`);
}

function addBusinessDaysPST(startUTC: Date, days: number): Date {
  let d = toPST(startUTC);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay(); // 0=Sun,6=Sat
    if (dow !== 0 && dow !== 6) {
      added++;
    }
  }
  return d;
}

function upcomingFridayAt4pmPST(fromUTC: Date): Date {
  let d = toPST(fromUTC);
  const dow = d.getDay(); // 0=Sun..6=Sat
  const daysToFri = (5 - dow + 7) % 7;
  d.setDate(d.getDate() + daysToFri);
  d.setHours(16, 0, 0, 0); // 4 PM
  return d;
}

// detect first mentioned user ID in @mention format
function firstMentionUserId(text: string): string | null {
  const m = (text || "").match(/<@([UW][A-Z0-9]+)>/i);
  return m ? m[1] : null;
}

// Shortcut handler: open the reminder modal
bolt.shortcut("follow_up_reminder", async ({ ack, shortcut, client }) => {
  await ack();

  const { channel, message_ts, thread_ts, message } = shortcut as any;
  const channel_id = channel.id as string;
  const origin_text = (message?.text || "").toString();
  const thread_ts_value = thread_ts || ""; // "" = top-level message

  await client.views.open({
    trigger_id: (shortcut as any).trigger_id,
    view: {
      type: "modal",
      callback_id: "follow_up_submit",
      private_metadata: JSON.stringify({
        channel_id,
        message_ts,
        thread_ts: thread_ts_value,
        origin_text
      }),
      title: { type: "plain_text", text: "Follow-up reminder" },
      submit: { type: "plain_text", text: "Set reminder" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "When should I remind you *if you haven’t heard back?*"
          }
        },
        {
          type: "input",
          block_id: "when_block",
          label: { type: "plain_text", text: "Choose one" },
          element: {
            type: "radio_buttons",
            action_id: "when_choice",
            options: [
              {
                text: { type: "plain_text", text: "1 minute (test)" },
                value: "1min"
              },
              {
                text: { type: "plain_text", text: "30 minutes" },
                value: "30m"
              },
              {
                text: { type: "plain_text", text: "1 hour" },
                value: "1h"
              },
              {
                text: { type: "plain_text", text: "3 hours" },
                value: "3h"
              },
              {
                text: { type: "plain_text", text: "1 business day" },
                value: "1bd"
              },
              {
                text: { type: "plain_text", text: "2 business days" },
                value: "2bd"
              },
              {
                text: { type: "plain_text", text: "End of week (Fri 4:00 PM)" },
                value: "eow"
              }
            ],
            initial_option: {
              text: { type: "plain_text", text: "1 minute (test)" },
              value: "1min"
            }
          }
        }
      ]
    }
  });
});

// Modal submit: schedule reminder in channel/thread + ephemeral confirm
// THIS VERSION:
// - Keeps Jump back link w/permalink
// - DROPS our own manual copy of the message text
//   (Slack will still insert its gray preview card so you still see the message.)
bolt.view("follow_up_submit", async ({ ack, view, client, body }) => {
  await ack();

  try {
    const meta = JSON.parse(view.private_metadata || "{}");
    const channel_id = meta.channel_id as string;
    const message_ts = meta.message_ts as string;
    const origin_text = (meta.origin_text || "") as string;
    const thread_ts_val = (meta.thread_ts || "") as string; // "" if not in thread

    const requester_user_id = (body?.user?.id || "") as string;

    const choice =
      view.state.values?.when_block?.when_choice?.selected_option?.value ||
      "1min";

    // 1. compute when to send
    let post_at: number;
    const nowSec = Math.floor(Date.now() / 1000);

    if (choice === "1min") {
      post_at = nowSec + 60;
    } else if (choice === "30m") {
      post_at = nowSec + 30 * 60;
    } else if (choice === "1h") {
      post_at = nowSec + 60 * 60;
    } else if (choice === "3h") {
      post_at = nowSec + 3 * 60 * 60;
    } else if (choice === "2bd" || choice === "eow" || choice === "1bd") {
      const nowUTC = new Date();
      let targetLocal: Date;
      if (choice === "2bd") {
        targetLocal = addBusinessDaysPST(nowUTC, 2);
        targetLocal.setHours(
          nowUTC.getHours(),
          nowUTC.getMinutes(),
          0,
          0
        );
      } else if (choice === "eow") {
        targetLocal = upcomingFridayAt4pmPST(nowUTC);
      } else {
        // 1bd
        targetLocal = addBusinessDaysPST(nowUTC, 1);
        targetLocal.setHours(
          nowUTC.getHours(),
          nowUTC.getMinutes(),
          0,
          0
        );
      }
      post_at = Math.floor(targetLocal.getTime() / 1000);
      if (post_at < nowSec + 60) {
        post_at = nowSec + 60;
      }
    } else {
      post_at = nowSec + 60;
    }

    // 2. permalink to original message
    let permalink: string | null = null;
    try {
      const pl = await client.chat.getPermalink({
        channel: channel_id,
        message_ts
      });
      if ((pl as any).ok) {
        permalink = (pl as any).permalink as string;
      }
    } catch {
      /* ignore */
    }

    // 3. who did they @mention?
    const mentioned = firstMentionUserId(origin_text);

    // 4. Build the text that will be scheduled later.
    //    DO NOT include our own `> original_text`
    //    DO include Jump back link (Slack will still unfurl a gray card with the message)
    const futureLines: string[] = [];
    futureLines.push(
      `⏰ <@${requester_user_id}>, follow-up check${
        mentioned ? ` on <@${mentioned}>` : ""
      }.`
    );

    if (permalink) {
      // Slack link format <url|label>
      futureLines.push(
        `Jump back: <${permalink}|original message>`
      );
    }

    futureLines.push(
      "_If they've already handled it, you can ignore this._"
    );

    // 5. Schedule message in SAME CHANNEL.
    const scheduleArgs: any = {
      channel: channel_id,
      post_at,
      text: futureLines.join("\n"),
      unfurl_links: false,
      unfurl_media: false
    };
    if (thread_ts_val) {
      scheduleArgs.thread_ts = message_ts;
    }

    await client.chat.scheduleMessage(scheduleArgs);

    // 6. Ephemeral confirmation right now
    const humanReadableMap: Record<string, string> = {
      "1min": "in ~1 minute",
      "30m": "in 30 minutes",
      "1h": "in 1 hour",
      "3h": "in 3 hours",
      "1bd": "in 1 business day",
      "2bd": "in 2 business days",
      "eow": "at end of week (Fri 4pm)"
    };
    const humanReadable =
      humanReadableMap[choice] || "soon";

    let ephemeralWorked = false;
    try {
      const ephemeralArgs: any = {
        channel: channel_id,
        user: requester_user_id,
        text: `⏰ I’ll remind you ${humanReadable} in this thread.`
      };
      if (thread_ts_val) {
        ephemeralArgs.thread_ts = message_ts;
      }
      await client.chat.postEphemeral(ephemeralArgs);
      ephemeralWorked = true;
    } catch (err: any) {
      console.error(
        "ephemeral confirm failed:",
        err?.data || err?.message || err
      );
      ephemeralWorked = false;
    }

    console.log(
      "follow_up_submit scheduled OK for",
      requester_user_id,
      "post_at",
      post_at,
      "choice",
      choice,
      "ephemeralWorked=",
      ephemeralWorked,
      "thread_ts_val=",
      thread_ts_val ? "thread" : "channel_top_level"
    );
  } catch (e: any) {
    console.error("follow_up_submit error:", e?.data || e?.message || e);
  }
});

// -------------------------------------------------------
(async () => {
  await bolt.start(process.env.PORT || 3000);
  console.log(
    "⚡ Collate-to-Canvas running | Spanish",
    ADD_SPANISH ? "ON" : "OFF",
    "| Key",
    DEEPL_API_KEY ? "present" : "absent"
  );
})();
