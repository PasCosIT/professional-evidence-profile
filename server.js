const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");

const PORT = process.env.PORT || 4173;
const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;
const PUBLIC_DIR = path.join(__dirname, "public");
const APP_VERSION = "2026-07-07-snapshot-v10";
const sessions = new Map();

const professionalKeywords = {
  strategy: ["strategia", "strategy", "roadmap", "priorit", "obiettivo", "stakeholder", "market"],
  project_management: ["progetto", "project", "timeline", "milestone", "dipenden", "rischio", "delivery"],
  product_management: ["product", "utente", "mvp", "feature", "backlog", "discovery", "pricing"],
  technology: ["architettura", "api", "database", "server", "deploy", "security", "cloud"],
  programming: ["codice", "bug", "test", "typescript", "python", "javascript", "refactor", "repo"],
  data_analytics: ["metric", "kpi", "dashboard", "analytics", "dataset", "sql", "report"],
  professional_communication: ["email", "messaggio", "tono", "cliente", "presentazione", "feedback"],
  leadership: ["team", "leadership", "delega", "ruoli", "conflitto", "responsabilit", "manager"],
  recruiting: ["colloquio", "candidato", "cv", "job description", "hiring", "recruiting"],
  negotiation: ["negozia", "contratto", "offerta", "partnership", "vendita", "accordo"],
  execution: ["azione", "prossimi passi", "follow-up", "task", "operativo", "chiudere"]
};

const personalKeywords = [
  "matrimonio", "fidanz", "famiglia", "figli", "sessual", "salute", "ansia", "depression",
  "fertilit", "religione", "politica", "mutuo", "patrimonio", "casa", "vacanza", "viaggio",
  "geolocalizzazione", "processo legale", "terapia", "medico"
];

const technologyReasoningSignals = [
  {
    id: "tech_debugging",
    label: "Debugging",
    terms: ["bug", "errore", "error", "causa", "root cause", "stack trace", "log", "riprodurre", "reproduce", "fix"],
    summary: "Indaga cause, sintomi e impatto prima di proporre una correzione.",
    risk: "Con poche evidenze non misura la capacita' di debug in produzione, ma solo il ragionamento osservabile in chat."
  },
  {
    id: "tech_testing",
    label: "Testing mindset",
    terms: ["test", "edge case", "caso limite", "regression", "coverage", "unit test", "integrazione", "qa"],
    summary: "Mostra attenzione a test, regressioni, casi limite e verifica delle soluzioni.",
    risk: "La presenza di richieste di test non prova da sola qualita' del codice o copertura reale."
  },
  {
    id: "tech_architecture",
    label: "Architecture reasoning",
    terms: ["architettura", "architecture", "scalabil", "servizio", "microserv", "database", "api", "caching", "queue", "dipenden"],
    summary: "Ragiona su componenti, dipendenze, trade-off architetturali e integrazioni.",
    risk: "Va letto come evidenza di ragionamento architetturale, non come certificazione di seniority."
  },
  {
    id: "tech_security",
    label: "Security awareness",
    terms: ["security", "sicurezza", "token", "secret", "password", "credential", "privacy", "encrypt", "auth", "permission", "accesso"],
    summary: "Considera credenziali, permessi, dati sensibili e rischi di esposizione.",
    risk: "La cautela sulla sicurezza non equivale a una valutazione completa di competenze security."
  },
  {
    id: "tech_operations",
    label: "Operational reliability",
    terms: ["deploy", "rollback", "monitoring", "alert", "incident", "uptime", "timeout", "retry", "fallback", "performance"],
    summary: "Collega le scelte tecniche a rilascio, monitoraggio, resilienza e continuita' operativa.",
    risk: "Serve evidenza esterna per distinguere ragionamento operativo e responsabilita' effettiva su sistemi live."
  },
  {
    id: "tech_data_api",
    label: "Data & API thinking",
    terms: ["sql", "dataset", "schema", "payload", "endpoint", "api", "json", "metric", "kpi", "validation"],
    summary: "Mostra attenzione a strutture dati, contratti API, validazione e metriche.",
    risk: "I contenuti tecnici incollati non vengono attribuiti direttamente all'utente."
  }
];

function sanitizeProfileName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 120);
}

function sanitizedFilenameName(value) {
  return sanitizeProfileName(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 80) || "profile";
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());
}

function normalizeReportConfig(input = {}) {
  const profileName = sanitizeProfileName(input.profile_name);
  const selectedMonths = Number(input.selected_months);
  const generatedAt = isIsoDate(input.generated_at) ? input.generated_at : new Date().toISOString().slice(0, 10);
  const periodTo = isIsoDate(input.period_to) ? input.period_to : generatedAt;
  const periodFrom = isIsoDate(input.period_from) ? input.period_from : null;
  if (!profileName) throw new Error("Profile name is required.");
  if (!Number.isInteger(selectedMonths) || selectedMonths < 1 || selectedMonths > 12) throw new Error("Analysis period must be between 1 and 12 months.");
  if (!periodFrom || !periodTo) throw new Error("Valid period dates are required.");
  return {
    profile_name: profileName,
    selected_months: selectedMonths,
    period_from: periodFrom,
    period_to: periodTo,
    generated_at: generatedAt,
    generated_for: `Professional Evidence Profile - ${profileName}`,
    sanitized_profile_name: sanitizedFilenameName(profileName)
  };
}

function dateInRange(value, config) {
  if (!config || !value) return true;
  const date = String(value).slice(0, 10);
  if (!isIsoDate(date)) return true;
  return date >= config.period_from && date <= config.period_to;
}

function filterByReportPeriod(conversations, config) {
  if (!config) return conversations;
  return conversations.filter(conversation =>
    dateInRange(conversation.created_at, config) || dateInRange(conversation.updated_at, config)
  );
}

const evidenceStatuses = [
  "insufficient_evidence",
  "counter_evidence_only",
  "emerging",
  "observed",
  "recurring",
  "strongly_supported",
  "mixed_evidence"
];

const sourceProvenanceWeights = {
  original_user_input: 1.0,
  pasted_code_authored_by_user: 1.0,
  pasted_email_authored_by_user: 0.9,
  mixed_content: 0.6,
  unknown: 0.3,
  pasted_external_document: 0.2,
  pasted_job_description: 0.1,
  ai_generated_text: 0.1,
  pasted_code: 0.35,
  pasted_email: 0.35
};

const domainStopWords = new Set([
  "about", "above", "after", "again", "against", "all", "also", "and", "any", "are", "because", "been", "before",
  "being", "between", "both", "but", "can", "cannot", "come", "could", "does", "doing", "done", "for", "from",
  "have", "having", "into", "more", "most", "not", "only", "other", "our", "out", "over", "should", "than",
  "that", "the", "their", "then", "there", "these", "this", "those", "through", "under", "user", "using", "was",
  "were", "when", "where", "which", "while", "with", "work", "would", "your",
  "abbiamo", "anche", "ancora", "avere", "bisogna", "come", "con", "cosa", "dalla", "dalle", "dallo", "degli",
  "dei", "del", "della", "delle", "deve", "devo", "dove", "essere", "fare", "fatto", "gli", "hai", "hanno",
  "nel", "nella", "nelle", "non", "per", "pero", "perche", "piu", "poi", "posso", "questa", "queste", "questi",
  "questo", "sia", "sono", "sta", "sul", "sulla", "tra", "una", "uno", "user", "utente", "voglio"
]);

const genericDomainTerms = new Set([
  "analysis", "analisi", "assistant", "chatgpt", "claim", "confidence", "content", "conversation", "conversazione",
  "counter", "dimension", "evidence", "file", "generare", "generato", "json", "lavoro", "message", "professional",
  "profilo", "profile", "report", "richiesta", "schema", "summary", "supporting", "testo"
]);

