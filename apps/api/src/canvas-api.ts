/**
 * Canvas API - HTML Content Generierung
 * 
 * Dieses Modul stellt Funktionen bereit, um dynamische HTML-Inhalte
 * für das rechte Content Panel zu generieren. Es nutzt:
 * 
 * 1. LoremFlickr - Für Bildersuche (kostenlos, kein API-Key)
 * 2. GLM-5 API - Für Diagramme, Tabellen, Karten, Bearbeitungen
 * 
 * Features:
 * - Intent Detection: Erkennt ob User einen Canvas-Content möchte
 * - Image Search: Extrahiert Suchbegriffe und holt Bilder
 * - HTML Generation: GLM-5 generiert strukturiertes HTML
 * - Edit Mode: Bearbeitet existierenden Content (Follow-ups)
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

/** GLM-5 API Endpoint (Zhipu AI) */
const GLM5_API_URL = "https://api.z.ai/api/paas/v4/chat/completions";

/** GLM-5 API Key - Muss über GLM5_API_KEY Environment Variable konfiguriert werden */
const GLM5_API_KEY = process.env.GLM5_API_KEY || "";

/** LoremFlickr URL Template für Bildersuche */
const LOREMFLICKR_URL = "https://loremflickr.com/800/600";

/** Logger Utility */
const log = {
  error: (msg: any, data?: any) => console.error("[Canvas API Error]", msg, data || ""),
  info: (msg: any) => console.log("[Canvas API]", msg)
};

// ============================================================================
// TYPES
// ============================================================================

/** Ergebnis der Canvas Generierung */
export interface CanvasResult {
  /** Titel für den Content Header */
  title: string;
  /** HTML Content (wird in iframe gerendert) */
  html: string;
}

// ============================================================================
// IMAGE DETECTION & SEARCH
// ============================================================================

/**
 * Erkennt ob der User ein Bild sehen möchte.
 * 
 * Matching Patterns:
 * - "zeige mir [bild/katze/hund/...]"
 * - "foto von X"
 * - Follow-ups: "einen anderen", "noch eins"
 * - Kurze Sätze mit Bild-Keywords
 * 
 * @param text - User-Nachricht
 * @returns true wenn Bild-Request erkannt
 */
function isImageRequest(text: string): boolean {
  const t = text.toLowerCase();
  
  // Direkte Bild-Anfragen mit "zeige"
  if (
    (t.includes("zeige") || t.includes("zeig")) &&
    (t.includes("bild") || t.includes("foto") || t.includes("katze") || 
     t.includes("hund") || t.includes("pferd") || t.includes("landschaft") ||
     t.includes("stadt") || t.includes("natur") || t.includes("auto") ||
     t.includes("haus") || t.includes("berg") || t.includes("strand") ||
     t.includes("meer") || t.includes("wald") || t.includes("blume") ||
     t.includes("himmel") || t.includes("sonne") || t.includes("mond") ||
     t.includes("sonnenuntergang") || t.includes("tiere") || t.includes("vogel"))
  ) {
    return true;
  }
  
  // Follow-up Requests
  if (t.includes("anderen") || t.includes("anderes") || t.includes("noch ein") ||
      t.includes("noch eins") || t.includes("nochmal")) {
    return true;
  }
  
  // Kurze Sätze mit Bild-Keywords (ohne "zeige")
  const imageKeywords = ["katze", "hund", "pferd", "landschaft", "stadt", 
                         "natur", "auto", "haus", "berg", "strand", "meer",
                         "wald", "blume", "himmel", "sonne", "mond"];
  
  const words = t.split(/\s+/);
  if (words.length <= 4) {
    for (const kw of imageKeywords) {
      if (t.includes(kw)) return true;
    }
  }
  
  return t.includes("foto von") || t.includes("bild von");
}

/**
 * Extrahiert den Suchbegriff aus der User-Nachricht.
 * 
 * Beispiele:
 * - "zeige mir eine Katze" → "katze"
 * - "ein Bild von Tokyo bei Nacht" → "tokyo bei nacht"
 * - "einen anderen Hund" → "hund" (mit lastCanvasQuery fallback)
 * 
 * @param text - User-Nachricht
 * @param lastCanvasQuery - Letzter Query für Follow-ups
 * @returns Suchbegriff für LoremFlickr
 */
