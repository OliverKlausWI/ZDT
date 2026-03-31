/**
 * ZDT Web - Main Application Component
 * 
 * React-basiertes Frontend für die ZDT AI-Assistenten-Plattform.
 * 
 * Features:
 * - Streaming Chat mit SSE (Server-Sent Events)
 * - Text-to-Speech mit Queue-System (WebAudio/HTMLAudio)
 * - Speech Recognition mit Voice Activity Detection (VAD)
 * - Email Draft UI mit Status-Anzeige
 * - Canvas Panel für HTML-Content (Bilder, Diagramme, Tabellen)
 * 
 * Architecture:
 * - Sidebar: Controls, Chat List, Composer
 * - Content Panel: EmailCanvas | HtmlCanvas | Placeholder
 * 
 * @module App
 */

// ============================================================================
// IMPORTS
// ============================================================================

import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

// ============================================================================
// TYPES
// ============================================================================

/** Chat Message Role */
type Role = "user" | "assistant" | "system";

/** Chat Message Structure */
type ChatMessage = {
  id: string;
  role: Role;
  content: string;
};

/** TTS Queue Item */
type TTSItem = {
  id: string;
  text: string;
  buffer?: AudioBuffer;
  blobUrl?: string;
  byteLen?: number;
};

/** Audio Playback Mode */
type AudioMode = "webaudio" | "htmlaudio";

/** Email Draft Status */
type MailStatus = "idle" | "editing" | "confirm_send" | "sent" | "error";

/** Email Draft State */
type EmailDraft = {
  to: string;
  subject: string;
  message: string;
  status: MailStatus;
  lastError?: string;
};

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Generiert eine UUID für Messages und Conversations.
 * Fallback für Browser ohne crypto.randomUUID Support.
 */
function uuid(): string {
  // @ts-ignore
  return (crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).toString();
}

/**
 * Parst Server-Sent Events aus dem Response Stream.
 * 
 * SSE Format:
 * ```
 * event: token
 * data: {"token":"Hello"}
 * 
 * ```
 * 
 * @param chunk - Raw chunk from stream
 * @param state - Buffer state object
 * @param onEvent - Callback for parsed events
 */
function parseSSEChunk(
  chunk: string,
  state: { buffer: string },
  onEvent: (evt: { event: string; data: string }) => void
): void {
  state.buffer += chunk;

  let idx: number;
  while ((idx = state.buffer.indexOf("\n\n")) !== -1) {
    const raw = state.buffer.slice(0, idx);
    state.buffer = state.buffer.slice(idx + 2);

    let event = "message";
    let dataLines: string[] = [];

    for (const line of raw.split("\n")) {
      const l = line.replace(/\r$/, "");
      if (l.startsWith("event:")) event = l.slice(6).trim();
      if (l.startsWith("data:")) dataLines.push(l.slice(5).trim());
    }

    const data = dataLines.join("\n");
    onEvent({ event, data });
  }
}

function pickSupportedMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
  ];
  for (const c of candidates) {
    // @ts-ignore
    if (window.MediaRecorder && MediaRecorder.isTypeSupported?.(c)) return c;
  }
  return "";
}

function isProbablyIOS(): boolean {
  const ua = navigator.userAgent || "";
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    ((/Macintosh/.test(ua) || /Mac OS/.test(ua)) && "ontouchend" in document);
  return !!isIOS;
}