const canonicalProfessionalDimensions = [
  {
    id: "decision_making",
    label: "Decision making",
    support: ["decision", "decidere", "decido", "scelta", "scelgo", "trade off", "priorita", "raccomando", "valutare opzioni", "go no go"],
    counter: ["non posso decidere", "aspetto conferma", "lo decide qualcun altro", "non voglio decidere"],
    description: "Evidence of making, structuring or owning professional decisions."
  },
  {
    id: "problem_solving",
    label: "Problem solving",
    support: ["problema", "root cause", "causa", "diagnosi", "soluzione", "opzioni", "vincolo", "risolvere", "scomporre", "analizzare"],
    counter: ["non so risolvere", "non capisco il problema", "bloccato"],
    description: "Evidence of decomposing problems, identifying causes and shaping solutions."
  },
  {
    id: "communication",
    label: "Communication",
    support: ["comunicare", "messaggio", "email", "tono", "presentazione", "feedback", "stakeholder", "spiegare", "allineare", "chiarezza"],
    counter: ["non so comunicarlo", "non riesco a spiegarlo", "messaggio non chiaro"],
    description: "Evidence of adapting, clarifying or managing professional communication."
  },
  {
    id: "execution",
    label: "Execution",
    support: ["eseguire", "implementare", "consegnare", "delivery", "azione", "prossimi passi", "operativo", "mettere a terra", "adattare", "gestire durante"],
    counter: ["non implemento", "non eseguo", "resta teorico"],
    description: "Evidence of applying, adapting or delivering work in practice."
  },
  {
    id: "leadership",
    label: "Leadership",
    support: ["guidare", "leadership", "responsabilita", "delegare", "coordinare", "indirizzare", "governance", "motivare", "decidere per il team"],
    counter: ["non guido", "non coordino", "non ho responsabilita"],
    description: "Evidence of guiding people, direction or responsibility."
  },
  {
    id: "collaboration",
    label: "Collaboration",
    support: ["collaborare", "team", "allineamento", "coinvolgere", "confronto", "stakeholder", "insieme", "coordinamento", "partner"],
    counter: ["da solo", "senza confronto", "non collaboro"],
    description: "Evidence of working with others, aligning stakeholders or coordinating collaboration."
  },
  {
    id: "planning",
    label: "Planning",
    support: ["pianificare", "roadmap", "timeline", "milestone", "priorita", "sequenza", "scope", "risorse", "deadline"],
    counter: ["senza piano", "non pianificato", "piano non chiaro"],
    description: "Evidence of planning, sequencing, scoping or prioritizing work."
  },
  {
    id: "learning",
    label: "Learning",
    support: ["imparare", "capire", "approfondire", "feedback", "migliorare", "lesson learned", "sperimentare", "iterare"],
    counter: ["non voglio imparare", "non approfondisco"],
    description: "Evidence of learning, adapting from feedback or improving understanding."
  },
  {
    id: "domain_knowledge",
    label: "Domain knowledge",
    support: ["conoscenza", "competenza", "expertise", "normativa", "processo", "mercato", "settore", "pratica", "metodologia"],
    counter: ["non conosco il dominio", "mi manca conoscenza", "serve esperto"],
    description: "Evidence of applying domain knowledge without assuming a specific profession."
  },
  {
    id: "data_reasoning",
    label: "Data reasoning",
    support: ["dato", "data", "metric", "kpi", "misurare", "analisi dati", "dataset", "schema", "payload", "api", "validation", "validazione", "evidenza quantitativa"],
    counter: ["non so leggere il dato", "manca dato", "dato non affidabile"],
    description: "Evidence of reasoning with data, metrics, measurement or validation."
  },
  {
    id: "risk_awareness",
    label: "Risk awareness",
    support: ["rischio", "mitigare", "impatto", "dipendenza", "compliance", "sicurezza", "errore", "criticita", "scenario"],
    counter: ["non considero rischi", "ignoro il rischio"],
    description: "Evidence of identifying, evaluating or mitigating risk."
  },
  {
    id: "quality_improvement",
    label: "Quality improvement",
    support: ["qualita", "miglioramento", "review", "test", "controllo", "standard", "retrospettiva", "ottimizzare", "validare"],
    counter: ["non controllo qualita", "nessuna review"],
    description: "Evidence of improving quality, standards, review or validation."
  }
];

const temporalMaturityDimensions = canonicalProfessionalDimensions;

const capabilityStageSignals = [
  { id: "recognizes_concepts", label: "Recognizes concepts", terms: ["capisco", "spiegami", "concetto", "significa", "comprendere", "difference between", "come funziona", "api", "database", "architettura"] },
  { id: "asks_relevant_questions", label: "Asks relevant questions", terms: ["domande", "chiedere", "capire", "clarify", "chiarire", "quali domande", "cosa devo chiedere", "edge case"] },
  { id: "applies_with_guidance", label: "Applies with guidance", terms: ["con il supporto", "con aiuto", "aiutami", "assistenza", "guided", "adattare", "applicare questa logica"] },
  { id: "applies_independently", label: "Applies independently", terms: ["applico", "propongo", "definisco", "validiamo", "uso questo criterio", "imposto", "scelgo", "decido"] },
  { id: "designs_or_governs_solutions", label: "Designs or governs solutions", terms: ["governo", "governance", "team tecnico", "developer", "fornitori", "review", "criteri", "accettazione", "delivery", "architetturale"] },
  { id: "reviews_or_teaches_others", label: "Reviews or teaches others", terms: ["review", "revisiono", "spiego al team", "insegno", "coaching", "linee guida", "standard"] }
];

const sensitivePatterns = [
  { label: "EMAIL_REDACTED", regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { label: "PHONE_REDACTED", regex: /(?:(?:\+|00)\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?){2,5}\d{2,4}/g },
  { label: "API_KEY_REDACTED", regex: /\b(?:sk|pk|ghp|gho|xoxb|AIza)[A-Za-z0-9_\-]{16,}\b/g },
  { label: "PASSWORD_REDACTED", regex: /\b(password|passwd|pwd|token|secret|api[_ -]?key)\s*[:=]\s*["']?[^"'\s,;]{6,}/gi },
  { label: "FISCAL_ID_REDACTED", regex: /\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]\b/gi },
  { label: "FINANCIAL_DATA_REDACTED", regex: /\b(?:IBAN\s*)?[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g }
];

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function serveStatic(req, res) {
  const urlPath = req.url === "/" ? "/index.html" : decodeURIComponent(req.url.split("?")[0]);
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8"
    };
    res.writeHead(200, {
      "content-type": types[ext] || "application/octet-stream",
      "cache-control": "no-store, max-age=0"
    });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        reject(new Error("File too large. Limit is 40 MB."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function extractZipFiles(buffer) {
  const files = [];
  let offset = 0;
  while (offset + 30 < buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) {
      offset += 1;
      continue;
    }
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileSize = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = buffer.slice(nameStart, nameStart + nameLength).toString("utf8");
    const compressed = buffer.slice(dataStart, dataStart + compressedSize);
    if (compressedSize > 0 && !name.endsWith("/")) {
      let data;
      if (method === 0) data = compressed;
      if (method === 8) data = zlib.inflateRawSync(compressed);
      if (data && data.length === fileSize) files.push({ name, data });
    }
    offset = dataStart + compressedSize;
  }
  return files;
}

function parseUpload(buffer, fileName) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".zip")) {
    const files = extractZipFiles(buffer);
    const conversations = files.find(file => /(^|\/)conversations\.json$/i.test(file.name)) ||
      files.find(file => file.name.toLowerCase().endsWith(".json"));
    if (!conversations) throw new Error("No conversations.json file found in ZIP.");
    return JSON.parse(conversations.data.toString("utf8"));
  }
  return JSON.parse(buffer.toString("utf8"));
}

function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!match) throw new Error("Missing multipart boundary.");
  const boundary = Buffer.from("--" + (match[1] || match[2]));
  const parts = [];
  let start = buffer.indexOf(boundary);
  while (start !== -1) {
    start += boundary.length;
    if (buffer[start] === 45 && buffer[start + 1] === 45) break;
    if (buffer[start] === 13 && buffer[start + 1] === 10) start += 2;
    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), start);
    if (headerEnd === -1) break;
    const headers = buffer.slice(start, headerEnd).toString("utf8");
    let dataEnd = buffer.indexOf(boundary, headerEnd + 4);
    if (dataEnd === -1) break;
    if (buffer[dataEnd - 2] === 13 && buffer[dataEnd - 1] === 10) dataEnd -= 2;
    const filenameMatch = /filename="([^"]+)"/i.exec(headers);
    const nameMatch = /name="([^"]+)"/i.exec(headers);
    parts.push({
      field: nameMatch ? nameMatch[1] : "",
      filename: filenameMatch ? filenameMatch[1] : "",
      data: buffer.slice(headerEnd + 4, dataEnd)
    });
    start = buffer.indexOf(boundary, dataEnd);
  }
  return parts;
}

function normalizeChatGptExport(raw) {
  if (raw && raw.schema === "professional_evidence_pack_v1") {
    return normalizeEvidencePack(raw);
  }
  const list = Array.isArray(raw) ? raw : raw.conversations || [];
  return list.map((conversation, index) => {
    const messages = [];
    if (conversation.mapping && typeof conversation.mapping === "object") {
      const nodes = Object.values(conversation.mapping);
      const ordered = nodes
        .filter(node => node && node.message)
        .sort((a, b) => (a.message.create_time || 0) - (b.message.create_time || 0));
      for (const node of ordered) {
        const message = node.message;
        const parts = message.content && Array.isArray(message.content.parts) ? message.content.parts : [];
        const text = parts.map(part => typeof part === "string" ? part : JSON.stringify(part)).join("\n").trim();
        if (!text) continue;
        messages.push({
          id: message.id || node.id || crypto.randomUUID(),
          author: message.author && message.author.role ? message.author.role : "unknown",
          created_at: message.create_time ? new Date(message.create_time * 1000).toISOString() : null,
          text,
          content_origin: detectContentOrigin(text, message.author && message.author.role)
        });
      }
    } else if (Array.isArray(conversation.messages)) {
      for (const message of conversation.messages) {
        const text = String(message.text || message.content || "").trim();
        if (!text) continue;
        messages.push({
          id: message.id || crypto.randomUUID(),
          author: message.author || message.role || "unknown",
          created_at: message.created_at || message.timestamp || null,
          text,
          content_origin: typeof message.content_origin === "object"
            ? message.content_origin
            : detectContentOrigin(text, message.author || message.role)
        });
      }
    }
    const created = conversation.create_time ? new Date(conversation.create_time * 1000).toISOString() :
      conversation.created_at || messages.find(m => m.created_at)?.created_at || null;
    const updated = conversation.update_time ? new Date(conversation.update_time * 1000).toISOString() :
      conversation.updated_at || messages.slice().reverse().find(m => m.created_at)?.created_at || created;
    const normalized = {
      id: conversation.id || `conversation_${index + 1}`,
      title: conversation.title || `Conversation ${index + 1}`,
      created_at: created,
      updated_at: updated,
      messages
    };
    return { ...normalized, ...classifyConversation(normalized) };
  });
}