function extractImageQuery(text: string, lastCanvasQuery?: string): string {
  const t = text.toLowerCase();
  
  // Follow-up: "einen anderen X"
  if (t.includes("anderen") || t.includes("anderes") || t.includes("noch ein") ||
      t.includes("noch eins") || t.includes("nochmal")) {
    
    const keywords = ["katze", "hund", "pferd", "landschaft", "stadt", 
                      "natur", "auto", "haus", "berg", "strand", "meer",
                      "wald", "blume", "himmel", "sonne", "mond"];
    
    // Suche nach neuem Keyword in der Nachricht
    for (const kw of keywords) {
      if (t.includes(kw)) return kw;
    }
    
    // Fallback auf letzten Query
    if (lastCanvasQuery) return lastCanvasQuery;
  }
  
  // Regex Patterns für verschiedene Formulierungen
  const patterns = [
    /zeige mir (?:ein |eine )?(?:bild|foto) (?:von )?(.+)/i,
    /zeig mir (?:ein |eine )?(?:bild|foto) (?:von )?(.+)/i,
    /zeige (?:ein |eine )?(?:bild|foto) (?:von )?(.+)/i,
    /bild von (.+)/i,
    /foto von (.+)/i,
    /einen (.+)/i,
    /eine (.+)/i,
  ];
  
  for (const pattern of patterns) {
    const match = t.match(pattern);
    if (match) {
      // Bereinige den Query (entferne Füllwörter)
      let query = match[1].trim();
      query = query.replace(/\b(ein|eine|der|die|das|einer|einem|einen|anderen|anderes)\b/gi, "").trim();
      return query || "nature";
    }
  }
  
  // Direkte Keyword-Suche
  const keywords = ["katze", "hund", "pferd", "landschaft", "stadt", 
                    "natur", "auto", "haus", "berg", "strand", "meer",
                    "wald", "blume", "himmel", "sonne", "mond"];
  
  for (const kw of keywords) {
    if (t.includes(kw)) return kw;
  }
  
  return "nature"; // Default Fallback
}

/**
 * Holt ein Bild von LoremFlickr.
 * 
 * LoremFlickr ist ein kostenloser Service, der zufällige Bilder
 * basierend auf Suchbegriffen liefert. Kein API-Key erforderlich.
 * 
 * @param query - Suchbegriff
 * @returns Bild-URL und Alt-Text
 */
async function fetchImage(query: string): Promise<{ url: string; alt: string } | null> {
  try {
    const imageUrl = `${LOREMFLICKR_URL}/${encodeURIComponent(query)}`;
    log.info(`Fetching image from: ${imageUrl}`);
    
    return {
      url: imageUrl,
      alt: query
    };
  } catch (e) {
    log.error("Image fetch failed", e);
    return null;
  }
}

/**
 * Generiert HTML für die Bildanzeige.
 * 
 * Erstellt ein responsives, gestyltes HTML mit:
 * - Gradient Hintergrund
 * - Titel
 * - Bild mit Schatten
 * - Credit Text
 * 
 * @param imageUrl - Bild-URL
 * @param alt - Alt-Text
 * @param query - Suchbegriff (für Titel)
 * @returns HTML String
 */
function generateImageHtml(imageUrl: string, alt: string, query: string): string {
  return `
<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:20px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);">
  <h2 style="color:white;margin:0 0 20px 0;text-shadow:0 2px 4px rgba(0,0,0,0.3);font-size:24px;">${query.charAt(0).toUpperCase() + query.slice(1)}</h2>
  <img src="${imageUrl}" alt="${alt}" style="max-width:100%;max-height:60vh;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,0.4);object-fit:cover;" />
  <p style="color:rgba(255,255,255,0.8);margin:16px 0 0 0;font-size:14px;">Photo via LoremFlickr</p>
</div>`;
}

// ============================================================================
// CONTENT TYPE DETECTION
// ============================================================================

/**
 * Presets für verschiedene Content-Typen.
 * Jedes Preset definiert einen System-Prompt für GLM-5.
 */
