/**
 * ZDT API - Main Entry Point
 * 
 * Fastify-basierter Backend Server für die ZDT AI-Assistenten-Plattform.
 * 
 * Features:
 * - Chat Endpoint (SSE Streaming)
 * - Email-Drafting mit n8n Integration
 * - Canvas Content Generierung (GLM-5)
 * - Speech-to-Text Proxy (ASR)
 * - Text-to-Speech (Piper)
 * 
 * Architecture:
 * - In-Memory Conversation State
 * - Intent-basiertes Routing
 * - Server-Sent Events für Streaming
 */

// ============================================================================
// IMPORTS
// ============================================================================

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
import { generateCanvasContent, isCanvasIntent } from "./canvas-api";

// ============================================================================
// SERVER SETUP
// ============================================================================

const fastify = Fastify({ logger: true });

// CORS - Alle Origins erlaubt (für Entwicklung)
await fastify.register(cors, { origin: true });

// Multipart - Für Audio Uploads (ASR)
await fastify.register(multipart, {
  limits: {
    fileSize: 50 * 1024 * 1024,  // 50MB max
    files: 1,
  },
});

const PORT = Number(process.env.PORT ?? 8080);

// ============================================================================
// CONFIGURATION
// ============================================================================

/** Ollama LLM Endpoint */
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";

/** Default Modell für Chat */
const DEFAULT_MODEL = process.env.OLLAMA_MODEL ?? "qwen3.5:9b";

/** ASR Service (FastAPI Whisper) */
const ASR_URL = process.env.ASR_URL ?? "http://127.0.0.1:9002/transcribe";
const ASR_FIELD = process.env.ASR_FIELD ?? "file";

/** TTS (Piper) */
const PIPER_BIN = process.env.PIPER_BIN ?? "/usr/bin/piper-tts";
const PIPER_MODEL = process.env.PIPER_MODEL ?? "";
const PIPER_CONFIG = process.env.PIPER_CONFIG ?? "";

/** n8n Email Webhook */
const N8N_EMAIL_WEBHOOK_URL = process.env.N8N_EMAIL_WEBHOOK_URL ?? "";
const N8N_EMAIL_KEY = process.env.N8N_EMAIL_KEY ?? "";

// ============================================================================
// TYPES
// ============================================================================

type Role = "user" | "assistant" | "system";

/** Chat Message */
type Msg = { 
  role: Role; 
  content: string; 
  createdAt: number 
};

/** Email Draft Status */
type MailStatus = "idle" | "editing" | "confirm_send" | "sent" | "error";

/** Email Draft State */
type MailDraft = { 
  to: string; 
  subject: string; 
  message: string; 
  status: MailStatus; 
  lastError?: string 
};

/** Conversation State - In-Memory */
type ConvState = { 
  history: Msg[];              // Chat-Historie
  mail: MailDraft;             // Email-Entwurf
  lastCanvasQuery?: string;    // Letzter Canvas-Titel (für Follow-ups)
  lastCanvasHtml?: string;     // Letztes Canvas-HTML (für Bearbeitungen)
};

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

/** In-Memory Conversation Storage */
const conversations = new Map<string, ConvState>();

/**
 * Generiert eine neue UUID für Conversations.
 */
function newId(): string {
  return crypto.randomUUID();
}

/**
 * Holt oder erstellt Conversation State.
 * 
 * @param id - Conversation UUID
 * @returns Existierender oder neuer State
 */
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

// ============================================================================
// SSE HELPERS
// ============================================================================

/**
 * Sendet ein Server-Sent Event.
 * 
 * @param reply - Fastify Reply Object
 * @param event - Event Name (token, mail, canvas, final, error)
 * @param data - Event Payload
 */