function normalizeEvidencePack(pack) {
  const conversations = Array.isArray(pack.conversations) ? pack.conversations : [];
  return conversations.map((conversation, index) => {
    const evidenceText = Array.isArray(conversation.evidence)
      ? conversation.evidence.map(item => [
        item.dimension ? `Dimension: ${item.dimension}` : "",
        item.candidate_concept ? `Candidate: ${item.candidate_concept}` : "",
        item.candidate_type ? `Candidate type: ${item.candidate_type}` : "",
        item.display_label ? `Display label: ${item.display_label}` : "",
        item.claim ? `Claim: ${item.claim}` : "",
        item.supporting_excerpt ? `Evidence: ${item.supporting_excerpt}` : "",
        item.counter_evidence ? `Counter-evidence: ${item.counter_evidence}` : ""
      ].filter(Boolean).join("\n")).join("\n\n")
      : "";
    const text = [
      conversation.summary || "",
      conversation.content_origin_notes ? `Content origin: ${conversation.content_origin_notes}` : "",
      evidenceText
    ].filter(Boolean).join("\n\n").trim();
    const normalized = {
      id: conversation.id || `pack_conversation_${index + 1}`,
      title: conversation.title || `Evidence Pack Conversation ${index + 1}`,
      created_at: conversation.date || pack.generated_at || null,
      updated_at: conversation.date || pack.generated_at || null,
      messages: [{
        id: `pack_message_${index + 1}`,
        author: "user",
        created_at: conversation.date || pack.generated_at || null,
        text,
        content_origin: {
          value: conversation.content_origin_notes || "mixed_content",
          confidence: 0.55,
          contains_pasted_external_content: String(conversation.content_origin_notes || "").includes("pasted")
        }
      }],
      source: {
        schema: pack.schema,
        generated_for: pack.generated_for,
        verification: pack.source && pack.source.verification ? pack.source.verification : "user_provided_not_verified"
      }
    };
    const classified = classifyConversation(normalized);
    return {
      ...normalized,
      ...classified,
      classification: ["professional", "mixed", "uncertain"].includes(conversation.classification)
        ? conversation.classification
        : classified.classification,
      professional_category: conversation.professional_category || classified.professional_category,
      classification_reason: "Professional Evidence Pack import: sintesi fornita dall'utente, da rivedere prima dell'analisi."
    };
  });
}