const CANVAS_PRESETS: Record<string, { systemPrompt: string; title: string }> = {
  image: {
    title: "Bild",
    systemPrompt: `Du erstellst HTML für eine Bildanzeige.
Zeige das Bild zentriert mit einem schicken Rahmen.
Nutze placeholder Bild-URLs die der Nutzer ersetzen kann.
Antworte NUR als JSON: {"title": "Bild", "html": "..."}`
  },
  diagram: {
    title: "Diagramm",
    systemPrompt: `Du erstellst HTML für ein Diagramm oder eine Visualisierung.
Nutze Inline-CSS für das Styling.
Erstelle Balkendiagramme, Kreisdiagramme oder Tabellen je nach Anfrage.
Y-Achse IMMER LINKS von den Balken platzieren.
Nutze Flexbox für Layouts.
Antworte NUR als JSON: {"title": "Titel", "html": "..."}`
  },
  card: {
    title: "Karte",
    systemPrompt: `Du erstellst HTML für eine Info-Karte oder ein Dashboard-Widget.
Modernes, übersichtliches Design mit Inline-CSS.
Antworte NUR als JSON: {"title": "Titel", "html": "..."}`
  },
  table: {
    title: "Tabelle",
    systemPrompt: `Du erstellst HTML für eine formatierte Tabelle.
Klare Überschriften, abwechselnde Zeilenfarben.
Inline-CSS für das Styling.
Antworte NUR als JSON: {"title": "Titel", "html": "..."}`
  }
};

/**
 * Erkennt den Content-Typ aus der User-Nachricht.
 * 
 * @param userRequest - User-Nachricht
 * @returns Content-Type Key oder null
 */
function detectContentType(userRequest: string): string | null {
  const t = userRequest.toLowerCase();
  
  if (t.includes("bild") || t.includes("foto") || t.includes("grafik") || t.includes("zeige") && t.includes("an")) {
    return "image";
  }
  if (t.includes("diagramm") || t.includes("chart") || t.includes("balken") || t.includes("visualisiere")) {
    return "diagramm";
  }
  if (t.includes("karte") || t.includes("dashboard") || t.includes("widget")) {
    return "card";
  }
  if (t.includes("tabelle") || t.includes("übersicht") || t.includes("liste")) {
    return "table";
  }
  return null;
}

// ============================================================================
// CANVAS INTENT DETECTION
// ============================================================================

/**
 * Prüft ob der User-Request für das Canvas-Panel gedacht ist.
 * 
 * Matching Kriterien:
 * 1. Bild-Anfragen (isImageRequest)
 * 2. Explizite Keywords ("zeige mir", "erstelle im canvas")
 * 3. Content-Type Detection
 * 4. Bearbeitungs-Keywords ("hinzufügen", "ändere", "D=7")
 * 
 * @param text - User-Nachricht
 * @returns true wenn Canvas Intent erkannt
 */
export function isCanvasIntent(text: string): boolean {
  const t = text.toLowerCase();
  
  // Bild-Anfragen
  if (isImageRequest(text)) {
    return true;
  }
  
  // Explizite Canvas-Keywords
  if (t.includes("zeige mir") || (t.includes("erstelle") && t.includes("im canvas"))) {
    return true;
  }
  
  // Content-Type erkannt
  if (detectContentType(text)) {
    return true;
  }
  
  // Follow-up Bearbeitungen
  if (t.includes("hinzufügen") || t.includes("hinzufuegen") || t.includes("füge") ||
      t.includes("entferne") || t.includes("lösche") || t.includes("ändere") ||
      t.includes("bearbeite") || t.includes("aktualisiere") || t.includes("update") ||
      t.includes("noch") && (t.includes("dazu") || t.includes("hinzufügen")) ||
      t.includes("mach") && (t.includes("größer") || t.includes("kleiner")) ||
      /\w+=\d+/.test(t)) {  // Pattern wie "D=7"
    return true;
  }
  
  return false;
}

// ============================================================================
// CANVAS CONTENT GENERATION
// ============================================================================

/**
 * Generiert Canvas Content basierend auf User-Request.
 * 
 * Flow:
 * 1. Prüfe auf Bearbeitungs-Modus (falls lastCanvasHtml existiert)
 * 2. Falls Bild-Request: Hole Bild von LoremFlickr
 * 3. Sonst: Generiere HTML via GLM-5
 * 
 * @param userRequest - User-Nachricht
 * @param lastCanvasQuery - Letzter Canvas-Titel (für Follow-ups)
 * @param lastCanvasHtml - Letztes Canvas-HTML (für Bearbeitungen)
 * @returns CanvasResult mit title und html, oder null bei Fehler
 */
