import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { z } from "zod";
import "dotenv/config";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

const fastify = Fastify({ logger: true });

await fastify.register(cors, { origin: true });

await fastify.register(multipart, {
  limits: {
    fileSize: 50 * 1024 * 1024,
    files: 1,
  },
});

const PORT = Number(process.env.PORT ?? 8080);

// Ollama
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const DEFAULT_MODEL = process.env.OLLAMA_MODEL ?? "llama3.1:8b";

// ASR (FastAPI)
const ASR_URL = process.env.ASR_URL ?? "http://127.0.0.1:9002/transcribe";
const ASR_FIELD = process.env.ASR_FIELD ?? "file";

// TTS (piper-tts)
const PIPER_BIN = process.env.PIPER_BIN ?? "/usr/bin/piper-tts";
const PIPER_MODEL = process.env.PIPER_MODEL ?? "";
const PIPER_CONFIG = process.env.PIPER_CONFIG ?? "";

// n8n Mail
const N8N_EMAIL_WEBHOOK_URL = process.env.N8N_EMAIL_WEBHOOK_URL ?? "";
const N8N_EMAIL_KEY = process.env.N8N_EMAIL_KEY ?? "";

// --- In-Memory Conversations ---
type Role = "user" | "assistant" | "system";
type Msg = { role: Role; content: string; createdAt: number };

type MailStatus = "idle" | "editing" | "confirm_send" | "sent" | "error";
type MailDraft = { to: string; subject: string; message: string; status: MailStatus; lastError?: string };

type ConvState = { history: Msg[]; mail: MailDraft };
const conversations = new Map<string, ConvState>();

function newId() {
  return crypto.randomUUID();
}

function getState(id: string): ConvState {
  const st = conversations.get(id);
  if (st) return st;
  const fresh: ConvState = {
    history: [],
    mail: { to: "", subject: "", message: "", status: "idle" },
  };
  conversations.set(id, fresh);
  return fresh;
}

function sse(reply: any, event: string, data: any) {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function streamSpeak(reply: any, conversationId: string, speak: string) {
  // stream by words/spaces
  const parts = speak.split(/(\s+)/).filter((p) => p.length > 0);
  for (const p of parts) sse(reply, "token", { token: p });
  sse(reply, "final", { conversationId, text: speak });
  reply.raw.end();
}

function isEmailIntentStart(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes("lass uns eine email") ||
    t.includes("lass uns eine e-mail") ||
    (t.includes("email") && (t.includes("schreib") || t.includes("verfass") || t.includes("entwurf"))) ||
    (t.includes("e-mail") && (t.includes("schreib") || t.includes("verfass") || t.includes("entwurf"))) ||
    (t.includes("mail") && (t.includes("schreib") || t.includes("verfass") || t.includes("entwurf")))
  );
}

function isSendIntent(text: string): boolean {
  const t = text.toLowerCase();
  return (
    (t.includes("sende") || t.includes("versend") || t.includes("verschick")) &&
    (t.includes("mail") || t.includes("email") || t.includes("e-mail"))
  );
}

function isYes(text: string): boolean {
  const t = text.toLowerCase().trim();
  return t === "ja" || t === "j" || t.startsWith("ja ");
}

function isNo(text: string): boolean {
  const t = text.toLowerCase().trim();
  return t === "nein" || t === "n" || t.startsWith("nein ");
}