function detectContentOrigin(text, author) {
  if (author !== "user") {
    return { value: "ai_generated_text", confidence: 0.85, contains_pasted_external_content: false };
  }
  const longLines = text.split(/\r?\n/).filter(line => line.length > 120).length;
  const pastedHints = [
    /inoltr/i, /forwarded message/i, /da:\s.+\n.*a:\s/gi, /subject:/i, /oggetto:/i,
    /curriculum vitae/i, /job description/i, /requisiti:/i, /responsabilit/i,
    /```[\s\S]+```/m, /function\s+\w+\(/, /class\s+\w+/
  ];
  if (/```[\s\S]+```/m.test(text) || /function\s+\w+\(/.test(text)) {
    return { value: "pasted_code", confidence: 0.78, contains_pasted_external_content: true };
  }
  if (/job description|annuncio di lavoro|descrizione della posizione|requirements\s*:|responsabilit[aà]\s*:/i.test(text)) {
    return { value: "pasted_job_description", confidence: 0.72, contains_pasted_external_content: true };
  }
  if (/da:\s.+\n.*a:\s|from:\s.+\n.*to:\s|oggetto:|subject:/i.test(text)) {
    return { value: "pasted_email", confidence: 0.75, contains_pasted_external_content: true };
  }
  if (longLines >= 3 || pastedHints.some(regex => regex.test(text))) {
    return { value: "pasted_external_document", confidence: 0.62, contains_pasted_external_content: true };
  }
  return { value: "original_user_input", confidence: 0.68, contains_pasted_external_content: false };
}

function classifyConversation(conversation) {
  const userText = conversation.messages
    .filter(message => message.author === "user")
    .map(message => message.text)
    .join("\n")
    .toLowerCase();
  const allText = conversation.messages.map(message => message.text).join("\n").toLowerCase();
  const professionalHits = [];
  for (const [category, words] of Object.entries(professionalKeywords)) {
    const score = words.reduce((sum, word) => sum + (allText.includes(word) ? 1 : 0), 0);
    if (score > 0) professionalHits.push({ category, score });
  }
  professionalHits.sort((a, b) => b.score - a.score);
  const personalScore = personalKeywords.reduce((sum, word) => sum + (allText.includes(word) ? 1 : 0), 0);
  const sensitive = detectSensitive(allText);
  const proScore = professionalHits.reduce((sum, item) => sum + item.score, 0);
  let classification = "uncertain";
  if (sensitive.hasHighRiskSensitive && proScore === 0) classification = "excluded_sensitive";
  else if (personalScore >= 2 && proScore === 0) classification = "personal";
  else if (proScore >= 2 && personalScore === 0) classification = "professional";
  else if (proScore > 0 && personalScore > 0) classification = "mixed";
  else if (proScore === 1) classification = "uncertain";
  const approved = classification === "professional";
  const confidence = Math.min(0.95, Math.max(0.35, 0.42 + proScore * 0.08 + personalScore * 0.05));
  return {
    classification,
    approved,
    professional_category: professionalHits[0] ? professionalHits[0].category : "uncategorized",
    confidence: Number(confidence.toFixed(2)),
    sensitive_flags: sensitive.flags,
    classification_reason: buildReason(classification, professionalHits, personalScore, userText.length)
  };
}

function detectSensitive(text) {
  const flags = [];
  for (const pattern of sensitivePatterns) {
    if (pattern.regex.test(text)) flags.push(pattern.label);
    pattern.regex.lastIndex = 0;
  }
  const highRiskTerms = ["salute", "terapia", "figli", "minore", "religione", "sessual", "politica"];
  for (const term of highRiskTerms) {
    if (text.includes(term)) flags.push("SENSITIVE_CONTEXT");
  }
  return { flags: [...new Set(flags)], hasHighRiskSensitive: flags.includes("SENSITIVE_CONTEXT") };
}

function buildReason(classification, professionalHits, personalScore, length) {
  if (classification === "professional") {
    return `Rilevati segnali professionali prevalenti: ${professionalHits.slice(0, 3).map(x => x.category).join(", ")}.`;
  }
  if (classification === "mixed") return "Rilevati sia segnali professionali sia elementi personali: richiede revisione.";
  if (classification === "personal") return "Prevalgono indicatori personali o privati.";
  if (classification === "excluded_sensitive") return "Contiene elementi sensibili e non mostra un chiaro contesto professionale.";
  if (length < 80) return "Testo insufficiente per una classificazione affidabile.";
  return "Segnali professionali deboli o ambigui: richiede conferma.";
}

function redactText(text) {
  let redacted = text;
  const replacements = [];
  for (const pattern of sensitivePatterns) {
    redacted = redacted.replace(pattern.regex, match => {
      replacements.push({ type: pattern.label, sample_length: match.length });
      return `[${pattern.label}]`;
    });
  }
  redacted = redacted.replace(/\b([A-Z][a-z]{2,}\s+[A-Z][a-z]{2,})\b/g, match => {
    const common = ["Professional Evidence", "Chat Gpt", "New York", "San Francisco"];
    if (common.includes(match)) return match;
    replacements.push({ type: "PERSON_REDACTED", sample_length: match.length });
    return "[PERSON_1]";
  });
  redacted = redacted.replace(/\b([A-Z][A-Za-z0-9&.-]{2,}\s+(?:Srl|SRL|Spa|SpA|Ltd|Inc|GmbH|LLC))\b/g, match => {
    replacements.push({ type: "COMPANY_REDACTED", sample_length: match.length });
    return "[COMPANY_1]";
  });
  return { text: redacted, replacements };
}

function buildNormalized(conversations, decisions) {
  const decisionMap = new Map((decisions || []).map(item => [item.id, item]));
  const selected = [];
  for (const conversation of conversations) {
    const decision = decisionMap.get(conversation.id);
    const approved = decision ? decision.include : conversation.approved;
    const classification = decision && decision.classification ? decision.classification : conversation.classification;
    if (!approved || ["personal", "excluded_sensitive"].includes(classification)) continue;
    const redactedMessages = conversation.messages.map(message => {
      const redacted = redactText(message.text);
      return { ...message, text: redacted.text, redactions: redacted.replacements };
    });
    selected.push({
      ...conversation,
      classification,
      approved: true,
      messages: redactedMessages
    });
  }
  return selected;
}

function dateRange(conversations) {
  const dates = conversations.flatMap(c => [c.created_at, c.updated_at])
    .filter(Boolean)
    .map(value => new Date(value))
    .filter(date => !Number.isNaN(date.getTime()))
    .sort((a, b) => a - b);
  if (!dates.length) return { first: null, last: null, months_covered: 0, recent_percentage: 0 };
  const first = dates[0];
  const last = dates[dates.length - 1];
  const months = Math.max(1, Math.round((last - first) / (1000 * 60 * 60 * 24 * 30)));
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 12);
  const recentCount = dates.filter(date => date >= cutoff).length;
  return {
    first: first.toISOString().slice(0, 10),
    last: last.toISOString().slice(0, 10),
    months_covered: months,
    recent_percentage: Math.round((recentCount / dates.length) * 100)
  };
}

function generateInsights(conversations) {
  if (!conversations.length) return [];
  const dimensions = [
    {
      id: "problem_solving",
      title: "Scomposizione dei problemi",
      terms: ["problema", "causa", "opzioni", "vincolo", "soluzione", "step", "dipenden"],
      positive: "Tende a trasformare problemi ampi in componenti analizzabili e passi successivi.",
      risk: "Quando le alternative sono molte, puo' ampliare il perimetro prima di convergere."
    },
    {
      id: "communication",
      title: "Adattamento della comunicazione",
      terms: ["tono", "email", "messaggio", "stakeholder", "cliente", "presentazione", "feedback"],
      positive: "Mostra attenzione a destinatario, tono e possibile interpretazione del messaggio.",
      risk: "In contesti a basso rischio puo' investire piu' tempo del necessario nella revisione."
    },
    {
      id: "execution",
      title: "Orientamento ai prossimi passi",
      terms: ["prossimi passi", "azione", "task", "follow-up", "deadline", "chiudere", "operativo"],
      positive: "Collega spesso analisi e attivita' operative concrete.",
      risk: "La qualita' dell'esecuzione dipende dalla chiarezza delle priorita' iniziali."
    },
    {
      id: "leadership",
      title: "Strutturazione del lavoro di team",
      terms: ["team", "ruoli", "delega", "responsabilit", "conflitto", "manager", "allineamento"],
      positive: "Cerca struttura, ruoli chiari e allineamento tra le persone coinvolte.",
      risk: "In situazioni ambigue puo' cercare consenso prima di fissare una direzione definitiva."
    },
    {
      id: "strategy",
      title: "Pensiero strategico",
      terms: ["strategia", "roadmap", "priorit", "obiettivo", "rischio", "dipenden", "trade-off"],
      positive: "Collega decisioni operative, obiettivi e conseguenze future.",
      risk: "Il ragionamento sistemico puo' rallentare decisioni che richiedono una scelta rapida."
    },
    {
      id: "technology_reasoning",
      title: "Ragionamento tecnico osservabile",
      terms: technologyReasoningSignals.flatMap(signal => signal.terms),
      positive: "Nelle conversazioni tecniche approvate emergono segnali di analisi tecnica, trade-off e attenzione alla qualita' della soluzione.",
      risk: "Non valuta repository, codice proprietario o seniority complessiva: misura solo ragionamento tecnico osservabile nelle chat selezionate."
    }
  ];
  const allMessages = conversations.flatMap(c => c.messages.map(m => ({ ...m, conversation: c })));
  const insights = [];
  for (const dimension of dimensions) {
    const evidence = allMessages
      .filter(message => message.author === "user")
      .filter(message => dimension.terms.some(term => message.text.toLowerCase().includes(term)))
      .slice(0, 6)
      .map(message => ({
        conversation_id: message.conversation.id,
        conversation_title: message.conversation.title,
        date: message.created_at || message.conversation.created_at,
        excerpt: message.text.slice(0, 280)
      }));
    if (evidence.length < 1) continue;
    insights.push({
      id: `insight_${String(insights.length + 1).padStart(3, "0")}`,
      dimension: dimension.id,
      title: dimension.title,
      summary: dimension.positive,
      positive_interpretation: dimension.positive,
      risk_interpretation: dimension.risk,
      confidence: evidence.length >= 4 ? "high" : evidence.length >= 2 ? "medium" : "low",
      evidence_count: evidence.length,
      first_observed_at: evidence.map(e => e.date).filter(Boolean).sort()[0] || null,
      last_observed_at: evidence.map(e => e.date).filter(Boolean).sort().slice(-1)[0] || null,
      temporal_status: "observed",
      evidence_for: evidence.slice(0, 4),
      evidence_against: [],
      user_status: "pending",
      user_comment: "",
      public_visibility: true
    });
  }

  const categoryTemplates = {
    strategy: {
      dimension: "strategy",
      title: "Orientamento strategico",
      summary: "Le conversazioni approvate mostrano attenzione a priorita', obiettivi, dipendenze e conseguenze delle scelte.",
      risk: "Con poche evidenze, questo va letto come segnale iniziale e non come pattern consolidato."
    },
    project_management: {
      dimension: "execution",
      title: "Gestione operativa del lavoro",
      summary: "Emergono segnali di organizzazione del lavoro, gestione dei vincoli e attenzione alla delivery.",
      risk: "Il profilo dovrebbe essere rafforzato con piu' conversazioni su execution e follow-up."
    },
    product_management: {
      dimension: "product_management",
      title: "Ragionamento di prodotto",
      summary: "Le evidenze selezionate indicano attenzione a utenti, perimetro MVP, valore e priorita' di prodotto.",
      risk: "Serve distinguere meglio tra ideazione, validazione e decisioni effettivamente prese."
    },
    technology: {
      dimension: "technology",
      title: "Pensiero tecnico",
      summary: "Le conversazioni approvate mostrano attenzione ad architettura, vincoli tecnici e affidabilita' dei sistemi.",
      risk: "Con dati limitati, la valutazione riguarda il modo di ragionare sui problemi tecnici, non la competenza tecnica complessiva."
    },
    programming: {
      dimension: "programming",
      title: "Debugging e qualita' del codice",
      summary: "Emergono segnali di analisi di bug, test, cause e possibili correzioni.",
      risk: "Il contenuto di codice incollato non viene attribuito direttamente all'utente; conta il comportamento rispetto al codice."
    },
    professional_communication: {
      dimension: "communication",
      title: "Comunicazione professionale",
      summary: "Le evidenze indicano attenzione a tono, chiarezza e destinatario nelle comunicazioni di lavoro.",
      risk: "La cura del messaggio puo' diventare un costo se applicata anche a contesti a basso rischio."
    },
    leadership: {
      dimension: "leadership",
      title: "Struttura e allineamento del team",
      summary: "Le conversazioni selezionate mostrano attenzione a ruoli, responsabilita', stakeholder e coordinamento.",
      risk: "Questo segnale richiede evidenze ulteriori per distinguere leadership diretta, influenza laterale e supporto operativo."
    },
    recruiting: {
      dimension: "recruiting",
      title: "Valutazione professionale",
      summary: "Sono presenti evidenze legate a colloqui, profili, requisiti o criteri di valutazione.",
      risk: "CV e job description incollati non devono essere usati per inferire tratti dell'utente."
    },
    execution: {
      dimension: "execution",
      title: "Orientamento all'azione",
      summary: "Le conversazioni approvate contengono segnali di passaggio da analisi a prossimi passi concreti.",
      risk: "Serve verificare con evidenze recenti se l'orientamento all'azione e' stabile nel tempo."
    }
  };

  const existingDimensions = new Set(insights.map(insight => insight.dimension));
  for (const conversation of conversations) {
    const template = categoryTemplates[conversation.professional_category];
    if (!template || existingDimensions.has(template.dimension)) continue;
    const userMessage = conversation.messages.find(message => message.author === "user");
    if (!userMessage) continue;
    insights.push({
      id: `insight_${String(insights.length + 1).padStart(3, "0")}`,
      dimension: template.dimension,
      title: template.title,
      summary: template.summary,
      positive_interpretation: template.summary,
      risk_interpretation: template.risk,
      confidence: "low",
      evidence_count: 1,
      first_observed_at: userMessage.created_at || conversation.created_at,
      last_observed_at: userMessage.created_at || conversation.updated_at || conversation.created_at,
      temporal_status: "emerging",
      evidence_for: [{
        conversation_id: conversation.id,
        conversation_title: conversation.title,
        date: userMessage.created_at || conversation.created_at,
        excerpt: userMessage.text.slice(0, 280)
      }],
      evidence_against: [],
      user_status: "pending",
      user_comment: "",
      public_visibility: true
    });
    existingDimensions.add(template.dimension);
    if (insights.length >= 8) break;
  }

  return insights.slice(0, 8);
}

function buildTechnologyReasoning(normalized, insights, publicOnly = false) {
  const visibleInsights = publicOnly ? insights.filter(insight => insight.public_visibility) : insights;
  const visibleEvidenceIds = new Set(
    visibleInsights.flatMap(insight => (insight.evidence_for || []).map(evidence => evidence.conversation_id))
  );
  const sourceConversations = normalized.filter(conversation => {
    if (!visibleInsights.length) return !publicOnly;
    return visibleEvidenceIds.has(conversation.id) || !publicOnly;
  });
  const userMessages = sourceConversations.flatMap(conversation =>
    conversation.messages
      .filter(message => message.author === "user")
      .map(message => ({ ...message, conversation }))
  );

  const signals = technologyReasoningSignals.map(signal => {
    const evidence = userMessages
      .filter(message => signal.terms.some(term => message.text.toLowerCase().includes(term)))
      .slice(0, 4)
      .map(message => ({
        conversation_id: message.conversation.id,
        conversation_title: message.conversation.title,
        date: message.created_at || message.conversation.created_at,
        excerpt: message.text.slice(0, 240),
        content_origin: message.content_origin
      }));
    const externalCount = evidence.filter(item => item.content_origin && item.content_origin.contains_pasted_external_content).length;
    const strength = evidence.length >= 4 ? 82 : evidence.length === 3 ? 68 : evidence.length === 2 ? 52 : evidence.length === 1 ? 34 : 0;
    return {
      id: signal.id,
      label: signal.label,
      summary: signal.summary,
      risk: signal.risk,
      strength,
      level: strength >= 70 ? "strongly supported" : strength >= 50 ? "recurring" : strength >= 30 ? "observed" : "not observed",
      evidence_count: evidence.length,
      external_content_count: externalCount,
      evidence,
      public_visibility: true
    };
  });

  const observed = signals.filter(signal => signal.evidence_count > 0);
  return {
    title: "Technology Reasoning",
    scope: "Basato solo su conversazioni approvate e anonimizzate. Non accede a repository e non copia codice proprietario.",
    signals,
    observed_count: observed.length,
    evidence_count: observed.reduce((sum, signal) => sum + signal.evidence_count, 0),
    top_signals: observed.slice().sort((a, b) => b.strength - a.strength).slice(0, 3)
  };
}

function includesAny(text, terms) {
  return terms.some(term => text.includes(term.toLowerCase()));
}

function matchedTerms(text, terms) {
  return terms.filter(term => text.includes(term.toLowerCase()));
}

function sourceValue(message) {
  return message.content_origin && message.content_origin.value ? message.content_origin.value : "unknown";
}

function sourceWeight(message) {
  return sourceProvenanceWeights[sourceValue(message)] ?? 0.3;
}

function canCreateCapabilityClaim(message) {
  const value = sourceValue(message);
  return !["pasted_external_document", "pasted_job_description", "ai_generated_text"].includes(value);
}

function normalizeDomainTerm(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_/-]+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function domainTokens(text) {
  return normalizeDomainTerm(text)
    .split(" ")
    .filter(token =>
      token.length >= 4 &&
      !domainStopWords.has(token) &&
      !genericDomainTerms.has(token) &&
      !/^\d+$/.test(token)
    );
}

function domainPhrases(text) {
  const tokens = domainTokens(text).slice(0, 120);
  const phrases = [];
  for (let index = 0; index < tokens.length; index += 1) {
    phrases.push(tokens[index]);
    if (tokens[index + 1]) phrases.push(`${tokens[index]} ${tokens[index + 1]}`);
  }
  return phrases;
}

function domainId(label) {
  return `domain_${normalizeDomainTerm(label).replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "").slice(0, 42)}`;
}

function domainLabel(value) {
  return normalizeDomainTerm(value)
    .split(" ")
    .slice(0, 3)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function evidenceTextForSemanticExtraction(text) {
  const lines = String(text || "").split(/\r?\n/);
  const claimLines = [];
  const metadataPrefixes = /^(dimension|content origin|source|schema|generated_for|generated_at|classification|professional_category)\s*:/i;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || metadataPrefixes.test(trimmed)) continue;
    const evidenceMatch = /^(claim|evidence|supporting excerpt|supporting_excerpt|candidate|candidate_concept|display label|display_label)\s*:\s*(.+)$/i.exec(trimmed);
    if (evidenceMatch) claimLines.push(evidenceMatch[2]);
  }
  if (claimLines.length) return claimLines.join(". ");
  return lines.filter(line => !metadataPrefixes.test(line.trim())).join("\n");
}

