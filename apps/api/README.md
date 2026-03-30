# ZDT API Backend

Fastify-basierter Backend Server für die ZDT AI-Assistenten-Plattform.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Fastify Server                      │
│                    Port 8080                         │
├─────────────────────────────────────────────────────┤
│  /zdt/api/chat    │ Chat + Email + Canvas (SSE Stream)  │
│  /zdt/api/asr     │ Speech-to-Text Proxy (Whisper)      │
│  /zdt/api/tts     │ Text-to-Speech (Piper)              │
│  /zdt/api/health  │ Health Check                        │
├─────────────────────────────────────────────────────┤
│            In-Memory Conversation State              │
│  - history: Message[]                               │
│  - mail: EmailDraft                                 │
│  - lastCanvasQuery/Html: Canvas State               │
└─────────────────────────────────────────────────────┘
```

## Endpoints

### POST /zdt/api/chat

Main chat endpoint using Server-Sent Events (SSE).

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
- `token` - Streaming tokens `{ token: "word" }`
- `mail` - Email draft update `{ to, subject, message, status }`
- `canvas` - Canvas content `{ title, html }`
- `final` - End of response `{ conversationId, text }`
- `error` - Error `{ message, status }`

### POST /zdt/api/asr

Speech-to-text proxy for Whisper ASR service.

**Request:** `multipart/form-data` with audio file

**Response:** `{ text: "transcribed text" }`

### POST /zdt/api/tts

Text-to-speech using Piper.

**Request:** `{ text: "text to speak" }`

**Response:** `audio/wav` binary

### GET /zdt/api/health

Health check endpoint.

**Response:** `{ ok: true }`

## Configuration

Create `.env` file in `apps/api/`:

```env
# Server
PORT=8080

# Ollama LLM
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

# ASR (Whisper)
ASR_URL=http://127.0.0.1:9002/transcribe
ASR_FIELD=file
```

## Development

```bash
# Install dependencies
pnpm install

# Start dev server
pnpm dev

# Type check
npx tsc --noEmit
```

## Intent Routing

The `/api/chat` endpoint routes requests based on intent detection:

1. **Email Mode** - Triggered by "lass uns eine email schreiben"
2. **Canvas Mode** - Detected by `isCanvasIntent()` for images/diagrams
3. **Normal Chat** - Streaming response via Ollama

## State Management

Conversation state is stored in-memory using a Map:

```typescript
type ConvState = {
  history: Msg[];           // Chat history
  mail: MailDraft;          // Email draft state
  lastCanvasQuery?: string; // For canvas follow-ups
  lastCanvasHtml?: string;  // For canvas edits
};
```

For production, consider using Redis for persistence.

## Dependencies

- `fastify` - Web framework
- `@fastify/cors` - CORS support
- `@fastify/multipart` - File upload handling
- `zod` - Request validation
- `dotenv` - Environment variables
