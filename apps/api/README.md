# ZDT API

Fastify-basiertes Backend für die ZDT AI-Assistenten-Plattform.

## 📁 Struktur

```
apps/api/src/
├── index.ts          # Main Entry Point & API Routes
├── canvas-api.ts     # GLM-5 Canvas Content Generierung
│
├── core/             # Core Module (geplant für Refactoring)
│   ├── config.ts
│   ├── http.ts
│   └── validation.ts
│
└── modules/          # Feature Module (geplant für Refactoring)
    ├── auth/
    ├── chat/
    ├── conversations/
    ├── rag/
    └── tools/
```

## 🔌 Endpoints

### `GET /api/health`

Health Check.

**Response:**
```json
{"ok": true}
```

---

### `POST /api/chat`

Hauptendpoint für Chat, Email-Drafting und Canvas Content.
Verwendet Server-Sent Events (SSE) für Streaming.

**Request Body:**
```typescript
{
  conversationId?: string;  // UUID, wird auto-generiert falls fehlend
  message: string;          // User-Nachricht
  inputMode?: "voice" | "text";  // Default: "text"
  model?: string;           // Default: "qwen3.5:9b"
}
```

**SSE Events:**

| Event | Data | Beschreibung |
|-------|------|--------------|
| `token` | `{token: string}` | Einzelne Chat-Tokens |
| `mail` | `EmailDraft` | Email-Entwurf Update |
| `canvas` | `{title, html}` | Canvas HTML Content |
| `final` | `{conversationId, text}` | Abschluss der Antwort |
| `error` | `{message, status}` | Fehlermeldung |

---

### `POST /api/asr`

Speech-to-Text Proxy zu externem ASR-Service.

**Request:** `multipart/form-data`
- Field: `file` (Audio-Datei)

**Response:**
```json
{"text": "Erkannter Text"}
```

**Konfiguration:**
```env
ASR_URL=http://127.0.0.1:9002/transcribe
ASR_FIELD=file
```

---

### `POST /api/tts`

Text-to-Speech mit Piper.

**Request:**
```json
{"text": "Zu sprechender Text"}
```

**Response:** `audio/wav` Binary

**Konfiguration:**
```env
PIPER_BIN=/usr/bin/piper-tts
PIPER_MODEL=/path/to/model.onnx
PIPER_CONFIG=/path/to/model.onnx.json
```

## 🧠 Intent Detection

Der Chat-Endpoint erkennt automatisch drei Modi:

### 1. Email Mode

Trigger:
- "Lass uns eine Email schreiben"
- "Email entwerfen"
- Wenn `mail.status !== "idle"`

Flow:
```
idle → editing → confirm_send → idle (nach Send)
```

### 2. Canvas Mode

Trigger:
- "Zeige mir [Bild-Kategorie]"
- "Erstelle ein Diagramm"
- "Füge X hinzu" (Bearbeitung)

Handler: `canvas-api.ts`

### 3. Normal Chat

Default - Streaming über Ollama.

## 📊 Conversation State

In-Memory Storage pro Session:

```typescript
type ConvState = {
  history: Msg[];              // Chat-Historie
  mail: MailDraft;             // Email-Entwurf
  lastCanvasQuery?: string;    // Letzter Canvas-Titel
  lastCanvasHtml?: string;     // Letztes Canvas-HTML
};

type Msg = {
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: number;
};

type MailDraft = {
  to: string;
  subject: string;
  message: string;
  status: "idle" | "editing" | "confirm_send" | "sent" | "error";
  lastError?: string;
};
```

## 🔧 Konfiguration

### Erforderlich

```env
# Ollama (Pflicht)
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3.5:9b

# GLM-5 Canvas API (Pflicht für Canvas)
GLM5_API_KEY=your-api-key
```

### Optional

```env
# Email-Versand (n8n Webhook)
N8N_EMAIL_WEBHOOK_URL=https://webhook-url
N8N_EMAIL_KEY=secret-key

# TTS (Piper)
PIPER_BIN=/usr/bin/piper-tts
PIPER_MODEL=/path/to/model.onnx
PIPER_CONFIG=/path/to/model.onnx.json

# ASR
ASR_URL=http://127.0.0.1:9002/transcribe
ASR_FIELD=file
```

## 🚀 Entwicklung

```bash
# Dev Server starten
pnpm dev

# TypeScript prüfen
npx tsc --noEmit

# Mit anderer Ollama-URL
OLLAMA_URL=http://192.168.1.100:11434 pnpm dev
```

## 📝 Code-Übersicht

### index.ts

Main Entry Point mit:
- Fastify Server Setup
- CORS & Multipart Config
- Conversation State Management
- Chat/ASR/TTS Routes
- Intent Detection & Routing

### canvas-api.ts

Canvas Content Generierung:
- **Bildersuche** via LoremFlickr
- **HTML-Generierung** via GLM-5
- **Bearbeitungs-Modus** für Follow-ups
- **Intent Detection** für Canvas-Requests

Key Functions:
```typescript
// Prüft ob Request für Canvas gedacht ist
export function isCanvasIntent(text: string): boolean

// Generiert Canvas Content
export async function generateCanvasContent(
  userRequest: string,
  lastCanvasQuery?: string,
  lastCanvasHtml?: string
): Promise<CanvasResult | null>
```

### core/ & modules/ (Geplant)

Strukturierte Architektur für zukünftiges Refactoring:

```
core/
  config.ts       - Zentrale Konfiguration
  http.ts         - HTTP Utilities
  validation.ts   - Zod Schemas

modules/
  auth/           - Auth Middleware
  chat/           - Chat Controller & Ollama Client
  conversations/  - Conversation Storage
  rag/            - RAG Service (Retrieval Augmented Generation)
  tools/          - Tool Executor Registry
```

## ⚠️ Bekannte Limitierungen

- **In-Memory Storage** - Sessions gehen bei Restart verloren
- **Keine Auth** - Jeder kann jeden Endpoint nutzen
- **Keine Rate Limits** - Offen für Abuse

## 🔒 Security

- API Key für GLM-5 im Code (sollte in .env)
- N8N Email Key via Environment Variable
- Keine Input-Sanitization außer bei Canvas HTML

---

*Für Gesamtübersicht siehe: `../../README.md`*