function classifyCandidateSemanticType(candidate, sentence) {
  const candidateText = normalizeDomainTerm(candidate);
  const text = normalizeDomainTerm(`${candidate} ${sentence}`);
  if (/\b(source|origin|schema|json|file|conversation|metadata|generated|confidence)\b/.test(text)) return "metadata";
  if (/\b(user|assistant|stakeholder|cliente|team|manager|actor)\b/.test(text) && text.split(" ").length <= 2) return "actor";
  if (/\b(role|ruolo|position|job|titolo)\b/.test(text)) return "role";
  if (/\b(daily|weekly|monthly|often|sempre|frequentemente|ricorrente|occasionale)\b/.test(text)) return "frequency";
  if (candidateText.split(" ").length <= 3 && !/\b(decision|adaptability|coordination|planning|analysis|improvement|leadership|execution|problem|risk|quality|communication|responsibility|judgment|reasoning)\b/.test(candidateText)) return "specialization";
  if (/\b(responsible|responsibility|ownership|owns|gestisce|coordina|guida|responsabilita|governa|supervisiona)\b/.test(text)) return "responsibility";
  if (/\b(adaptability|reasoning|decision|problem solving|problem-solving|planning|communication|leadership|execution|judgment|analysis|prioritization|coordination|improvement|risk awareness|quality|governance|applies|defines|manages|coordinates|adatta|decide|definisce|analizza|pianifica|migliora|comunica|collabora|valuta)\b/.test(text)) return "capability";
  if (/\b(asks|reviews|aligns|prioritizes|validates|monitors|chiede|revisiona|allinea|prioritizza|valida|monitora)\b/.test(text)) return "behavior";
  if (/\b(project|product|clinical|technical|commercial|operational|creative|legal|finance|produzione|documentario)\b/.test(text)) return "domain";
  return "unknown";
}

function mapCandidateToCanonicalDimension(candidate, sentence) {
  const text = normalizeDomainTerm(`${candidate} ${sentence}`);
  let best = { id: "domain_knowledge", score: 0 };
  for (const dimension of canonicalProfessionalDimensions) {
    const score = (dimension.support || []).reduce((sum, term) => {
      const normalizedTerm = normalizeDomainTerm(term);
      return sum + (normalizedTerm && text.includes(normalizedTerm) ? 1 : 0);
    }, 0);
    if (score > best.score) best = { id: dimension.id, score };
  }
  if (best.score > 0) return best.id;
  if (/\b(adaptability|adatta|gestire durante|intraoperative)\b/.test(text)) return "execution";
  if (/\b(decision|scelta|decide|judgment|valuta)\b/.test(text)) return "decision_making";
  if (/\b(problem|causa|diagnosi|solve|risolve)\b/.test(text)) return "problem_solving";
  if (/\b(communicat|spiega|messaggio|tono)\b/.test(text)) return "communication";
  if (/\b(coordina|team|collabora|stakeholder)\b/.test(text)) return "collaboration";
  if (/\b(risk|rischio|mitiga)\b/.test(text)) return "risk_awareness";
  if (/\b(data|metric|kpi|dato|misura)\b/.test(text)) return "data_reasoning";
  if (/\b(quality|qualita|review|migliora|standard)\b/.test(text)) return "quality_improvement";
  return "domain_knowledge";
}