export default function App() {
  const [conversationId, setConversationId] = useState<string>(() => uuid());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [ttsEnabled, setTtsEnabled] = useState(true);

  const [audioUnlocked, setAudioUnlocked] = useState(false);
  const [ttsStatus, setTtsStatus] = useState<string>("");

  const [emailDraft, setEmailDraft] = useState<EmailDraft>({
    to: "",
    subject: "",
    message: "",
    status: "idle",
  });
  
  const [canvasContent, setCanvasContent] = useState<string>("");
  const [canvasTitle, setCanvasTitle] = useState<string>("Content");

  const isMailActive = emailDraft.status !== "idle";

  const chatAbortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const ttsSourceRef = useRef<AudioBufferSourceNode | null>(null);

  const htmlAudioRef = useRef<HTMLAudioElement | null>(null);

  const audioModeRef = useRef<AudioMode>(
    isProbablyIOS() ? "htmlaudio" : "webaudio"
  );

  const ttsQueueRef = useRef<TTSItem[]>([]);
  const ttsBufferRef = useRef("");
  const ttsPrefetchingRef = useRef(false);
  const ttsPlayingRef = useRef(false);

  const [micOn, setMicOn] = useState(false);
  const micOnRef = useRef(false);
  const [micStatus, setMicStatus] = useState<
    "idle" | "listening" | "recording" | "sending"
  >("idle");

  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);

  const vadStateRef = useRef({
    speaking: false,
    speechStartMs: 0,
    lastLoudMs: 0,
    threshold: 0.03,
    minSpeechMs: 250,
    endSilenceMs: 700,
  });

  // same-origin reverse proxy
  const backendBase = useMemo(() => "/zdt", []);

  function scrollToBottom() {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  function stopTTSPlaybackAndQueue() {
    // Stop WebAudio
    const src = ttsSourceRef.current;
    if (src) {
      try {
        src.stop();
      } catch {}
    }
    ttsSourceRef.current = null;

    // Stop HTMLAudio
    if (htmlAudioRef.current) {
      try {
        htmlAudioRef.current.pause();
        htmlAudioRef.current.currentTime = 0;
      } catch {}
    }

    for (const it of ttsQueueRef.current) {
      if (it.blobUrl) {
        try {
          URL.revokeObjectURL(it.blobUrl);
        } catch {}
      }
    }

    ttsQueueRef.current = [];
    ttsBufferRef.current = "";
    ttsPrefetchingRef.current = false;
    ttsPlayingRef.current = false;
  }

  function interruptEverything() {
    stopTTSPlaybackAndQueue();

    if (chatAbortRef.current) {
      try {
        chatAbortRef.current.abort();
      } catch {}
      chatAbortRef.current = null;
    }
  }

  async function ensureAudioUnlocked(): Promise<boolean> {
    try {
      // @ts-ignore
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      if (!AC) return false;

      if (!audioCtxRef.current) audioCtxRef.current = new AC();

      if (audioCtxRef.current.state === "suspended") {
        await audioCtxRef.current.resume();
      }

      if (!gainRef.current && audioCtxRef.current) {
        const g = audioCtxRef.current.createGain();
        g.gain.value = 1.0;
        g.connect(audioCtxRef.current.destination);
        gainRef.current = g;
      }

      if (!htmlAudioRef.current) {
        const a = document.createElement("audio");
        a.playsInline = true;
        a.autoplay = false;
        a.muted = false;
        a.volume = 1.0;
        htmlAudioRef.current = a;
      }

      setAudioUnlocked(true);
      return true;
    } catch {
      return false;
    }
  }

  async function primeAudioOutput() {
    try {
      const ok = await ensureAudioUnlocked();
      if (!ok || !audioCtxRef.current) return;

      const buf = audioCtxRef.current.createBuffer(
        1,
        1,
        audioCtxRef.current.sampleRate
      );
      const src = audioCtxRef.current.createBufferSource();
      src.buffer = buf;

      const g = audioCtxRef.current.createGain();
      g.gain.value = 0.0;
      src.connect(g);
      g.connect(audioCtxRef.current.destination);

      src.start(audioCtxRef.current.currentTime + 0.01);
      src.stop(audioCtxRef.current.currentTime + 0.02);
    } catch {}
  }

  async function enableAudio() {
    const ok = await ensureAudioUnlocked();
    if (!ok) {
      setAudioUnlocked(false);
      return;
    }
    await primeAudioOutput();
  }

  function upsertAssistantToken(tok: string) {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === "assistant") {
        return [...prev.slice(0, -1), { ...last, content: last.content + tok }];
      }
      return [...prev, { id: uuid(), role: "assistant", content: tok }];
    });
  }

  function flushOnSentenceBoundaryIfPossible() {
    if (!ttsEnabled) return;
    const buf = ttsBufferRef.current;
    const m = buf.match(/[\s\S]*?[.!?](?=\s|$)/);
    if (!m) return;

    const sentence = m[0];
    const hasLetters = /[A-Za-zÄÖÜäöüß]/.test(sentence);
    if (!hasLetters) return;

    enqueueTTS(sentence);
    ttsBufferRef.current = buf.slice(sentence.length).replace(/^\s+/, "");
    void ensureTTSFlow();
  }

  function enqueueTTS(text: string) {
    const cleaned = text.trim();
    if (!cleaned) return;
    ttsQueueRef.current.push({ id: uuid(), text: cleaned });
  }

  function trimTrailingSilenceSafe(
    buf: AudioBuffer,
    threshold = 0.0015,
    keepTailSeconds = 0.1
  ): AudioBuffer {
    if (!audioCtxRef.current) return buf;

    const sr = buf.sampleRate;
    const len = buf.length;
    const keepTail = Math.floor(keepTailSeconds * sr);

    let lastIdx = -1;
    for (let i = len - 1; i >= 0; i--) {
      let loud = false;
      for (let ch = 0; ch < buf.numberOfChannels; ch++) {
        const data = buf.getChannelData(ch);
        if (Math.abs(data[i]) > threshold) {
          loud = true;
          break;
        }
      }
      if (loud) {
        lastIdx = i;
        break;
      }
    }
    if (lastIdx < 0) return buf;

    const minTotal = Math.floor(0.35 * sr);
    const newLen = Math.min(len, Math.max(lastIdx + keepTail, minTotal));
    if (newLen >= len) return buf;

    const out = audioCtxRef.current.createBuffer(buf.numberOfChannels, newLen, sr);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const src = buf.getChannelData(ch);
      out.copyToChannel(src.slice(0, newLen), ch);
    }
    return out;
  }

  async function fetchTTSWav(
    text: string
  ): Promise<{ arr: ArrayBuffer; byteLen: number } | null> {
    try {
      const res = await fetch(`${backendBase}/api/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) return null;
      const arr = await res.arrayBuffer();
      return { arr, byteLen: arr.byteLength };
    } catch {
      return null;
    }
  }

  async function prepareTTSItem(item: TTSItem): Promise<boolean> {
    const ok = await ensureAudioUnlocked();
    if (!ok) return false;

    const wav = await fetchTTSWav(item.text);
    if (!wav) return false;
    item.byteLen = wav.byteLen;

    if (audioModeRef.current === "htmlaudio") {
      const blob = new Blob([wav.arr], { type: "audio/wav" });
      item.blobUrl = URL.createObjectURL(blob);
      setTtsStatus(`Mode: HTMLAudio | WAV: ${(wav.byteLen / 1024).toFixed(1)} KB`);
      return true;
    }

    try {
      if (!audioCtxRef.current) return false;
      const decoded = await audioCtxRef.current.decodeAudioData(wav.arr.slice(0));
      const trimmed = trimTrailingSilenceSafe(decoded, 0.0015, 0.1);
      item.buffer = trimmed;
      setTtsStatus(
        `Mode: WebAudio | WAV: ${(wav.byteLen / 1024).toFixed(1)} KB | dur: ${trimmed.duration.toFixed(2)}s`
      );
      return true;
    } catch {
      audioModeRef.current = "htmlaudio";
      const blob = new Blob([wav.arr], { type: "audio/wav" });
      item.blobUrl = URL.createObjectURL(blob);
      setTtsStatus(`Mode: HTMLAudio (fallback) | WAV: ${(wav.byteLen / 1024).toFixed(1)} KB`);
      return true;
    }
  }

  async function ensureTTSFlow() {
    if (!ttsEnabled) return;
    const ok = await ensureAudioUnlocked();
    if (!ok) return;

    if (!ttsPrefetchingRef.current) {
      ttsPrefetchingRef.current = true;
      try {
        while (true) {
          const readyCount =
            audioModeRef.current === "htmlaudio"
              ? ttsQueueRef.current.filter((it) => !!it.blobUrl).length
              : ttsQueueRef.current.filter((it) => !!it.buffer).length;

          const nextToFetch =
            audioModeRef.current === "htmlaudio"
              ? ttsQueueRef.current.find((it) => !it.blobUrl)
              : ttsQueueRef.current.find((it) => !it.buffer);

          if (readyCount >= 2 || !nextToFetch) break;

          const okItem = await prepareTTSItem(nextToFetch);
          if (!okItem) {
            ttsQueueRef.current = ttsQueueRef.current.filter(
              (x) => x.id !== nextToFetch.id
            );
          }
        }
      } finally {
        ttsPrefetchingRef.current = false;
      }
    }

    if (!ttsPlayingRef.current) playNextTTS();
  }

  async function playNextTTS() {
    if (!ttsEnabled) return;

    if (audioModeRef.current === "htmlaudio") {
      const next = ttsQueueRef.current.find((it) => !!it.blobUrl);
      if (!next || !next.blobUrl) {
        ttsPlayingRef.current = false;
        return;
      }

      ttsQueueRef.current = ttsQueueRef.current.filter((x) => x.id !== next.id);
      ttsPlayingRef.current = true;

      const a = htmlAudioRef.current;
      if (!a) {
        ttsPlayingRef.current = false;
        return;
      }

      a.onended = () => {
        if (next.blobUrl) {
          try {
            URL.revokeObjectURL(next.blobUrl);
          } catch {}
        }
        ttsPlayingRef.current = false;
        void ensureTTSFlow();
      };

      try {
        a.src = next.blobUrl;
        a.currentTime = 0;
        a.muted = false;
        a.volume = 1.0;

        const p = a.play();
        if (p && typeof (p as any).catch === "function") {
          (p as any).catch(() => {
            setAudioUnlocked(false);
            setTtsStatus("Audio blockiert: bitte einmal 'Enable Audio' drücken.");
            ttsPlayingRef.current = false;
          });
        }
      } catch {
        ttsPlayingRef.current = false;
      }

      void ensureTTSFlow();
      return;
    }

    if (!audioCtxRef.current || !gainRef.current) {
      ttsPlayingRef.current = false;
      return;
    }

    const next = ttsQueueRef.current.find((it) => !!it.buffer);
    if (!next || !next.buffer) {
      ttsPlayingRef.current = false;
      return;
    }

    ttsQueueRef.current = ttsQueueRef.current.filter((x) => x.id !== next.id);
    ttsPlayingRef.current = true;

    const src = audioCtxRef.current.createBufferSource();
    src.buffer = next.buffer;
    src.connect(gainRef.current);
    ttsSourceRef.current = src;

    src.onended = () => {
      if (ttsSourceRef.current === src) ttsSourceRef.current = null;
      ttsPlayingRef.current = false;
      void ensureTTSFlow();
    };

    try {
      src.start(audioCtxRef.current.currentTime + 0.01);
    } catch {
      ttsSourceRef.current = null;
      ttsPlayingRef.current = false;
    }

    void ensureTTSFlow();
  }

  async function sendUserText(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;

    interruptEverything();

    const userMsg: ChatMessage = { id: uuid(), role: "user", content: trimmed };
    setMessages((prev) => [...prev, userMsg]);

    const ac = new AbortController();
    chatAbortRef.current = ac;

    setMessages((prev) => [...prev, { id: uuid(), role: "assistant", content: "" }]);

    ttsBufferRef.current = "";
    ttsQueueRef.current = [];
    ttsPrefetchingRef.current = false;
    ttsPlayingRef.current = false;

    const sseState = { buffer: "" };
    const decoder = new TextDecoder("utf-8");

    try {
      const res = await fetch(`${backendBase}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ac.signal,
        body: JSON.stringify({
          conversationId,
          message: trimmed,
          stream: true,
        }),
      });

      const newCid = res.headers.get("x-conversation-id");
      if (newCid && newCid !== conversationId) setConversationId(newCid);

      if (!res.ok || !res.body) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant") {
            return [
              ...prev.slice(0, -1),
              { ...last, content: "Fehler: Chat API nicht erreichbar." },
            ];
          }
          return [
            ...prev,
            { id: uuid(), role: "assistant", content: "Fehler: Chat API nicht erreichbar." },
          ];
        });
        chatAbortRef.current = null;
        return;
      }

      const reader = res.body.getReader();

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });

        parseSSEChunk(chunk, sseState, ({ event, data }) => {
          if (event === "token") {
            try {
              const obj = JSON.parse(data);
              const tok = String(obj?.token ?? "");
              if (tok) {
                upsertAssistantToken(tok);
                if (ttsEnabled) {
                  ttsBufferRef.current += tok;
                  flushOnSentenceBoundaryIfPossible();
                }
              }
            } catch {}
          } else if (event === "mail") {
            try {
              const obj = JSON.parse(data);
              setEmailDraft((prev) => ({
                to: String(obj?.to ?? prev.to),
                subject: String(obj?.subject ?? prev.subject),
                message: String(obj?.message ?? prev.message),
                status: (obj?.status as MailStatus) ?? prev.status,
                lastError: obj?.lastError ? String(obj.lastError) : undefined,
              }));
            } catch {}
          } else if (event === "canvas") {
            try {
              const obj = JSON.parse(data);
              if (obj?.html) {
                setCanvasContent(obj.html);
                if (obj.title) setCanvasTitle(obj.title);
              }
            } catch {}
          } else if (event === "final" || event === "done") {
            // IMPORTANT FIX: backend emits "final"
            if (ttsEnabled) {
              const rest = ttsBufferRef.current.trim();
              if (rest) {
                enqueueTTS(rest);
                ttsBufferRef.current = "";
              }
              void ensureTTSFlow();
            }
          }
        });
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant") {
            return [
              ...prev.slice(0, -1),
              { ...last, content: "Fehler: Verbindung abgebrochen." },
            ];
          }
          return [
            ...prev,
            { id: uuid(), role: "assistant", content: "Fehler: Verbindung abgebrochen." },
          ];
        });
      }
    } finally {
      chatAbortRef.current = null;
    }
  }

  // ---------------- Mic / VAD / Recording ----------------
  async function ensureMicStream(): Promise<MediaStream> {
    if (mediaStreamRef.current) return mediaStreamRef.current;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    mediaStreamRef.current = stream;

    await ensureAudioUnlocked();
    await primeAudioOutput();

    if (audioCtxRef.current) {
      const source = audioCtxRef.current.createMediaStreamSource(stream);
      const analyser = audioCtxRef.current.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      analyserRef.current = analyser;
    }

    return stream;
  }

  function stopMicLoop() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      try {
        mediaRecorderRef.current.stop();
      } catch {}
    }
    mediaRecorderRef.current = null;

    if (mediaStreamRef.current) {
      for (const t of mediaStreamRef.current.getTracks()) t.stop();
      mediaStreamRef.current = null;
    }
    analyserRef.current = null;

    setMicStatus("idle");
  }

  function computeRms(analyser: AnalyserNode): number {
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    let sumSq = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sumSq += v * v;
    }
    return Math.sqrt(sumSq / data.length);
  }

  function startRecordingSegment(stream: MediaStream) {
    const mimeType = pickSupportedMimeType();
    const recorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream);

    mediaRecorderRef.current = recorder;
    setMicStatus("recording");

    const chunks: BlobPart[] = [];

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    recorder.onstop = async () => {
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      if (blob.size < 1500) {
        setMicStatus("listening");
        return;
      }
      setMicStatus("sending");
      await sendASRBlob(blob);
      setMicStatus("listening");
    };

    recorder.start(250);
  }

  function stopRecordingSegment() {
    const r = mediaRecorderRef.current;
    if (!r) return;
    if (r.state !== "inactive") {
      try {
        r.stop();
      } catch {}
    }
  }

  async function sendASRBlob(blob: Blob) {
    interruptEverything();

    const fd = new FormData();
    fd.append("file", blob, "audio.webm");

    try {
      const res = await fetch(`${backendBase}/api/asr`, { method: "POST", body: fd });
      if (!res.ok) return;

      const json = await res.json();
      const text = String(json?.text ?? "").trim();
      if (!text) return;

      await sendUserText(text);
    } catch {}
  }

  async function startMicLoop() {
    const stream = await ensureMicStream();
    setMicStatus("listening");

    const analyser = analyserRef.current;
    if (!analyser) return;

    const st = vadStateRef.current;
    st.speaking = false;
    st.speechStartMs = 0;
    st.lastLoudMs = 0;

    const tick = () => {
      if (!micOnRef.current) return;

      const now = performance.now();
      const rms = computeRms(analyser);

      const loud = rms >= st.threshold;
      if (loud) st.lastLoudMs = now;

      if (!st.speaking && loud) {
        st.speaking = true;
        st.speechStartMs = now;

        interruptEverything();

        if (!mediaRecorderRef.current || mediaRecorderRef.current.state === "inactive") {
          startRecordingSegment(stream);
        }
      }

      if (st.speaking) {
        const speakingMs = now - st.speechStartMs;
        const silenceMs = now - st.lastLoudMs;

        if (speakingMs >= st.minSpeechMs && silenceMs >= st.endSilenceMs) {
          st.speaking = false;
          stopRecordingSegment();
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
  }

  async function toggleMic() {
    const next = !micOnRef.current;
    micOnRef.current = next;
    setMicOn(next);

    if (next) {
      try {
        await startMicLoop();
      } catch {
        micOnRef.current = false;
        setMicOn(false);
        stopMicLoop();
      }
    } else {
      stopMicLoop();
    }
  }

  useEffect(() => {
    return () => {
      micOnRef.current = false;
      stopMicLoop();
      interruptEverything();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function newConversation() {
    interruptEverything();
    setConversationId(uuid());
    setMessages([]);
    setInput("");
    setEmailDraft({ to: "", subject: "", message: "", status: "idle" });
  }

  async function testTTS() {
    interruptEverything();
    enqueueTTS("Hallo. Das ist ein kurzer TTS Test.");
    await ensureTTSFlow();
  }

  return (
    <div className="appRoot">
      <div className="layout">
        <aside className="sidebar">
          {/* FIXED: Top Header uses existing CSS classes sidebarTop/sidebarTopRow/controlsRow */}
          <div className="sidebarTop">
            <div className="sidebarTopRow">
              <div className="title">AI Assistant</div>
              <button className="linkButton" onClick={newConversation}>
                Neue Konversation
              </button>
            </div>

            <div className="controlsRow">
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={ttsEnabled}
                  onChange={(e) => setTtsEnabled(e.target.checked)}
                />
                <span>TTS</span>
              </label>

              <button
                className={`btn ${audioUnlocked ? "btnOk" : ""}`}
                onClick={() => void enableAudio()}
                title="Browser Autoplay-Policy: Einmal klicken um Audio zu erlauben"
              >
                {audioUnlocked ? "Audio aktiviert" : "Enable Audio"}
              </button>

              <button
                className="btn"
                onClick={() => void testTTS()}
                title="Spielt einen kurzen Test ab"
              >
                Test
              </button>
            </div>
          </div>

          {/* AB HIER UNVERÄNDERT (Chat + Composer) */}
          <div className="chatList" ref={listRef}>
            {messages.map((m) => (
              <div key={m.id} className={`bubble ${m.role}`}>
                <div className="bubbleRole">{m.role === "user" ? "Du" : "Assistant"}</div>
                <div className="bubbleContent">
                  {m.content || (m.role === "assistant" ? "…" : "")}
                </div>
              </div>
            ))}
          </div>

          <div className="composer">
            <div className="statusLine">
              <span className={`status ${audioUnlocked ? "" : "warn"}`}>
                Audio: <strong>{audioUnlocked ? "ok" : "gesperrt"}</strong>
              </span>
              <span className="status subtle" style={{ marginLeft: 12 }}>
                Mode: <strong>{audioModeRef.current}</strong>
              </span>
              <span className="status subtle" style={{ marginLeft: 12 }}>
                {ttsStatus ? <strong>{ttsStatus}</strong> : null}
              </span>
              <span className="status subtle" style={{ marginLeft: 12 }}>
                Mail: <strong>{emailDraft.status}</strong>
              </span>

              {micOn ? (
                <span className="status" style={{ marginLeft: 12 }}>
                  Mic:{" "}
                  <strong>
                    {micStatus === "listening"
                      ? "bereit"
                      : micStatus === "recording"
                      ? "nimmt auf…"
                      : micStatus === "sending"
                      ? "sende…"
                      : "idle"}
                  </strong>
                </span>
              ) : (
                <span className="status subtle" style={{ marginLeft: 12 }}>
                  Mic aus
                </span>
              )}
            </div>

            <div className="composerRow">
              <button
                className={`btn micBtn ${micOn ? "micOn" : ""} ${
                  micStatus === "recording" ? "micRec" : ""
                }`}
                onClick={() => void toggleMic()}
                title="Mic an/aus (Hands-free mit VAD)"
              >
                <span className="micDot" />
                Mic
              </button>

              <input
                className="input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={micOn ? "Tippen… (Sprechen sendet automatisch)" : "Tippe…"}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const text = input;
                    setInput("");
                    void sendUserText(text);
                  }
                }}
              />

              <button
                className="btn"
                onClick={() => {
                  const text = input;
                  setInput("");
                  void sendUserText(text);
                }}
              >
                Send
              </button>

              <button
                className="btn danger"
                onClick={interruptEverything}
                title="Stoppt Antwort + Audio"
              >
                Interrupt
              </button>
            </div>

            <div className="hint">
              E-Mail-Canvas rechts: Inhalte werden dort gepflegt (nicht im Chat). Zum Senden: „Sende die
              Mail“ → Bestätigung „Ja/Nein“.
            </div>
          </div>
        </aside>

        <main className="contentPanel">
          {isMailActive ? (
            <EmailCanvas draft={emailDraft} />
          ) : canvasContent ? (
            <HtmlCanvas content={canvasContent} title={canvasTitle} />
          ) : (
            <div className="contentPlaceholder">
              Content Panel - Beschreibe im Chat, was du sehen möchtest.
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

/**
 * Generic HTML Canvas for displaying any HTML content.
 */
function HtmlCanvas({ content, title }: { content: string; title: string }) {
  const sanitizeHtml = (html: string): string => {
    return html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
      .replace(/on\w+="[^"]*"/gi, "")
      .replace(/on\w+='[^']*'/gi, "");
  };

  return (
    <>
      <div className="contentHeader">
        <div className="contentTitle">{title}</div>
      </div>
      <div className="contentBody">
        <iframe
          srcDoc={`<!DOCTYPE html><html><head><style>body{margin:0;padding:16px;font-family:-apple-system,sans-serif;color:#1f2937;}</style></head><body>${sanitizeHtml(content)}</body></html>`}
          style={{ width: "100%", height: "100%", border: "none", background: "#fff" }}
          title="Canvas"
        />
      </div>
    </>
  );
}

/**
 * UI-only overhaul for the Email panel.
 * No logic changes: just structure and styling hooks.
 */
function EmailCanvas({ draft }: { draft: EmailDraft }) {
  const pillClass =
    draft.status === "editing"
      ? "editing"
      : draft.status === "confirm_send"
      ? "confirm"
      : draft.status === "sent"
      ? "sent"
      : draft.status === "error"
      ? "error"
      : "idle";

  return (
    <>
      <div className="contentHeader">
        <div className="contentTitle">E-Mail Entwurf</div>
        <div className={`pill ${pillClass}`}>{draft.status}</div>
      </div>

      <div className="contentBody">
        <div className="emailCanvas">
          <div className="field">
            <div className="label">An</div>
            <div className="value">{draft.to || "—"}</div>
          </div>

          <div className="field">
            <div className="label">Betreff</div>
            <div className="value">{draft.subject || "—"}</div>
          </div>

          <div className="field grow">
            <div className="label">Nachricht</div>
            <div className="value mono pre">{draft.message || "—"}</div>
          </div>

          {draft.lastError ? (
            <div className="field mailErrorBox">
              <div className="label">Fehler</div>
              <div className="value">{draft.lastError}</div>
            </div>
          ) : null}

          <div className="mailFooterHint">
            Bearbeitung per Dialog (Sprache/Text). Zum Senden: „Sende die Mail“ → Bestätigung „Ja“.
          </div>
        </div>
      </div>
    </>
  );
}