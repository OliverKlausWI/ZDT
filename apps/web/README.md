# ZDT Web Frontend

React-basiertes Frontend für die ZDT AI-Assistenten-Plattform.

## 📁 Struktur

```
apps/web/src/
├── main.tsx          # Entry Point
├── App.tsx           # Main Component (Chat + Content Panel)
├── App.css           # White Mode Styling
├── index.css         # Base Styles
│
├── components/
│   └── ContentCanvas.tsx    # HTML Content Renderer (deprecated, inline in App)
│
└── lib/
    └── audioManager.ts      # Audio Utilities (geplant)
```

## 🎨 UI Layout

```
┌─────────────────────────────────────────────────────────────┐
│                        App Root                              │
│  ┌──────────────────────┬──────────────────────────────────┐│
│  │   Sidebar (420px)    │     Content Panel (flex: 1)       ││
│  │  ┌────────────────┐  │  ┌──────────────────────────────┐││
│  │  │ AI Assistant   │  │  │                              │││
│  │  │ [Neue Konv.]   │  │  │  EmailCanvas / HtmlCanvas    │││
│  │  ├────────────────┤  │  │  oder Placeholder            │││
│  │  │ [TTS] [Audio]  │  │  │                              │││
│  │  │ [Test]         │  │  │  ┌────────────────────────┐ │││
│  │  ├────────────────┤  │  │  │   Email Entwurf        │ │││
│  │  │                │  │  │  │   An: ...              │ │││
│  │  │  Chat Bubbles  │  │  │  │   Betreff: ...         │ │││
│  │  │                │  │  │  │   Nachricht: ...       │ │││
│  │  │                │  │  │  └────────────────────────┘ │││
│  │  ├────────────────┤  │  │                              │││
│  │  │ [Mic] [Input]  │  │  │                              │││
│  │  │ [Send][Interr.]│  │  └──────────────────────────────┘││
│  │  └────────────────┘  │                                  ││
│  └──────────────────────┴──────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

## 🎯 Features

### Chat Interface

- **Streaming Chat** via SSE (Server-Sent Events)
- **Message Bubbles** für User/Assistant
- **TTS Toggle** für Sprachausgabe
- **Mic Button** für Spracheingabe (VAD)
- **Interrupt Button** zum Abbrechen

### Content Panel

Drei Modi:

1. **Placeholder** - Wenn inaktiv
   ```
   "Content Panel - Beschreibe im Chat, was du sehen möchtest."
   ```

2. **EmailCanvas** - Email-Entwurf
   - Empfänger, Betreff, Nachricht
   - Status-Pill (editing/confirm_send/sent/error)

3. **HtmlCanvas** - Dynamischer Content
   - Bilder (via LoremFlickr)
   - Diagramme (via GLM-5)
   - Tabellen, Karten, etc.

## 🔌 API Integration

### Chat Endpoint

```typescript
// POST /api/chat (SSE)
const response = await fetch('/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    conversationId: uuid,
    message: userInput,
    inputMode: 'text'
  })
});

// SSE Events verarbeiten
const reader = response.body.getReader();
// ... parse events: token, mail, canvas, final
```

### Event Types

```typescript
// Token Event
{ event: "token", data: { token: "Ich" } }

// Mail Event
{ event: "mail", data: {
  to: "max@example.com",
  subject: "Meeting",
  message: "...",
  status: "editing"
}}

// Canvas Event
{ event: "canvas", data: {
  title: "Diagramm",
  html: "<div>...</div>"
}}

// Final Event
{ event: "final", data: {
  conversationId: "uuid",
  text: "Vollständige Antwort"
}}
```

## 🎨 Styling

### White Mode (Beamer-optimiert)

```css
:root {
  --bg: #f0f2f5;
  --panel: #ffffff;
  --border: #d1d5db;
  --text: #1f2937;
  --muted: #6b7280;
  --accent: #2563eb;
  
  /* Status Colors */
  --ok: #10b981;
  --warn: #f59e0b;
  --danger: #ef4444;
}
```

### Responsive

```css
@media (max-width: 1200px) {
  .sidebar { width: 380px; }
}

@media (max-width: 900px) {
  .layout { flex-direction: column; }
}
```

## 📝 Components

### App.tsx

Main Component mit:
- Chat State Management
- SSE Connection Handling
- Audio/TTS Controls
- Mic/VAD Integration
- Email Draft State
- Canvas Content State

Key State:
```typescript
const [messages, setMessages] = useState<ChatMessage[]>([]);
const [input, setInput] = useState("");
const [emailDraft, setEmailDraft] = useState<EmailDraft>({...});
const [canvasContent, setCanvasContent] = useState<string>("");
const [canvasTitle, setCanvasTitle] = useState<string>("");
const [ttsEnabled, setTtsEnabled] = useState(true);
const [micOn, setMicOn] = useState(false);
```

### EmailCanvas (inline)

```typescript
function EmailCanvas({ draft }: { draft: EmailDraft }) {
  return (
    <>
      <Header title="E-Mail Entwurf" status={draft.status} />
      <Field label="An" value={draft.to} />
      <Field label="Betreff" value={draft.subject} />
      <Field label="Nachricht" value={draft.message} />
    </>
  );
}
```

### HtmlCanvas (inline)

```typescript
function HtmlCanvas({ content, title }: { content: string; title: string }) {
  return (
    <>
      <Header title={title} />
      <iframe 
        srcDoc={sanitizedHtml}
        sandbox="allow-same-origin"
      />
    </>
  );
}
```

## 🔧 Entwicklung

```bash
# Dev Server
pnpm dev

# Build
pnpm build

# TypeScript prüfen
npx tsc --noEmit
```

### Vite Config

```typescript
export default defineConfig({
  plugins: [react()],
  base: "/zdt/",  // Optional für Subpath
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/zdt/, "")
      }
    }
  }
});
```

## 🎤 Audio Features

### TTS (Text-to-Speech)

```typescript
// TTS aktivieren/deaktivieren
setTtsEnabled(true);

// Audio-Modus wählen (WebAudio vs HTML Audio)
const audioMode = isProbablyIOS() ? "htmlaudio" : "webaudio";

// TTS Queue verarbeiten
async function ensureTTSFlow() {
  // Prefetch, Queue, Play
}
```

### VAD (Voice Activity Detection)

```typescript
// Mic mit VAD
const vadState = {
  speaking: false,
  threshold: 0.03,
  minSpeechMs: 250,
  endSilenceMs: 700
};

// Auto-send bei Stille
// Hands-free Mode
```

## ⚠️ Bekannte Issues

- **Memory Leak** bei vielen Audio-Streams
- **iOS Audio** benötigt User-Interaktion zum Unlock
- **SSE Reconnect** noch nicht implementiert

## 🔒 Security

- **iframe Sandbox** für Canvas HTML
- **Script Removal** bei HTML-Sanitization
- **CORS** via Proxy (keine direkten External Calls)

---

*Für API-Details siehe: `../api/README.md`*