function candidateDisplayLabel(candidate) {
  return normalizeDomainTerm(candidate)
    .split(" ")
    .filter(Boolean)
    .slice(0, 5)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function extractCandidateConceptsFromEvidence(text) {
  const source = evidenceTextForSemanticExtraction(text);
  const sentences = source.split(/[.!?;\n]+/).map(sentence => sentence.trim()).filter(sentence => sentence.length >= 12);
  const candidates = [];
  const capabilityPatterns = [
    /\b([a-zA-Z][a-zA-Z\s-]{2,60}?(?:decision-making|decision making|adaptability|reasoning|planning|communication|leadership|execution|problem-solving|problem solving|coordination|improvement|risk awareness|quality improvement|judgment|analysis|governance))\b/gi,
    /\b((?:clinical|commercial|operational|creative|technical|strategic|intraoperative|cross-functional|data|quality|risk)\s+[a-zA-Z-]{4,30})\b/gi,
    /\b(?:specialization|specialisation|specializzazione|domain|dominio)\s*(?:in|su|:)?\s*([a-zA-Z][a-zA-Z\s-]{3,50})/gi,
    /\b((?:coordino|gestisco|guido|definisco|valuto|analizzo|pianifico|miglioro|comunico|collaboro|adatto)\s+[^,.]{4,70})/gi
  ];
  for (const sentence of sentences) {
    for (const pattern of capabilityPatterns) {
      let match;
      pattern.lastIndex = 0;
      while ((match = pattern.exec(sentence)) !== null) {
        const candidate = match[1].replace(/\s+/g, " ").trim();
        if (candidate.length < 4) continue;
        const semanticType = classifyCandidateSemanticType(candidate, sentence);
        const canonicalDimension = mapCandidateToCanonicalDimension(candidate, sentence);
        candidates.push({
          candidate,
          semantic_type: semanticType,
          radar_eligible: ["capability", "behavior", "responsibility"].includes(semanticType),
          canonical_dimension: canonicalDimension,
          display_label: candidateDisplayLabel(candidate),
          sentence
        });
      }
    }
  }
  return candidates;
}

function semanticGroupKey(candidate) {
  const tokens = domainTokens(candidate.display_label)
    .filter(token => !["clinical", "technical", "strategic", "operational", "creative", "commercial"].includes(token))
    .slice(0, 4);
  return `${candidate.canonical_dimension}:${tokens.join("_") || normalizeDomainTerm(candidate.display_label)}`;
}

function discoverSemanticCapabilityDimensions(normalized) {
  const groups = new Map();
  const rejected = [];
  const messages = normalized.flatMap(conversation =>
    conversation.messages
      .filter(message => message.author === "user")
      .map(message => ({ ...message, conversation, lower: message.text.toLowerCase() }))
  ).filter(message => canCreateCapabilityClaim(message));

  for (const message of messages) {
    const candidates = extractCandidateConceptsFromEvidence(message.text);
    for (const candidate of candidates) {
      const item = {
        ...candidate,
        conversation_id: message.conversation.id,
        conversation_title: message.conversation.title,
        date: message.created_at || message.conversation.created_at,
        excerpt: candidate.sentence.slice(0, 240),
        source: sourceValue(message)
      };
      if (!candidate.radar_eligible) {
        rejected.push(item);
        continue;
      }
      const key = semanticGroupKey(candidate);
      const current = groups.get(key) || {
        key,
        canonical_dimension: candidate.canonical_dimension,
        display_label: candidate.display_label,
        semantic_type: candidate.semantic_type,
        evidence: [],
        conversations: new Set(),
        supportTerms: new Set()
      };
      current.evidence.push(item);
      current.conversations.add(message.conversation.id);
      for (const term of domainPhrases(`${candidate.display_label} ${candidate.sentence}`).slice(0, 12)) current.supportTerms.add(term);
      groups.set(key, current);
    }
  }

  const dimensions = Array.from(groups.values())
    .filter(group => group.evidence.length >= 2 && group.conversations.size >= 2)
    .sort((a, b) => b.conversations.size - a.conversations.size || b.evidence.length - a.evidence.length)
    .map(group => ({
      id: `semantic_${group.canonical_dimension}_${normalizeDomainTerm(group.display_label).replace(/\s+/g, "_").slice(0, 36)}`,
      canonical_dimension: group.canonical_dimension,
      label: group.display_label,
      support: [...new Set([normalizeDomainTerm(group.display_label)].concat(Array.from(group.supportTerms)))].slice(0, 16),
      counter: [],
      mild_limits: [],
      description: `Semantic capability extracted from evidence and mapped to canonical dimension "${group.canonical_dimension}".`,
      derivation: "semantic_capability_extraction",
      derivation_note: "Extracted from claims/supporting excerpts only; metadata, titles and source fields are excluded.",
      semantic_type: group.semantic_type,
      radar_eligible: true,
      discovered_from: {
        term: normalizeDomainTerm(group.display_label),
        canonical_dimension: group.canonical_dimension,
        evidence_count: group.evidence.length,
        conversation_count: group.conversations.size
      }
    }));

  return { dimensions, rejected_candidates: rejected.slice(0, 30) };
}

function evidenceStatusFromCounts(positiveCount, negativeCount, weightedPositive = positiveCount) {
  if (positiveCount === 0 && negativeCount === 0) return "insufficient_evidence";
  if (positiveCount === 0 && negativeCount > 0) return "counter_evidence_only";
  if (positiveCount > 0 && negativeCount > 0) {
    return weightedPositive >= negativeCount * 4 ? "observed" : "mixed_evidence";
  }
  if (weightedPositive >= 8) return "strongly_supported";
  if (weightedPositive >= 4) return "recurring";
  if (weightedPositive >= 2) return "observed";
  return "emerging";
}

function capabilityScoreForStatus(status, weightedPositive, negativeCount) {
  if (["insufficient_evidence", "counter_evidence_only", "mixed_evidence"].includes(status)) return null;
  return Math.max(1, Math.min(100, Math.round((weightedPositive / (weightedPositive + negativeCount + 1)) * 100)));
}

function evidenceCoverageScore(weightedEvidence, uniqueConversationCount) {
  return Math.max(0, Math.min(100, Math.round(Math.min(1, weightedEvidence / 6) * 70 + Math.min(1, uniqueConversationCount / 4) * 30)));
}

function confidenceForProfile(status, positiveCount, negativeCount, uncertainCount, averageSourceWeight, uniqueConversationCount) {
  if (status === "insufficient_evidence") return "low";
  let score = 0;
  score += Math.min(3, positiveCount) * 0.18;
  score += Math.min(3, uniqueConversationCount) * 0.14;
  score += averageSourceWeight * 0.35;
  score -= Math.min(3, negativeCount) * 0.16;
  score -= Math.min(3, uncertainCount) * 0.08;
  if (status === "mixed_evidence" || status === "counter_evidence_only") score -= 0.18;
  if (score >= 0.72) return "high";
  if (score >= 0.42) return "medium";
  return "low";
}

function buildDimensionProfile(dimension, messages, periodKey) {
  const positives = [];
  const negatives = [];
  const uncertain = [];
  const source_breakdown = {
    original_user_input: 0,
    mixed_content: 0,
    ai_generated_text: 0,
    external_content: 0,
    unknown: 0
  };

  for (const message of messages) {
    const value = sourceValue(message);
    if (value === "original_user_input") source_breakdown.original_user_input += 1;
    else if (value === "mixed_content") source_breakdown.mixed_content += 1;
    else if (value === "ai_generated_text") source_breakdown.ai_generated_text += 1;
    else if (["pasted_external_document", "pasted_job_description"].includes(value)) source_breakdown.external_content += 1;
    else source_breakdown.unknown += 1;

    const supportTerms = matchedTerms(message.lower, dimension.support || []);
    const counterTerms = matchedTerms(message.lower, dimension.counter || []);
    const mildTerms = matchedTerms(message.lower, dimension.mild_limits || []);
    const base = {
      id: `${dimension.id}:${periodKey}:${message.conversation.id}:${message.id}`,
      conversation_id: message.conversation.id,
      conversation_title: message.conversation.title,
      date: message.created_at || message.conversation.created_at,
      excerpt: message.text.slice(0, 240),
      source: value,
      source_weight: sourceWeight(message)
    };

    if (supportTerms.length) {
      if (canCreateCapabilityClaim(message)) {
        positives.push({ ...base, matched_terms: supportTerms.slice(0, 8), weight: sourceWeight(message) * Math.min(3, supportTerms.length) });
      } else {
        uncertain.push({ ...base, reason: "source_not_attributable_to_user", matched_terms: supportTerms.slice(0, 8), weight: sourceWeight(message) });
      }
    }
    if (counterTerms.length && canCreateCapabilityClaim(message)) {
      negatives.push({ ...base, matched_terms: counterTerms.slice(0, 8), severity: "direct_limit", weight: Math.min(2, counterTerms.length) });
    }
    if (mildTerms.length && canCreateCapabilityClaim(message)) {
      uncertain.push({ ...base, reason: "mild_limitation", matched_terms: mildTerms.slice(0, 8), weight: 0.5 });
    }
  }

  const weightedPositive = positives.reduce((sum, item) => sum + item.weight, 0);
  const weightedNegative = negatives.reduce((sum, item) => sum + item.weight, 0);
  const uniqueConversationCount = new Set(positives.concat(negatives, uncertain).map(item => item.conversation_id)).size;
  const averageSourceWeight = positives.length
    ? positives.reduce((sum, item) => sum + item.source_weight, 0) / positives.length
    : 0;
  const status = evidenceStatusFromCounts(positives.length, negatives.length, weightedPositive);
  const capability_score = capabilityScoreForStatus(status, weightedPositive, weightedNegative);
  const evidence_coverage = evidenceCoverageScore(
    weightedPositive + weightedNegative + uncertain.reduce((sum, item) => sum + item.weight, 0),
    uniqueConversationCount
  );

  return {
    status,
    capability_score,
    evidence_coverage,
    confidence: confidenceForProfile(status, positives.length, negatives.length, uncertain.length, averageSourceWeight, uniqueConversationCount),
    positive_count: positives.length,
    negative_count: negatives.length,
    uncertain_count: uncertain.length,
    unique_conversation_count: uniqueConversationCount,
    direct_user_evidence_count: positives.filter(item => item.source === "original_user_input").length,
    mixed_source_count: positives.filter(item => item.source === "mixed_content").length,
    ai_generated_count: positives.filter(item => item.source === "ai_generated_text").length,
    external_content_count: positives.filter(item => ["pasted_external_document", "pasted_job_description"].includes(item.source)).length + uncertain.filter(item => item.reason === "source_not_attributable_to_user").length,
    source_breakdown,
    supporting_evidence: positives.slice(0, 4),
    counter_evidence: negatives.slice(0, 4),
    uncertain_evidence: uncertain.slice(0, 4),
    evidence_ids: positives.concat(negatives, uncertain).map(item => item.id)
  };
}

function interpretDimensionStatus(dimension, profile) {
  if (profile.status === "insufficient_evidence") {
    return `There is not enough attributable evidence to assess ${dimension.label}. This does not imply low capability.`;
  }
  if (profile.status === "counter_evidence_only") {
    return `Only explicit limitations were found for ${dimension.label}; treat this as a limit to the evidence, not a capability rating.`;
  }
  if (profile.status === "mixed_evidence") {
    return `${dimension.label} has both supporting evidence and explicit limits. Review the Supported by and Limits excerpts before sharing.`;
  }
  return `${dimension.label} is supported by attributable evidence with ${profile.confidence} confidence.`;
}

function capabilityConsistencyNotes(stages) {
  const notes = [];
  const statusSupported = status => !["insufficient_evidence", "counter_evidence_only"].includes(status);
  for (let i = 0; i < stages.length; i += 1) {
    if (!statusSupported(stages[i].status)) continue;
    const lowerMissing = stages.slice(0, i).filter(stage => stage.status === "insufficient_evidence");
    if (lowerMissing.length) {
      notes.push(`Higher-order evidence exists for "${stages[i].label}", but lower-stage capability is not directly documented.`);
      break;
    }
  }
  return notes;
}

function messageYear(message, conversation) {
  const dateValue = message.created_at || conversation.created_at || conversation.updated_at;
  const date = dateValue ? new Date(dateValue) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return String(date.getFullYear());
}

function maturityFromCounts(supportingCount, counterCount) {
  return evidenceStatusFromCounts(supportingCount, counterCount, supportingCount);
}

function maturityScore(level) {
  const order = {
    insufficient_evidence: 0,
    counter_evidence_only: 0,
    mixed_evidence: 1,
    emerging: 2,
    observed: 3,
    recurring: 4,
    strongly_supported: 5
  };
  return order[level] ?? 0;
}

function confidenceFromCounts(supportingCount, counterCount) {
  const total = supportingCount + counterCount;
  if (total >= 8) return "high";
  if (total >= 4) return "medium";
  if (total >= 1) return "low";
  return "low";
}

function directionFromSeries(years) {
  const observed = years.filter(year => year.positive_count || year.negative_count || year.uncertain_count);
  if (observed.length === 1 && years.length > 1) {
    const first = years[0];
    const last = years[years.length - 1];
    if ((last.positive_count || last.negative_count || last.uncertain_count) && maturityScore(last.status) > maturityScore(first.status)) {
      const delta = maturityScore(last.status) - maturityScore(first.status);
      return delta >= 2 ? "clear growth" : "gradual growth";
    }
  }
  if (observed.length < 2) return "historical comparison unavailable";
  const first = observed[0];
  const last = observed[observed.length - 1];
  const delta = maturityScore(last.status) - maturityScore(first.status);
  if (delta >= 2) return "clear growth";
  if (delta === 1) return "gradual growth";
  if (delta === 0 && last.negative_count < first.negative_count) return "improving confidence";
  if (delta === 0) return "stable";
  if (delta <= -2) return "decline";
  return "slight decline";
}

function extractTemporalEvidence(normalized, publicOnly = false) {
  const userMessages = normalized.flatMap(conversation =>
    conversation.messages
      .filter(message => message.author === "user")
      .map(message => ({
        ...message,
        conversation,
        year: messageYear(message, conversation),
        lower: message.text.toLowerCase()
      }))
  ).filter(message => message.year);

  const years = [...new Set(userMessages.map(message => message.year))].sort();
  const semanticExtraction = discoverSemanticCapabilityDimensions(normalized);
  const semanticDimensions = semanticExtraction.dimensions;
  const allMaturityDimensions = temporalMaturityDimensions.concat(semanticDimensions);
  const dimensions = allMaturityDimensions.map(dimension => {
    const byYear = years.map(year => {
      const messages = userMessages.filter(message => message.year === year);
      const profile = buildDimensionProfile(dimension, messages, year);
      const firstObserved = profile.supporting_evidence.concat(profile.counter_evidence, profile.uncertain_evidence).map(item => item.date).filter(Boolean).sort()[0] || null;
      const lastObserved = profile.supporting_evidence.concat(profile.counter_evidence, profile.uncertain_evidence).map(item => item.date).filter(Boolean).sort().slice(-1)[0] || null;
      return {
        year,
        ...profile,
        supporting_evidence_count: profile.positive_count,
        counter_evidence_count: profile.negative_count,
        first_observed: firstObserved,
        last_observed: lastObserved,
        interpretation: interpretDimensionStatus(dimension, profile)
      };
    });
    const aggregate = buildDimensionProfile(dimension, userMessages, "all");
    const isSemanticDimension = dimension.derivation === "semantic_capability_extraction";
    const isCanonicalCapability = !dimension.derivation &&
      aggregate.capability_score != null &&
      aggregate.positive_count >= 2 &&
      aggregate.unique_conversation_count >= 2;
    return {
      id: dimension.id,
      label: dimension.label,
      canonical_dimension: dimension.canonical_dimension || dimension.id,
      semantic_type: dimension.semantic_type || (isCanonicalCapability ? "capability" : null),
      radar_eligible: Boolean(dimension.radar_eligible || isCanonicalCapability),
      description: dimension.description,
      derivation: dimension.derivation || "canonical_ontology_dimension",
      derivation_note: dimension.derivation_note || "Universal canonical professional dimension scored from attributable evidence in the uploaded file.",
      discovered_from: dimension.discovered_from || null,
      years: byYear,
      direction_of_change: directionFromSeries(byYear),
      first_observed: byYear.map(item => item.first_observed).filter(Boolean).sort()[0] || null,
      last_observed: byYear.map(item => item.last_observed).filter(Boolean).sort().slice(-1)[0] || null,
      ...aggregate,
      interpretation: interpretDimensionStatus(dimension, aggregate)
    };
  });

  const capability_stages = years.map(year => {
    const messages = userMessages.filter(message => message.year === year);
    const stages = capabilityStageSignals.map(stage => {
      const evidence = messages
        .filter(message => includesAny(message.lower, stage.terms))
        .map(message => ({
          conversation_id: message.conversation.id,
          conversation_title: message.conversation.title,
          date: message.created_at || message.conversation.created_at,
          excerpt: message.text.slice(0, 220)
        }));
      return {
        id: stage.id,
        label: stage.label,
        evidence_count: evidence.length,
        status: evidence.length ? evidenceStatusFromCounts(evidence.length, 0, evidence.length) : "insufficient_evidence",
        evidence: evidence.slice(0, 2)
      };
    });
    return { year, stages, consistency_notes: capabilityConsistencyNotes(stages) };
  });

  return {
    title: "Temporal Maturity Analysis",
    scope: years.length > 1
      ? "Evidence is extracted and scored independently for each year before period comparison. Global profile scores are not reused in this timeline."
      : "Historical comparison unavailable. Evidence is shown for the available period only.",
    section_title: years.length > 1 ? "Change by year" : "Evidence by period",
    maturity_levels: evidenceStatuses,
    dimension_strategy: {
      canonical_ontology_dimensions: temporalMaturityDimensions.length,
      canonical_radar_dimensions: dimensions.filter(dimension =>
        dimension.derivation === "canonical_ontology_dimension" && dimension.radar_eligible
      ).length,
      semantic_capability_dimensions: semanticDimensions.length,
      mode: "semantic_capability_extraction",
      radar_eligibility: "Radar axes require capability, behavior or responsibility evidence with at least two evidence items from two distinct conversations. Canonical ontology dimensions can be shown when they satisfy the same evidence threshold.",
      rejected_candidates: semanticExtraction.rejected_candidates
    },
    years,
    dimensions,
    capability_stages,
    public_only: publicOnly
  };
}

function buildEvidenceCoverage(normalized, temporalMaturity) {
  const messages = normalized.flatMap(conversation => conversation.messages.map(message => ({ ...message, conversation })));
  const userMessages = messages.filter(message => message.author === "user");
  const sourceCounts = {
    direct_user_inputs: 0,
    mixed_content_items: 0,
    ai_generated_items: 0,
    external_documents: 0,
    unknown_items: 0
  };
  for (const message of userMessages) {
    const value = sourceValue(message);
    if (value === "original_user_input") sourceCounts.direct_user_inputs += 1;
    else if (value === "mixed_content") sourceCounts.mixed_content_items += 1;
    else if (value === "ai_generated_text") sourceCounts.ai_generated_items += 1;
    else if (["pasted_external_document", "pasted_job_description"].includes(value)) sourceCounts.external_documents += 1;
    else sourceCounts.unknown_items += 1;
  }
  const dimensions = temporalMaturity ? temporalMaturity.dimensions : [];
  return {
    period_covered: dateRange(normalized),
    total_professional_conversations: normalized.length,
    total_evidence_items: dimensions.reduce((sum, dimension) => sum + dimension.positive_count + dimension.negative_count + dimension.uncertain_count, 0),
    ...sourceCounts,
    uncertain_evidence: dimensions.reduce((sum, dimension) => sum + dimension.uncertain_count, 0),
    dimensions_with_sufficient_evidence: dimensions.filter(dimension => !["insufficient_evidence", "counter_evidence_only"].includes(dimension.status)).length,
    dimensions_with_insufficient_evidence: dimensions.filter(dimension => dimension.status === "insufficient_evidence").length
  };
}

function confidenceWeight(confidence) {
  if (confidence === "high") return 1;
  if (confidence === "medium") return 0.72;
  if (confidence === "low") return 0.45;
  return 0.35;
}

function dimensionLabel(dimension) {
  const labels = {
    problem_solving: "Problem solving",
    communication: "Communication",
    execution: "Execution",
    leadership: "Leadership",
    strategy: "Strategy",
    technology: "Technology",
    technology_reasoning: "Tech reasoning",
    tech_debugging: "Debugging",
    tech_testing: "Testing",
    tech_architecture: "Architecture",
    tech_security: "Security",
    tech_operations: "Operations",
    tech_data_api: "Data/API",
    programming: "Programming",
    product_management: "Product",
    recruiting: "Recruiting"
  };
  return labels[dimension] || dimension.replace(/_/g, " ");
}

function evidenceStrength(insight) {
  const evidenceFactor = Math.min(1, Math.max(0.2, (insight.evidence_count || 1) / 5));
  const userFactor = insight.user_status === "accepted" ? 1.08 :
    insight.user_status === "contextualized" ? 0.96 :
    insight.user_status === "contested" ? 0.58 :
    insight.user_status === "private_only" ? 0.75 : 0.88;
  return Math.max(12, Math.min(100, Math.round(100 * evidenceFactor * confidenceWeight(insight.confidence) * userFactor)));
}

function buildVisualProfile(normalized, insights, publicOnly = false) {
  const visibleInsights = publicOnly ? insights.filter(insight => insight.public_visibility) : insights;
  const dimensionMap = new Map();
  for (const insight of visibleInsights) {
    const current = dimensionMap.get(insight.dimension) || {
      dimension: insight.dimension,
      label: dimensionLabel(insight.dimension),
      strength: 0,
      evidence_count: 0,
      insight_count: 0,
      confidence_mix: { low: 0, medium: 0, high: 0 }
    };
    current.strength += evidenceStrength(insight);
    current.evidence_count += insight.evidence_count || 0;
    current.insight_count += 1;
    if (current.confidence_mix[insight.confidence] != null) current.confidence_mix[insight.confidence] += 1;
    dimensionMap.set(insight.dimension, current);
  }

  const axes = Array.from(dimensionMap.values())
    .map(axis => ({
      ...axis,
      strength: Math.round(axis.strength / Math.max(1, axis.insight_count)),
      level: axis.strength / Math.max(1, axis.insight_count) >= 70 ? "strongly supported" :
        axis.strength / Math.max(1, axis.insight_count) >= 50 ? "recurring" :
        axis.strength / Math.max(1, axis.insight_count) >= 32 ? "observed" : "emerging"
    }))
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 8);

  const timelineMap = new Map();
  for (const insight of visibleInsights) {
    for (const evidence of insight.evidence_for || []) {
      const date = evidence.date ? new Date(evidence.date) : null;
      if (!date || Number.isNaN(date.getTime())) continue;
      const year = String(date.getFullYear());
      const key = `${year}:${insight.dimension}`;
      const current = timelineMap.get(key) || {
        year,
        dimension: insight.dimension,
        label: dimensionLabel(insight.dimension),
        strength: 0,
        evidence_count: 0
      };
      current.strength += evidenceStrength(insight);
      current.evidence_count += 1;
      timelineMap.set(key, current);
    }
  }

  const timeline = Array.from(timelineMap.values())
    .map(point => ({
      ...point,
      strength: Math.round(point.strength / Math.max(1, point.evidence_count))
    }))
    .sort((a, b) => Number(a.year) - Number(b.year) || b.strength - a.strength);

  return {
    mode: publicOnly ? "public" : "private",
    axes,
    timeline,
    narrative: axes.length
      ? `Profilo visuale basato su ${visibleInsights.length} insight ${publicOnly ? "condivisibili" : "analizzati"}.`
      : "Nessun insight visualizzabile con i filtri correnti."
  };
}

