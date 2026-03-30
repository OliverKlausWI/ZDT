<div align="center">

# ZDT - AI Assistant Platform

**Eine multimodale AI-Assistenten-Plattform mit Chat, Email-Drafting, Content-Generierung und Sprachsteuerung**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-18+-61DAFB?logo=react&logoColor=black)](https://reactjs.org/)
[![Fastify](https://img.shields.io/badge/Fastify-5+-000000?logo=fastify&logoColor=white)](https://fastify.dev/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

</div>

---

## ✨ Features

| Feature | Beschreibung |
|---------|--------------|
| 💬 **Chat-Interface** | Streaming-Chat mit Ollama (Qwen3.5:9b) |
| 📧 **Email-Drafting** | Natürliche Sprache zu Email-Entwürfen |
| 🎨 **Canvas Content** | HTML-Generierung via GLM-5 (Diagramme, Tabellen, Karten) |
| 🖼️ **Bildersuche** | Automatische Bildsuche via LoremFlickr |
| 🎤 **Sprachsteuerung** | ASR (Spracheingabe) + TTS (Sprachausgabe) |
| 🖥️ **White Mode UI** | Optimiert für Beamer-Präsentationen |

---

## 📁 Projektstruktur

```
zdt/
├── apps/
│   ├── api/              # Fastify Backend (Port 8080)
│   │   └── src/
│   │       ├── index.ts       # Main API Server
│   │       └── canvas-api.ts  # GLM-5 Canvas Generierung
│   │
│   └── web/              # React Frontend (Port 5173)
│       └── src/
│           ├── App.tsx        # Main App Component
│           └── App.css        # White Mode Styling
│
└── infra/                # Infrastructure Config
    ├── caddy/            # Caddy Reverse Proxy
    └── docker-compose.yml
```

---

## 🚀 Quick Start

### Voraussetzungen

| Requirement | Version | Installation |
|-------------|---------|--------------|
| Node.js | 18+ | [nodejs.org](https://nodejs.org/) |
| pnpm | latest | `npm install -g pnpm` |
| Ollama | latest | [ollama.ai](https://ollama.ai/) |

### 1. Ollama Modell laden

```bash
ollama pull qwen3.5:9b
```

### 2. Dependencies installieren

```bash
pnpm install
```

### 3. Services starten

```bash
# Terminal 1 - API
cd apps/api && pnpm dev

# Terminal 2 - Web
cd apps/web && pnpm dev
```

### 4. Öffnen

- **Web:** http://localhost:5173/zdt/
- **API Health:** http://localhost:8080/zdt/api/health

---

## ⚙️ Konfiguration

### Environment Variables

Erstelle `apps/api/.env`:

```env
# Ollama LLM
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3.5:9b

# GLM-5 Canvas API
GLM5_API_KEY=your-api-key

# Email (n8n Webhook)
N8N_EMAIL_WEBHOOK_URL=https://your-n8n.com/webhook
N8N_EMAIL_KEY=your-secret-key

# TTS (Chatterbox)
TTS_URL=http://192.168.100.64:8004/tts
TTS_VOICE=Emily.wav

# ASR (Whisper)
ASR_URL=http://192.168.100.64:9002/transcribe
```

### Externe Services

| Service | Port | Beschreibung |
|---------|------|--------------|
| ASR (Whisper) | 9002 | Spracheingabe via faster-whisper |
| TTS (Chatterbox) | 8004 | Sprachausgabe via Chatterbox TTS |

---

## 🎨 Verwendung

### Chat

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

### Canvas Content

```
User: "Zeige mir eine Katze"
AI: [Zeigt Katzenbild im rechten Panel]

User: "Erstelle ein Balkendiagramm mit A=10, B=20, C=30"
AI: [Zeigt Diagramm]

User: "Füge D=7 hinzu"
AI: [Aktualisiert Diagramm]
```

---

## 🏗️ Architektur

### Backend

```
┌─────────────────────────────────────────────────┐
│                   Fastify Server                 │
│                    Port 8080                     │
├─────────────────────────────────────────────────┤
│  /zdt/api/chat    │ Chat + Email + Canvas (SSE) │
│  /zdt/api/asr     │ Speech-to-Text Proxy        │
│  /zdt/api/tts     │ Text-to-Speech              │
│  /zdt/api/health  │ Health Check                │
├─────────────────────────────────────────────────┤
│            In-Memory Conversation State          │
└─────────────────────────────────────────────────┘
```

### Frontend

```
┌─────────────────────────────────────────────────┐
│                   React App                      │
├──────────────────────┬──────────────────────────┤
│   Sidebar (420px)    │   Content Panel (flex)   │
│  ┌────────────────┐  │  ┌────────────────────┐  │
│  │   Controls     │  │  │   EmailCanvas      │  │
│  ├────────────────┤  │  │   or HtmlCanvas    │  │
│  │   Chat List    │  │  │   or Placeholder   │  │
│  ├────────────────┤  │  │                    │  │
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
```

---

## 📝 API Reference

### POST /zdt/api/chat

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

**SSE Events:**

| Event | Data | Description |
|-------|------|-------------|
| `token` | `{ token: "word" }` | Streaming token |
| `mail` | `{ to, subject, message, status }` | Email draft update |
| `canvas` | `{ title, html }` | Canvas content |
| `final` | `{ conversationId, text }` | End of response |
| `error` | `{ message, status }` | Error occurred |

### POST /zdt/api/asr

Speech-to-Text Proxy.

**Request:** `multipart/form-data` mit Audio-File

**Response:**
```json
{ "text": "Transkribierter Text" }
```

### POST /zdt/api/tts

Text-to-Speech.

**Request:**
```json
{ "text": "Zu sprechender Text" }
```

**Response:** `audio/wav`

---

## 🔧 Entwicklung

```bash
# TypeScript prüfen
cd apps/api && npx tsc --noEmit
cd apps/web && npx tsc --noEmit

# Build (Production)
cd apps/web && npx vite build
```

### Code Style

- TypeScript mit strikten Typen
- JSDoc-Kommentare für alle Funktionen
- SSE für Streaming-Responses
- CSS in separaten Dateien

---

## 🤝 Beitragen

1. Fork erstellen
2. Feature Branch (`git checkout -b feature/amazing`)
3. Committen (`git commit -m 'Add amazing'`)
4. Push (`git push origin feature/amazing`)
5. Pull Request öffnen

---

## 📄 Lizenz

[MIT](LICENSE)

---

<div align="center">

*Erstellt für wissenschaftliche Präsentationen mit Beamer-optimierter UI.*

</div>