async function callOllamaOnceJson(model: string, messages: { role: Role; content: string }[]) {
  const payload = { model, stream: false, messages };
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Ollama failed: ${res.status} ${t.slice(0, 500)}`);
  }
  const json = await res.json();
  const content = String(json?.message?.content ?? "");

  // robust JSON extraction (model might add stray text)
  const a = content.indexOf("{");
  const b = content.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error(`Invalid JSON from model: ${content.slice(0, 500)}`);

  return JSON.parse(content.slice(a, b + 1));
}

async function sendEmailViaN8n(d: MailDraft) {
  if (!N8N_EMAIL_WEBHOOK_URL || !N8N_EMAIL_KEY) {
    throw new Error("n8n not configured: N8N_EMAIL_WEBHOOK_URL / N8N_EMAIL_KEY missing");
  }
  const res = await fetch(N8N_EMAIL_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ZDT-AI-Key": N8N_EMAIL_KEY,
    },
    body: JSON.stringify({ to: d.to, subject: d.subject, message: d.message }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`n8n send failed: ${res.status} ${t.slice(0, 500)}`);
  }
}

fastify.get("/api/health", async () => ({ ok: true }));

// ---------- CHAT (SSE) ----------
fastify.post("/api/chat", async (req, reply) => {
  const Body = z.object({
    conversationId: z.preprocess((v) => (v === null ? undefined : v), z.string().uuid().optional()),
    message: z.string().min(1),
    inputMode: z.enum(["voice", "text"]).default("text"),
    model: z.string().optional(),
  });

  const body = Body.parse(req.body);
  const conversationId = body.conversationId ?? newId();
  const st = getState(conversationId);

  reply
    .header("Content-Type", "text/event-stream; charset=utf-8")
    .header("Cache-Control", "no-cache, no-transform")
    .header("Connection", "keep-alive")
    .header("X-Conversation-Id", conversationId);

  const userText = body.message;
  const model = body.model ?? DEFAULT_MODEL;

  // ---- Email mode entry ----
  if (st.mail.status === "idle" && isEmailIntentStart(userText)) {
    st.mail = { to: "", subject: "", message: "", status: "editing" };
    sse(reply, "mail", st.mail);

    const speak =
      "Alles klar. Wir erstellen eine E-Mail. An wen soll sie gehen, welcher Betreff, und was ist die Kernaussage?";

    st.history.push({ role: "user", content: userText, createdAt: Date.now() });
    st.history.push({ role: "assistant", content: speak, createdAt: Date.now() });

    streamSpeak(reply, conversationId, speak);
    return;
  }

  // ---- Email mode handling ----
  if (st.mail.status !== "idle") {
    st.history.push({ role: "user", content: userText, createdAt: Date.now() });

    // confirmation flow
    if (st.mail.status === "confirm_send") {
      if (isYes(userText)) {
        try {
          await sendEmailViaN8n(st.mail);
          st.mail.status = "sent";
          st.mail.lastError = undefined;
          sse(reply, "mail", st.mail);

          const speak = "Gesendet. Möchtest du noch etwas an einer weiteren E-Mail machen?";
          st.history.push({ role: "assistant", content: speak, createdAt: Date.now() });
          streamSpeak(reply, conversationId, speak);
          return;
        } catch (e: any) {
          st.mail.status = "error";
          st.mail.lastError = e?.message ?? String(e);
          sse(reply, "mail", st.mail);

          const speak = "Senden fehlgeschlagen. Ich bleibe im Entwurf. Soll ich es nochmal versuchen?";
          st.history.push({ role: "assistant", content: speak, createdAt: Date.now() });
          streamSpeak(reply, conversationId, speak);
          return;
        }
      }

      if (isNo(userText)) {
        st.mail.status = "editing";
        sse(reply, "mail", st.mail);

        const speak = "Okay, nicht senden. Was soll ich am Entwurf ändern?";
        st.history.push({ role: "assistant", content: speak, createdAt: Date.now() });
        streamSpeak(reply, conversationId, speak);
        return;
      }

      const speak = "Bitte bestätige: Soll ich die E-Mail wirklich senden? Antworte mit „Ja“ oder „Nein“.";
      st.history.push({ role: "assistant", content: speak, createdAt: Date.now() });
      streamSpeak(reply, conversationId, speak);
      return;
    }

    // single JSON call (speak + mail state)
    const system = [
      "You are an email drafting controller embedded in a voice/chat assistant UI.",
      "You must maintain ONE email draft: {to, subject, message}.",
      "The UI shows the draft in a separate canvas; do NOT output the email message in the chat.",
      "Return STRICT JSON ONLY (no markdown, no extra text).",
      'Schema: { "speak": string, "mail": { "to": string, "subject": string, "message": string, "status": "editing"|"confirm_send" }, "action": "none"|"ask_missing"|"confirm_send" }',
      "Rules:",
      "- 'speak' is short conversational output.",
      "- Always keep mail fields as the single source of truth.",
      "- If user intends to send and all fields exist -> set status 'confirm_send' and ask for confirmation in speak.",
      "- If user provides recipient/subject/content, update fields accordingly.",
      "- If something is missing, ask targeted question in speak and keep status 'editing'.",
    ].join("\n");

    const user = ["CURRENT_MAIL:", JSON.stringify(st.mail), "", "USER_INPUT:", userText].join("\n");

    try {
      const obj = await callOllamaOnceJson(model, [
        { role: "system", content: system },
        { role: "user", content: user },
      ]);

      const speak = String(obj?.speak ?? "Okay. Was soll ich am Entwurf ändern?");

      const mail = obj?.mail ?? {};
      const nextStatus = (mail?.status as MailStatus) ?? "editing";

      st.mail.to = String(mail?.to ?? st.mail.to ?? "");
      st.mail.subject = String(mail?.subject ?? st.mail.subject ?? "");
      st.mail.message = String(mail?.message ?? st.mail.message ?? "");
      st.mail.status = nextStatus === "confirm_send" ? "confirm_send" : "editing";
      st.mail.lastError = undefined;

      // explicit send intent forces confirm_send
      if (isSendIntent(userText)) st.mail.status = "confirm_send";

      sse(reply, "mail", st.mail);

      st.history.push({ role: "assistant", content: speak, createdAt: Date.now() });
      streamSpeak(reply, conversationId, speak);
      return;
    } catch (e: any) {
      st.mail.status = "error";
      st.mail.lastError = e?.message ?? String(e);
      sse(reply, "mail", st.mail);

      const speak =
        "Ich konnte den Entwurf gerade nicht aktualisieren. Sag mir bitte kurz: Empfänger, Betreff oder was genau soll in die Nachricht?";
      st.history.push({ role: "assistant", content: speak, createdAt: Date.now() });
      streamSpeak(reply, conversationId, speak);
      return;
    }
  }

  // ---- Normal chat (Ollama streaming) ----
  st.history.push({ role: "user", content: userText, createdAt: Date.now() });

  const payload = {
    model,
    stream: true,
    messages: st.history.map((m) => ({ role: m.role, content: m.content })),
  };

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok || !res.body) {
    req.log.error({ status: res.status }, "Ollama request failed");
    sse(reply, "error", { message: "Ollama request failed", status: res.status });
    reply.raw.end();
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let assistantText = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx === -1) break;

        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);

        if (!line) continue;

        const obj = JSON.parse(line);
        const token = obj?.message?.content ?? "";

        if (token) {
          assistantText += token;
          sse(reply, "token", { token });
        }

        if (obj?.done) {
          st.history.push({ role: "assistant", content: assistantText, createdAt: Date.now() });
          sse(reply, "final", { conversationId, text: assistantText });
          reply.raw.end();
          return;
        }
      }
    }
  } catch (e: any) {
    req.log.error(e, "stream error");
    sse(reply, "error", { message: "stream error" });
    reply.raw.end();
  }
});

// ---------- ASR (Proxy) ----------
fastify.post("/api/asr", async (req, reply) => {
  const file = await (req as any).file();
  if (!file) {
    reply.code(400).send({ error: "No file uploaded (expected field 'file')." });
    return;
  }

  const buf: Buffer = await file.toBuffer();
  const mime = file.mimetype || "application/octet-stream";
  const filename = file.filename || "audio.bin";

  req.log.info({ mime, filename, size: buf.length, ASR_URL, ASR_FIELD }, "ASR upload");

  const fd = new FormData();
  fd.append(ASR_FIELD, new Blob([buf], { type: mime }), filename);

  let res: Response;
  try {
    res = await fetch(ASR_URL, { method: "POST", body: fd as any });
  } catch (e: any) {
    req.log.error(e, "ASR fetch failed");
    reply.code(502).send({
      error: "ASR service unreachable",
      detail: e?.message ?? String(e),
      asrUrl: ASR_URL,
    });
    return;
  }

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    req.log.error({ status: res.status, body: t?.slice(0, 2000) }, "ASR service failed");
    reply.code(502).send({
      error: "ASR service failed",
      status: res.status,
      detail: t,
      asrUrl: ASR_URL,
    });
    return;
  }

  try {
    const json = await res.json();
    if (typeof json === "string") {
      reply.send({ text: json });
    } else if (json && typeof json.text === "string") {
      reply.send({ text: json.text });
    } else {
      reply.send(json);
    }
  } catch {
    const text = await res.text().catch(() => "");
    reply.send({ text });
  }
});

// ---------- TTS (piper-tts) ----------
fastify.post("/api/tts", async (req, reply) => {
  const Body = z.object({ text: z.string().min(1) });
  const { text } = Body.parse(req.body);

  if (!PIPER_MODEL || !PIPER_CONFIG) {
    reply.code(500).send({
      error: "Piper TTS not configured",
      hint: "Set PIPER_MODEL and PIPER_CONFIG in apps/api/.env",
    });
    return;
  }

  const [modelOk, configOk] = await Promise.all([
    fs.access(PIPER_MODEL).then(() => true).catch(() => false),
    fs.access(PIPER_CONFIG).then(() => true).catch(() => false),
  ]);

  if (!modelOk || !configOk) {
    reply.code(500).send({
      error: "Piper model/config not found",
      model: PIPER_MODEL,
      config: PIPER_CONFIG,
    });
    return;
  }

  const id = crypto.randomUUID();
  const outPath = path.join(tmpdir(), `tts_${id}.wav`);
  const args = ["-m", PIPER_MODEL, "-c", PIPER_CONFIG, "-f", outPath];

  req.log.info({ PIPER_BIN, args }, "TTS piper-tts spawn");

  const p = spawn(PIPER_BIN, args, { stdio: ["pipe", "ignore", "pipe"] });

  let err = "";
  p.stderr.on("data", (d) => (err += d.toString()));

  p.stdin.write(text);
  p.stdin.end();

  const code: number = await new Promise((resolve) => p.on("close", resolve));

  if (code !== 0) {
    await fs.rm(outPath, { force: true }).catch(() => {});
    reply.code(500).send({
      error: "Piper TTS failed",
      code,
      detail: err.slice(0, 2000),
    });
    return;
  }

  const wav = await fs.readFile(outPath);
  await fs.rm(outPath, { force: true }).catch(() => {});

  reply.header("Content-Type", "audio/wav");
  reply.send(wav);
});

fastify.listen({ port: PORT, host: "0.0.0.0" }).catch((err) => {
  fastify.log.error(err);
  process.exit(1);
});