function buildReports(normalized, userInsights, reportConfig) {
  const config = reportConfig ? normalizeReportConfig(reportConfig) : null;
  const range = dateRange(normalized);
  const categoryCounts = normalized.reduce((acc, c) => {
    acc[c.professional_category] = (acc[c.professional_category] || 0) + 1;
    return acc;
  }, {});
  const insights = userInsights && userInsights.length ? userInsights : generateInsights(normalized);
  const privateVisualProfile = buildVisualProfile(normalized, insights, false);
  const publicVisualProfile = buildVisualProfile(normalized, insights, true);
  const privateTechnologyReasoning = buildTechnologyReasoning(normalized, insights, false);
  const publicTechnologyReasoning = buildTechnologyReasoning(normalized, insights, true);
  const privateTemporalMaturity = extractTemporalEvidence(normalized, false);
  const publicTemporalMaturity = extractTemporalEvidence(normalized, true);
  const privateEvidenceCoverage = buildEvidenceCoverage(normalized, privateTemporalMaturity);
  const publicEvidenceCoverage = buildEvidenceCoverage(normalized, publicTemporalMaturity);
  const kpis = {
    evidence_coverage: normalized.length,
    months_covered: range.months_covered,
    recency_index: Math.min(100, Math.round(range.recent_percentage * 0.8 + Math.min(normalized.length, 20))),
    context_diversity: Object.keys(categoryCounts).filter(c => c !== "uncategorized").length,
    insight_count: insights.length,
    generated_at: config ? config.generated_at : new Date().toISOString().slice(0, 10),
    first_data: config ? config.period_from : range.first,
    last_data: config ? config.period_to : range.last,
    recent_evidence_percentage: range.recent_percentage
  };
  return {
    normalized,
    insights,
    kpis,
    report_config: config,
    analysis_notes: normalized.length
      ? []
      : ["Nessuna conversazione analizzabile selezionata. In Review includi almeno una conversazione professionale o mista."],
    visual_profile: privateVisualProfile,
    technology_reasoning: privateTechnologyReasoning,
    temporal_maturity: privateTemporalMaturity,
    evidence_coverage_detail: privateEvidenceCoverage,
    private_report: {
      title: config ? `Professional Evidence Snapshot - ${config.profile_name}` : "Private Professional Mirror",
      report_config: config,
      generated_at: kpis.generated_at,
      period: config ? { from: config.period_from, to: config.period_to, selected_months: config.selected_months } : { first_data: range.first, last_data: range.last },
      limits: [
        "Le conversazioni AI rappresentano solo una parte del comportamento professionale.",
        "Le inferenze possono essere errate e richiedono revisione umana.",
        "Il profilo non e' una diagnosi psicologica e non deve essere usato come unico criterio di selezione."
      ],
      insights,
      kpis,
      visual_profile: privateVisualProfile,
      technology_reasoning: privateTechnologyReasoning,
      temporal_maturity: privateTemporalMaturity,
      evidence_coverage_detail: privateEvidenceCoverage
    },
    public_report: {
      title: config ? `Professional Evidence Snapshot - ${config.profile_name}` : "Professional Evidence Passport",
      report_config: config,
      generated_at: kpis.generated_at,
      period: config ? { from: config.period_from, to: config.period_to, selected_months: config.selected_months } : { first_data: range.first, last_data: range.last },
      kpis,
      visual_profile: publicVisualProfile,
      technology_reasoning: publicTechnologyReasoning,
      temporal_maturity: publicTemporalMaturity,
      evidence_coverage_detail: publicEvidenceCoverage,
      insights: insights.filter(insight => insight.public_visibility).map(insight => ({
        title: insight.title,
        summary: insight.summary,
        confidence: insight.confidence,
        temporal_status: insight.temporal_status,
        user_status: insight.user_status
      }))
    }
  };
}