export async function generateCanvasContent(
  userRequest: string, 
  lastCanvasQuery?: string, 
  lastCanvasHtml?: string
): Promise<CanvasResult | null> {
  
  log.info(`Canvas request: ${userRequest.slice(0, 50)}...`);
  
  // ========================================
  // 1. Prüfe auf Bearbeitungs-Modus
  // ========================================
  const isEdit = lastCanvasHtml && (
    userRequest.toLowerCase().includes("hinzufügen") ||
    userRequest.toLowerCase().includes("hinzufuegen") ||
    userRequest.toLowerCase().includes("füge") ||
    userRequest.toLowerCase().includes("entferne") ||
    userRequest.toLowerCase().includes("lösche") ||
    userRequest.toLowerCase().includes("ändere") ||
    userRequest.toLowerCase().includes("bearbeite") ||
    userRequest.toLowerCase().includes("aktualisiere") ||
    /\w+=\d+/.test(userRequest)
  );
  
  // ========================================
  // 2. Bild-Anfrage (LoremFlickr)
  // ========================================
  if (isImageRequest(userRequest) && !isEdit) {
    const query = extractImageQuery(userRequest, lastCanvasQuery);
    log.info(`Image request detected, searching for: ${query}`);
    
    const image = await fetchImage(query);
    if (image) {
      return {
        title: query.charAt(0).toUpperCase() + query.slice(1),
        html: generateImageHtml(image.url, image.alt, query)
      };
    }
  }
  
  // ========================================
  // 3. GLM-5 für Diagramme/Bearbeitungen
  // ========================================
  if (!GLM5_API_KEY) {
    log.error("GLM5_API_KEY not configured");
    return null;
  }
  
  const contentType = detectContentType(userRequest);
  const preset = contentType ? CANVAS_PRESETS[contentType] : null;
  
  // System-Prompt basierend auf Modus
  let systemPrompt: string;
  let userPrompt: string;
  
  if (isEdit && lastCanvasHtml) {
    // Bearbeitungs-Modus: Existierendes HTML aktualisieren
    systemPrompt = `Du bist ein UI-Entwickler. Bearbeite das existierende HTML basierend auf dem User-Wunsch.
Das HTML wird in einem iframe gerendert - keine Scripts, nur statischer Content.
Behalte das bestehende Design bei, aber führe die gewünschten Änderungen durch.
Antworte NUR als JSON: {"title": "Titel", "html": "..."}`;
    
    userPrompt = `AKTUELLES HTML:\n${lastCanvasHtml}\n\nÄNDERUNGSWUNSCH: ${userRequest}\n\nGib das aktualisierte HTML zurück.`;
  } else {
    // Neu-Erstellung
    systemPrompt = preset?.systemPrompt || `Du bist ein UI-Entwickler. Erstelle HTML mit Inline-CSS.
Das HTML wird in einem iframe gerendert - keine Scripts, nur statischer Content.
Antworte NUR als JSON: {"title": "Titel", "html": "..."}`;
    
    userPrompt = userRequest;
  }

  try {
    log.info(`Generating canvas content for: ${userRequest.slice(0, 50)}...`);
    
    // GLM-5 API Call
    const res = await fetch(GLM5_API_URL, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json", 
        "Authorization": "Bearer " + GLM5_API_KEY 
      },
      body: JSON.stringify({
        model: "glm-5",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        max_tokens: 4000,
        temperature: 0.5
      })
    });

    if (!res.ok) {
      log.error("GLM-5 API failed", res.status);
      return null;
    }

    const json = await res.json();
    let content = json?.choices?.[0]?.message?.content || "";
    
    // JSON aus Response extrahieren
    content = content.replace(/```json\n?/g, "").replace(/```\n?/g, "");
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    
    if (!jsonMatch) {
      log.error("No JSON found in response");
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]);
    
    return {
      title: parsed.title || preset?.title || "Content",
      html: sanitizeHtml(parsed.html || "")
    };
  } catch (e) {
    log.error("Canvas generation failed", e);
    return null;
  }
}

// ============================================================================
// SECURITY
// ============================================================================

/**
 * Entfernt gefährliche HTML-Elemente.
 * 
 * - Script-Tags
 * - Event-Handler (onclick, onload, etc.)
 * 
 * @param html - Raw HTML
 * @returns Sanitized HTML
 */
function sanitizeHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/on\w+="[^"]*"/gi, "")
    .replace(/on\w+='[^']*'/gi, "");
}
