# ZDT - AI Assistant Platform

Eine multimodale AI-Assistenten-Plattform mit Chat, Email-Drafting, Content-Generierung und Sprachsteuerung.

## 🎯 Features

- **Chat-Interface** - Streaming-Chat mit Ollama (Qwen3.5:9b)
- **Email-Drafting** - Natürliche Sprache zu Email-Entwürfen
- **Canvas Content** - HTML-Generierung via GLM-5 (Diagramme, Tabellen, Karten)
- **Bildersuche** - Automatische Bildsuche via LoremFlickr
- **Sprachsteuerung** - ASR (Spracheingabe) + TTS (Sprachausgabe)
- **White Mode UI** - Optimiert für Beamer-Präsentationen

## 📁 Projektstruktur

```
zdt/
├── apps/
│   ├── api/          # Fastify Backend (Port 8080)
│   │   └── src/
│   │       ├── index.ts       # Main API Server
│   │       ├── canvas-api.ts  # GLM-5 Canvas Generierung
│   │       ├── core/          # Core Module (geplant)
│   │       └── modules/       # Feature Module (geplant)
│   │
│   ├── web/          # React Frontend (Port 5173)
│   │   └── src/
│   │       ├── App.tsx        # Main App Component
│   │       └── App.css        # White Mode Styling
│   │
│   └── asr/          # ASR Service (Python, optional)
│
├── data/             # Datenverzeichnis
├── packages/         # Shared Packages (geplant)
└── infra/            # Infrastructure Config
```

## 🚀 Quick Start

### Voraussetzungen

- Node.js 18+
- pnpm (`npm install -g pnpm`)
- Ollama mit Qwen3.5:9b (`ollama pull qwen3.5:9b`)

### Installation

```bash
# Dependencies installieren
pnpm install

# API starten
cd apps/api && pnpm dev

# Web starten (neues Terminal)
cd apps/web && pnpm dev
```

### Zugriff

- **Web:** http://localhost:5173/
- **API Health:** http://localhost:8080/api/health

## ⚙️ Konfiguration

### API (apps/api/.env)

```env
# Ollama
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3.5:9b

# GLM-5 Canvas API
GLM5_API_KEY=your-api-key

# Email (n8n Webhook)
N8N_EMAIL_WEBHOOK_URL=https://your-n8n.com/webhook
N8N_EMAIL_KEY=your-secret-key

# TTS (Piper)
PIPER_BIN=/usr/bin/piper-tts
PIPER_MODEL=/path/to/model.onnx
PIPER_CONFIG=/path/to/model.onnx.json

# ASR
ASR_URL=http://127.0.0.1:9002/transcribe
```

### Web (apps/web/vite.config.ts)

- Proxy zu API konfiguriert unter `/api`
- Base Path: `/zdt/` (optional für Subpath-Deployment)

## 🎨 Verwendung

### Chat

Normale Konversation mit dem AI-Assistenten:

```
User: "Wie spät ist es?"
AI: "Es ist 15:30 Uhr."
```

### Email erstellen

```
User: "Lass uns eine Email schreiben"
AI: "An wen soll sie gehen, welcher Betreff..."
User: "An max@example.com, Betreff: Meeting, Nachricht: ..."
AI: "Soll ich die Email senden?"
User: "Ja"
```

### Canvas Content (Bilder, Diagramme, etc.)

```
User: "Zeige mir eine Katze"
AI: [Zeigt Katzenbild im rechten Panel]

User: "Erstelle ein Balkendiagramm mit A=10, B=20, C=30"
AI: [Zeigt Diagramm]

User: "Füge D=7 hinzu"
AI: [Aktualisiert Diagramm mit neuem Balken]
```

## 🏗️ Architektur

### Backend (apps/api)

```
┌─────────────────────────────────────────────────┐
│                   Fastify Server                 │
├─────────────────────────────────────────────────┤
│  /api/chat    │ Chat + Email + Canvas (SSE)     │
│  /api/asr     │ Speech-to-Text Proxy            │
│  /api/tts     │ Text-to-Speech (Piper)          │
│  /api/health  │ Health Check                    │
├─────────────────────────────────────────────────┤
│              In-Memory Conversation State        │
│  - history: Message[]                           │
│  - mail: EmailDraft                             │
│  - lastCanvasQuery: string                      │
│  - lastCanvasHtml: string                       │
└─────────────────────────────────────────────────┘
```

### Frontend (apps/web)

```
┌─────────────────────────────────────────────────┐
│                   React App                      │
├──────────────────────┬──────────────────────────┤
│   Sidebar (420px)    │   Content Panel (flex)   │
│  ┌────────────────┐  │  ┌────────────────────┐  │
│  │   Controls     │  │  │                    │  │
│  ├────────────────┤  │  │   EmailCanvas      │  │
│  │   Chat List    │  │  │   or HtmlCanvas    │  │
│  ├────────────────┤  │  │   or Placeholder   │  │
│  │   Composer     │  │  │                    │  │
│  └────────────────┘  │  └────────────────────┘  │
└──────────────────────┴──────────────────────────┘
```

### Data Flow

```
User Input → Intent Detection → Handler
                                  │
                 ┌────────────────┼────────────────┐
                 ▼                ▼                ▼
            Email Mode      Canvas Mode      Normal Chat
                 │                │                │
                 ▼                ▼                ▼
            Ollama JSON     GLM-5 HTML       Ollama Stream
                 │                │                │
                 └────────────────┴────────────────┘
                                  │
                                  ▼
                           SSE Events
                        (token/mail/canvas)
                                  │
                                  ▼
                            Frontend UI
```

## 🔧 Entwicklung

### Commands

```bash
# TypeScript prüfen
cd apps/api && npx tsc --noEmit
cd apps/web && npx tsc --noEmit

# Build (Production)
cd apps/web && npx vite build
```

### Code Style

- TypeScript mit strikten Typen
- Inline-Kommentare für komplexe Logik
- SSE für Streaming-Responses
- CSS in separaten Dateien (kein Tailwind)

## 📝 API Reference

### POST /api/chat

Streaming Chat Endpoint (Server-Sent Events).

**Request:**
```json
{
  "conversationId": "uuid-optional",
  "message": "User message",
  "inputMode": "text|voice",
  "model": "qwen3.5:9b"
}
```

**Response (SSE Events):**
```
event: token
data: {"token": "Ich"}

event: mail
data: {"to": "...", "subject": "...", "message": "...", "status": "editing"}

event: canvas
data: {"title": "Diagramm", "html": "<div>...</div>"}

event: final
data: {"conversationId": "...", "text": "Full response"}
```

### POST /api/asr

Speech-to-Text Proxy.

**Request:** `multipart/form-data` mit Audio-File

**Response:**
```json
{"text": "Transkribierter Text"}
```

### POST /api/tts

Text-to-Speech mit Piper.

**Request:**
```json
{"text": "Zu sprechender Text"}
```

**Response:** `audio/wav`

## 🤝 Beitragen

1. Fork erstellen
2. Feature Branch (`git checkout -b feature/amazing`)
3. Committen (`git commit -m 'Add amazing'`)
4. Push (`git push origin feature/amazing`)
5. Pull Request öffnen

## 📄 Lizenz

MIT

---

*Erstellt für wissenschaftliche Präsentationen mit Beamer-optimierter UI.*