function scanSummary(conversations) {
  const range = dateRange(conversations);
  const counts = conversations.reduce((acc, c) => {
    acc[c.classification] = (acc[c.classification] || 0) + 1;
    return acc;
  }, {});
  return {
    total_conversations: conversations.length,
    total_messages: conversations.reduce((sum, c) => sum + c.messages.length, 0),
    period: range,
    counts
  };
}

async function handleApi(req, res) {
  try {
    if (req.method === "GET" && req.url === "/api/version") {
      sendJson(res, 200, { version: APP_VERSION });
      return;
    }
    if (req.method === "POST" && req.url === "/api/import") {
      const body = await readBody(req);
      const parts = parseMultipart(body, req.headers["content-type"]);
      const file = parts.find(part => part.field === "file" || part.filename);
      if (!file) throw new Error("No file uploaded.");
      const configPart = parts.find(part => part.field === "reportConfig");
      const reportConfig = configPart ? normalizeReportConfig(JSON.parse(configPart.data.toString("utf8"))) : null;
      const raw = parseUpload(file.data, file.filename);
      const conversations = filterByReportPeriod(normalizeChatGptExport(raw), reportConfig);
      const sessionId = crypto.randomUUID();
      sessions.set(sessionId, { conversations, report_config: reportConfig, created_at: new Date().toISOString() });
      sendJson(res, 200, { sessionId, summary: scanSummary(conversations), conversations, report_config: reportConfig });
      return;
    }
    if (req.method === "POST" && req.url === "/api/analyze") {
      const payload = JSON.parse((await readBody(req)).toString("utf8"));
      const session = sessions.get(payload.sessionId);
      if (!session) throw new Error("Session not found.");
      const reportConfig = payload.reportConfig || session.report_config ? normalizeReportConfig(payload.reportConfig || session.report_config) : null;
      const normalized = buildNormalized(session.conversations, payload.decisions);
      const insights = generateInsights(normalized);
      const reports = buildReports(normalized, insights, reportConfig);
      session.normalized = normalized;
      session.report_config = reportConfig;
      session.reports = reports;
      sendJson(res, 200, reports);
      return;
    }
    if (req.method === "POST" && req.url === "/api/report") {
      const payload = JSON.parse((await readBody(req)).toString("utf8"));
      const session = sessions.get(payload.sessionId);
      if (!session) throw new Error("Session not found.");
      const reportConfig = payload.reportConfig || session.report_config ? normalizeReportConfig(payload.reportConfig || session.report_config) : null;
      const reports = buildReports(session.normalized || [], payload.insights || [], reportConfig);
      session.report_config = reportConfig;
      session.reports = reports;
      sendJson(res, 200, reports);
      return;
    }
    if (req.method === "POST" && req.url === "/api/delete") {
      const payload = JSON.parse((await readBody(req)).toString("utf8"));
      sessions.delete(payload.sessionId);
      sendJson(res, 200, { deleted: true });
      return;
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    handleApi(req, res);
  } else {
    serveStatic(req, res);
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Professional Evidence Profile running at http://localhost:${PORT}`);
  });
}

module.exports = {
  APP_VERSION,
  normalizeChatGptExport,
  buildNormalized,
  generateInsights,
  buildReports,
  scanSummary,
  redactText,
  classifyConversation
};