function sse(reply: any, event: string, data: any): void {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Streamt eine Antwort Wort für Wort und sendet final Event.
 * 
 * @param reply - Fastify Reply Object
 * @param conversationId - Conversation UUID
 * @param speak - Zu sprechender Text
 */
function streamSpeak(reply: any, conversationId: string, speak: string): void {
  // Token-weises Streaming (by words/spaces)
  const parts = speak.split(/(\s+)/).filter((p) => p.length > 0);
  for (const p of parts) sse(reply, "token", { token: p });
  
  // Abschluss
  sse(reply, "final", { conversationId, text: speak });
  reply.raw.end();
}

// ============================================================================
// INTENT DETECTION
// ============================================================================

/**
 * Erkennt Email-Modus Start.
 * 
 * Trigger:
 * - "lass uns eine email schreiben"
 * - "email entwerfen"
 * - "mail verfassen"
 * 
 * @param text - User-Nachricht
 * @returns true wenn Email-Intent erkannt
 */
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

/**
 * Erkennt Sende-Intent.
 * 
 * @param text - User-Nachricht
 * @returns true wenn Senden gewünscht
 */
function isSendIntent(text: string): boolean {
  const t = text.toLowerCase();
  return (
    (t.includes("sende") || t.includes("versend") || t.includes("verschick")) &&
    (t.includes("mail") || t.includes("email") || t.includes("e-mail"))
  );
}

/**
 * Erkennt "Ja" Antwort.
 */
function isYes(text: string): boolean {
  const t = text.toLowerCase().trim();
  return t === "ja" || t === "j" || t.startsWith("ja ");
}

/**
 * Erkennt "Nein" Antwort.
 */
function isNo(text: string): boolean {
  const t = text.toLowerCase().trim();
  return t === "nein" || t === "n" || t.startsWith("nein ");
}

// ============================================================================
// OLLAMA HELPERS
// ============================================================================

/**
 * Ruft Ollama auf und extrahiert JSON aus der Response.
 * 
 * @param model - Modell Name
 * @param messages - Chat Messages
 * @returns Geparstes JSON Object
 */
async function callOllamaOnceJson(
  model: string, 
  messages: { role: Role; content: string }[]
): Promise<any> {
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

  // Robuste JSON-Extraktion (Modell könnte additional Text hinzufügen)
  const a = content.indexOf("{");
  const b = content.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error(`Invalid JSON from model: ${content.slice(0, 500)}`);

  return JSON.parse(content.slice(a, b + 1));
}

// ============================================================================
// EMAIL SENDING
// ============================================================================

/**
 * Sendet Email über n8n Webhook.
 * 
 * @param d - Email Draft
 * @throws Error bei fehlender Konfiguration oder Sendefehler
 */
async function sendEmailViaN8n(d: MailDraft): Promise<void> {
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

// ============================================================================
// ROUTES
// ============================================================================

/**
 * Health Check Endpoint
 */
fastify.get("/zdt/api/health", async () => ({ ok: true }));

// ============================================================================
// CHAT ENDPOINT (SSE)
// ============================================================================

/**
 * Hauptendpoint für Chat, Email-Drafting und Canvas Content.
 * 
 * Nutzt Server-Sent Events (SSE) für Streaming.
 * 
 * Intent Routing:
 * 1. Email Mode (wenn mail.status !== "idle" oder Email-Intent erkannt)
 * 2. Canvas Mode (wenn isCanvasIntent true)
 * 3. Normal Chat (Streaming über Ollama)
 */
fastify.post("/zdt/api/chat", async (req, reply) => {
  // Request Validation
  const Body = z.object({
    conversationId: z.preprocess((v) => (v === null ? undefined : v), z.string().uuid().optional()),
    message: z.string().min(1),
    inputMode: z.enum(["voice", "text"]).default("text"),
    model: z.string().optional(),
  });

  const body = Body.parse(req.body);
  const conversationId = body.conversationId ?? newId();
  const st = getState(conversationId);

  // SSE Headers
  reply
    .header("Content-Type", "text/event-stream; charset=utf-8")
    .header("Cache-Control", "no-cache, no-transform")
    .header("Connection", "keep-alive")
    .header("X-Conversation-Id", conversationId);

  const userText = body.message;
  const model = body.model ?? DEFAULT_MODEL;

  // ========================================
  // EMAIL MODE ENTRY
  // ========================================
  if (st.mail.status === "idle" && isEmailIntentStart(userText)) {
    st.mail = { to: "", subject: "", message: "", status: "editing" };
    sse(reply, "mail", st.mail);

    const speak = "Alles klar. Wir erstellen eine E-Mail. An wen soll sie gehen, welcher Betreff, und was ist die Kernaussage?";

    st.history.push({ role: "user", content: userText, createdAt: Date.now() });
    st.history.push({ role: "assistant", content: speak, createdAt: Date.now() });

    streamSpeak(reply, conversationId, speak);
    return;
  }

  // ========================================
  // EMAIL MODE HANDLING
  // ========================================
  if (st.mail.status !== "idle") {
    st.history.push({ role: "user", content: userText, createdAt: Date.now() });

    // --- Confirmation Flow ---
    if (st.mail.status === "confirm_send") {
      if (isYes(userText)) {
        // Senden bestätigt
        try {
          await sendEmailViaN8n(st.mail);
          
          // Reset nach erfolgreichem Versand
          st.mail = { to: "", subject: "", message: "", status: "idle", lastError: undefined };
          sse(reply, "mail", st.mail);

          const speak = "E-Mail erfolgreich gesendet. Was möchtest du als nächstes tun?";
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
        // Abbrechen, zurück zum Editieren
        st.mail.status = "editing";
        sse(reply, "mail", st.mail);

        const speak = "Okay, nicht senden. Was soll ich am Entwurf ändern?";
        st.history.push({ role: "assistant", content: speak, createdAt: Date.now() });
        streamSpeak(reply, conversationId, speak);
        return;
      }

      // Unklare Antwort
      const speak = "Bitte bestätige: Soll ich die E-Mail wirklich senden? Antworte mit Ja oder Nein.";
      st.history.push({ role: "assistant", content: speak, createdAt: Date.now() });
      streamSpeak(reply, conversationId, speak);
      return;
    }

    // --- Email Draft Update via LLM ---
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

      // Expliziter Sende-Intent
      if (isSendIntent(userText)) st.mail.status = "confirm_send";

      sse(reply, "mail", st.mail);

      st.history.push({ role: "assistant", content: speak, createdAt: Date.now() });
      streamSpeak(reply, conversationId, speak);
      return;
    } catch (e: any) {
      st.mail.status = "error";
      st.mail.lastError = e?.message ?? String(e);
      sse(reply, "mail", st.mail);

      const speak = "Ich konnte den Entwurf gerade nicht aktualisieren. Sag mir bitte kurz: Empfänger, Betreff oder was genau soll in die Nachricht?";
      st.history.push({ role: "assistant", content: speak, createdAt: Date.now() });
      streamSpeak(reply, conversationId, speak);
      return;
    }
  }

  // ========================================
  // CANVAS CONTENT (GLM-5)
  // ========================================
  if (isCanvasIntent(userText)) {
    st.history.push({ role: "user", content: userText, createdAt: Date.now() });
    
    try {
      const canvasResult = await generateCanvasContent(userText, st.lastCanvasQuery, st.lastCanvasHtml);
      
      if (canvasResult && canvasResult.html) {
        // Speichere für Follow-ups
        st.lastCanvasQuery = canvasResult.title.toLowerCase();
        st.lastCanvasHtml = canvasResult.html;
        
        sse(reply, "canvas", canvasResult);
        
        const speak = "Ich habe den Inhalt im rechten Panel erstellt.";
        st.history.push({ role: "assistant", content: speak, createdAt: Date.now() });
        streamSpeak(reply, conversationId, speak);
        return;
      }
    } catch (e: any) {
      fastify.log.error(e, "Canvas generation failed");
    }
    
    // Fallback: Continue with normal chat
  }

  // ========================================
  // NORMAL CHAT (OLLAMA STREAMING)
  // ========================================
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

      // Parse Zeile für Zeile
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

// ============================================================================
// ASR ENDPOINT (PROXY)
// ============================================================================

/**
 * Speech-to-Text Proxy.
 * 
 * Leitet Audio-Uploads an externen ASR-Service (z.B. Whisper) weiter.
 */
fastify.post("/zdt/api/asr", async (req, reply) => {
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
  fd.append(ASR_FIELD, new Blob([buf as any], { type: mime }), filename);

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

// ============================================================================
// TTS ENDPOINT (PIPER)
// ============================================================================

/**
 * Text-to-Speech mit Piper.
 * 
 * Generiert WAV Audio aus Text.
 */
fastify.post("/zdt/api/tts", async (req, reply) => {
  const Body = z.object({ text: z.string().min(1) });
  const { text } = Body.parse(req.body);

  if (!PIPER_MODEL || !PIPER_CONFIG) {
    reply.code(500).send({
      error: "Piper TTS not configured",
      hint: "Set PIPER_MODEL and PIPER_CONFIG in apps/api/.env",
    });
    return;
  }

  // Prüfe ob Model/Config existieren
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

  // Temp Output File
  const id = crypto.randomUUID();
  const outPath = path.join(tmpdir(), `tts_${id}.wav`);
  const args = ["-m", PIPER_MODEL, "-c", PIPER_CONFIG, "-f", outPath];

  req.log.info({ PIPER_BIN, args }, "TTS piper-tts spawn");

  // Piper Process
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

// ============================================================================
// SERVER START
// ============================================================================

fastify.listen({ port: PORT, host: "0.0.0.0" }).catch((err) => {
  fastify.log.error(err);
  process.exit(1);
});
