const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const PDFDocument = require("pdfkit");

const IS_VERCEL = Boolean(process.env.VERCEL);
const PORT = process.env.PORT || 4173;
const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;
const PUBLIC_DIR = resolvePublicDir();
const APP_VERSION = "2026-07-07-snapshot-v10";
const sessions = new Map();

registerProcessErrorHandlers();
logStartupDiagnostics();

function resolvePublicDir() {
  const candidates = [
    path.join(process.cwd(), "public"),
    path.join(__dirname, "public")
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
}

function registerProcessErrorHandlers() {
  if (globalThis.__AI_WORK_PASSPORT_ERROR_HANDLERS__) return;
  process.on("uncaughtException", error => {
    logError("uncaughtException", error);
  });
  process.on("unhandledRejection", reason => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logError("unhandledRejection", error);
  });
  globalThis.__AI_WORK_PASSPORT_ERROR_HANDLERS__ = true;
}

function logStartupDiagnostics() {
  const diagnostics = {
    runtime: IS_VERCEL ? "vercel" : "local",
    cwd: process.cwd(),
    dirname: __dirname,
    publicDir: PUBLIC_DIR,
    publicDirExists: fs.existsSync(PUBLIC_DIR),
    publicIndexExists: fs.existsSync(path.join(PUBLIC_DIR, "index.html"))
  };
  console.log("[startup] AI Work Passport diagnostics", diagnostics);
}

function requestMeta(req) {
  return {
    method: req && req.method,
    url: req && req.url,
    runtime: IS_VERCEL ? "vercel" : "local"
  };
}

function logError(context, error, meta = {}) {
  const normalized = error instanceof Error ? error : new Error(String(error));
  console.error(`[${context}]`, {
    message: normalized.message,
    stack: normalized.stack,
    ...meta
  });
}

function getRequestPath(req) {
  const rawUrl = req && typeof req.url === "string" && req.url ? req.url : "/";
  const parsed = new URL(rawUrl, "http://localhost");
  return parsed.pathname || "/";
}

function sendError(res, status, error, meta = {}) {
  const normalized = error instanceof Error ? error : new Error(String(error));
  logError("request_error", normalized, meta);
  if (res.headersSent) {
    res.end();
    return;
  }
  sendJson(res, status, {
    error: normalized.message,
    stack: process.env.NODE_ENV === "production" ? normalized.stack : normalized.stack,
    runtime: IS_VERCEL ? "vercel" : "local"
  });
}

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

const skillPassportGroups = [
  {
    id: "technical_skills",
    title: "Competenze tecniche",
    summary: "Strumenti, tecnologie, metodologie e conoscenze specifiche osservabili nelle conversazioni approvate.",
    skills: [
      {
        id: "tools_used",
        label: "Strumenti utilizzati",
        evidence_label: "tool usage",
        action_terms: ["uso", "utilizzo", "configuro", "gestisco", "debuggo", "automatizzo", "monitoro", "integro", "setup", "deploy"],
        context_terms: ["tool", "strumento", "dashboard", "workflow", "pipeline", "repo", "editor", "terminal", "monitoring", "ci/cd"]
      },
      {
        id: "technologies",
        label: "Tecnologie",
        evidence_label: "technology reasoning",
        action_terms: ["definisco", "progetto", "valuto", "scelgo", "gestisco", "analizzo", "integro", "ottimizzo"],
        context_terms: ["api", "database", "server", "cloud", "javascript", "typescript", "python", "sql", "architecture", "architettura"]
      },
      {
        id: "methodologies",
        label: "Metodologie",
        evidence_label: "methodological execution",
        action_terms: ["prioritizzo", "pianifico", "definisco", "valido", "misuro", "itero", "retrospettiva", "review", "testo"],
        context_terms: ["mvp", "roadmap", "backlog", "milestone", "qa", "test", "acceptance criteria", "discovery", "retro", "validation"]
      },
      {
        id: "specific_knowledge",
        label: "Conoscenze specifiche",
        evidence_label: "domain-specific knowledge",
        action_terms: ["spiego", "applico", "definisco", "valuto", "conosco", "traduco", "governo"],
        context_terms: ["schema", "payload", "endpoint", "metric", "kpi", "pricing", "stakeholder", "compliance", "security", "governance"]
      }
    ]
  },
  {
    id: "business_skills",
    title: "Competenze business",
    summary: "Ragionamento su strategia, clienti, analisi, negoziazione e risultato osservabile nelle conversazioni.",
    skills: [
      {
        id: "strategy",
        label: "Strategia",
        evidence_label: "strategic framing",
        action_terms: ["definisco", "prioritizzo", "valuto", "scelgo", "allineo", "riduco", "indirizzo"],
        context_terms: ["strategia", "roadmap", "obiettivo", "trade-off", "dipendenze", "mvp", "scope", "priorita"]
      },
      {
        id: "client_management",
        label: "Gestione clienti",
        evidence_label: "client communication",
        action_terms: ["scrivo", "spiego", "gestisco", "allineo", "rispondo", "preparo", "negozio"],
        context_terms: ["cliente", "email", "messaggio", "tono", "follow-up", "referente", "presentazione"]
      },
      {
        id: "analysis",
        label: "Analisi",
        evidence_label: "business analysis",
        action_terms: ["analizzo", "scompongo", "misuro", "confronto", "identifico", "valuto", "diagnostico"],
        context_terms: ["rischio", "vincolo", "kpi", "metric", "impatto", "dataset", "scenario", "cause"]
      },
      {
        id: "negotiation",
        label: "Negoziazione",
        evidence_label: "negotiation pattern",
        action_terms: ["negozio", "propongo", "allineo", "media", "chiudo", "convergo"],
        context_terms: ["offerta", "contratto", "partnership", "accordo", "obiezione", "stakeholder"]
      },
      {
        id: "result_orientation",
        label: "Orientamento al risultato",
        evidence_label: "result orientation",
        action_terms: ["consegno", "chiudo", "porto", "sblocco", "risolvo", "fisso", "metto a terra"],
        context_terms: ["delivery", "risultato", "prossimi passi", "deadline", "azione", "operativo", "follow-up"]
      }
    ]
  },
  {
    id: "execution_capabilities",
    title: "Capacita di execution",
    summary: "Evidenze di problem solving, gestione delle priorita, pianificazione, autonomia e decisione osservabili nel lavoro descritto.",
    skills: [
      {
        id: "problem_solving",
        label: "Problem solving",
        evidence_label: "problem decomposition",
        action_terms: ["capire", "analizzo", "scompongo", "risolvo", "debuggo", "diagnostico", "identifico"],
        context_terms: ["problema", "causa", "bug", "errore", "vincolo", "soluzione", "root cause"]
      },
      {
        id: "priority_management",
        label: "Gestione priorita",
        evidence_label: "priority setting",
        action_terms: ["prioritizzo", "riduco", "sequenzio", "decido", "focalizzo", "scelgo"],
        context_terms: ["priorita", "perimetro", "scope", "mvp", "dipendenze", "milestone"]
      },
      {
        id: "planning",
        label: "Pianificazione",
        evidence_label: "planning discipline",
        action_terms: ["pianifico", "organizzo", "strutturo", "definisco", "scandisco", "preparo"],
        context_terms: ["timeline", "roadmap", "milestone", "passi", "sequenza", "risorse", "deadline"]
      },
      {
        id: "autonomy",
        label: "Autonomia",
        evidence_label: "autonomous ownership",
        action_terms: ["decido", "imposto", "porto", "guido", "definisco", "mi assumo", "coordino"],
        context_terms: ["ownership", "responsabilita", "direzione", "decisione", "governance", "next step"]
      },
      {
        id: "decision_making",
        label: "Capacita decisionale",
        evidence_label: "decision-making",
        action_terms: ["decido", "scelgo", "valuto", "raccomando", "indirizzo", "convergo"],
        context_terms: ["trade-off", "decisione", "opzioni", "go/no-go", "rischio", "priorita"]
      }
    ]
  },
  {
    id: "leadership_collaboration",
    title: "Leadership e collaborazione",
    summary: "Segnali di ownership, coordinamento, mentoring, gestione stakeholder e comunicazione professionale.",
    skills: [
      {
        id: "ownership",
        label: "Ownership",
        evidence_label: "ownership signal",
        action_terms: ["mi assumo", "guido", "definisco", "decido", "governo", "indirizzo"],
        context_terms: ["ownership", "responsabilita", "governance", "decisione", "allineamento"]
      },
      {
        id: "coordination",
        label: "Coordinamento",
        evidence_label: "coordination pattern",
        action_terms: ["coordino", "allineo", "organizzo", "coinvolgo", "strutturo"],
        context_terms: ["team", "ruoli", "delega", "coordinamento", "conflitto", "dipendenze"]
      },
      {
        id: "mentoring",
        label: "Mentoring",
        evidence_label: "mentoring pattern",
        action_terms: ["spiego", "faccio crescere", "supporto", "formo", "guido"],
        context_terms: ["mentoring", "coach", "feedback", "sviluppo", "team", "junior"]
      },
      {
        id: "stakeholder_management",
        label: "Gestione stakeholder",
        evidence_label: "stakeholder management",
        action_terms: ["allineo", "gestisco", "presento", "negozio", "spiego", "coinvolgo"],
        context_terms: ["stakeholder", "cliente", "manager", "team", "referente", "partner"]
      },
      {
        id: "communication",
        label: "Comunicazione",
        evidence_label: "professional communication",
        action_terms: ["scrivo", "spiego", "adatto", "presento", "chiarisco", "rispondo"],
        context_terms: ["email", "messaggio", "tono", "chiarezza", "feedback", "presentazione", "cliente"]
      }
    ]
  }
];

const professionalFunctions = [
  "engineering",
  "product",
  "program_project_management",
  "operations",
  "data_analytics",
  "sales_business_development",
  "marketing",
  "customer_success",
  "finance",
  "hr_people",
  "legal_compliance",
  "consulting",
  "executive_management",
  "other"
];

const roleArchetypes = [
  "individual_contributor",
  "technical_specialist",
  "backend_developer",
  "frontend_developer",
  "data_analyst",
  "data_engineer",
  "product_owner",
  "product_manager",
  "project_manager",
  "program_manager",
  "operations_manager",
  "consultant",
  "senior_consultant",
  "manager",
  "senior_manager",
  "functional_lead",
  "head_of_function",
  "director",
  "partner",
  "executive",
  "hr_lead",
  "recruiter",
  "customer_success_manager",
  "sales_manager",
  "other"
];

const operatingLevels = [
  "junior",
  "mid_level",
  "senior",
  "lead",
  "manager",
  "senior_manager",
  "head_of",
  "director",
  "executive_partner",
  "uncertain"
];

const workModes = [
  "individual_delivery",
  "specialist_execution",
  "cross_functional_coordination",
  "people_management",
  "strategic_leadership",
  "advisory_consulting",
  "operational_ownership",
  "commercial_ownership",
  "technical_ownership"
];

const professionalFunctionSignals = {
  engineering: ["backend", "frontend", "developer", "api", "architettura", "architecture", "deploy", "database", "python", "javascript", "bug", "incident", "reliability", "performance"],
  product: ["prodotto", "product", "backlog", "roadmap", "priorit", "utente", "discovery", "feature", "value proposition"],
  program_project_management: ["program", "project", "milestone", "timeline", "dipenden", "delivery", "piano", "scope", "workstream", "coordination"],
  operations: ["operativo", "operations", "processo", "runbook", "sop", "handover", "monitoring", "continuita"],
  data_analytics: ["data", "dati", "analytics", "kpi", "metric", "dashboard", "dataset", "sql", "analisi"],
  sales_business_development: ["vendita", "sales", "pipeline", "cliente", "deal", "negozia", "opportunity", "business development"],
  marketing: ["marketing", "campaign", "funnel", "brand", "acquisition", "content strategy"],
  customer_success: ["customer success", "adoption", "renewal", "onboarding", "retention", "nps"],
  finance: ["budget", "forecast", "margine", "pnl", "cash flow", "finance"],
  hr_people: ["hiring", "recruiting", "talent", "performance review", "people", "onboarding"],
  legal_compliance: ["compliance", "regolatorio", "contratto", "privacy", "gdpr", "legal"],
  consulting: ["consulenza", "consulting", "cliente", "raccomando", "advisory", "diagnosi", "framework"],
  executive_management: ["board", "executive", "strategic", "portfolio", "organizzazione", "company strategy", "governance"]
};

const canonicalDimensionDisplay = {
  decision_making: "Decision making",
  problem_solving: "Problem solving",
  communication: "Communication",
  execution: "Execution",
  leadership: "Leadership",
  collaboration: "Collaboration",
  planning: "Planning",
  learning: "Learning",
  domain_knowledge: "Domain knowledge",
  data_reasoning: "Data reasoning",
  risk_awareness: "Risk awareness",
  quality_improvement: "Quality improvement"
};

const professionalArchetypes = [
  {
    id: "growth_revenue",
    label: "Growth & Revenue",
    signals: ["growth", "revenue", "pricing", "funnel", "conversion", "cac", "ltv", "arpu", "churn", "retention", "acquisition", "go to market", "sales pipeline", "partner channel", "market expansion", "monetization", "expansion revenue", "upsell", "cross sell"],
    capability_labels: ["Growth strategy", "Revenue planning", "Funnel optimization", "Pricing strategy", "Retention strategy", "Partner growth", "Market expansion", "Experimentation", "Acquisition strategy", "Monetization strategy"],
    preferred_radar_labels: ["Growth strategy", "Revenue thinking", "Funnel optimization", "Data reasoning", "Experimentation", "Cross-functional leadership"],
    summary_template: "Evidence suggests a growth-oriented profile focused on revenue initiatives, funnel performance, retention, partner channels and measurable business outcomes.",
    contribution_template: "Typically translates growth objectives into measurable revenue initiatives, aligns product, marketing and sales around funnel priorities, and uses data to improve acquisition, activation, retention and expansion."
  },
  {
    id: "strategy_transformation",
    label: "Strategy & Transformation",
    signals: ["strategy", "transformation", "operating model", "business case", "prioritization", "roadmap", "governance", "executive alignment", "strategic initiative", "organizational change", "target operating model", "decision memo"],
    capability_labels: ["Strategic planning", "Operating model design", "Prioritization", "Business case development", "Executive alignment", "Transformation governance", "Roadmap definition"],
    preferred_radar_labels: ["Strategic planning", "Prioritization", "Executive alignment", "Governance", "Decision making", "Execution"],
    summary_template: "Evidence suggests a strategy-oriented profile focused on translating business priorities into structured initiatives, operating models and executive-level decision support.",
    contribution_template: "Typically helps convert broad strategic priorities into structured initiatives, decision materials, operating models and executable roadmaps."
  },
  {
    id: "product_delivery",
    label: "Product & Delivery",
    signals: ["product", "roadmap", "feature", "backlog", "user journey", "requirements", "release", "mvp", "customer experience", "delivery", "sprint", "stakeholder", "product discovery", "go live", "adoption"],
    capability_labels: ["Product strategy", "Roadmap management", "Requirements definition", "Customer journey improvement", "Delivery coordination", "Stakeholder management", "Product discovery", "Release planning"],
    preferred_radar_labels: ["Product strategy", "Delivery coordination", "Requirements definition", "Customer journey", "Stakeholder management", "Execution"],
    summary_template: "Evidence suggests a product and delivery profile focused on turning user needs, business priorities and technical constraints into coordinated execution.",
    contribution_template: "Typically turns product and business priorities into clearer requirements, coordinated delivery actions and improved customer or partner workflows."
  },
  {
    id: "technology_architecture",
    label: "Technology & Architecture",
    signals: ["api", "architecture", "integration", "cloud", "aws", "azure", "gcp", "database", "sql", "backend", "frontend", "security", "infrastructure", "databricks", "cloudflare", "ci/cd", "kubernetes", "microservices", "authentication", "webhook", "rest", "graphql", "event-driven"],
    capability_labels: ["Technical architecture", "API integration", "Cloud infrastructure", "Security awareness", "System design", "Technical problem solving", "Data platform understanding", "Integration design", "Platform delivery"],
    preferred_radar_labels: ["System design", "API integration", "Cloud infrastructure", "Security awareness", "Technical problem solving", "Platform delivery"],
    summary_template: "Evidence suggests a technology-oriented profile focused on integrations, platforms, cloud systems, security considerations and technical delivery.",
    contribution_template: "Typically connects technical systems, integration needs and operational constraints to support reliable delivery and better platform outcomes."
  },
  {
    id: "data_analytics",
    label: "Data & Analytics",
    signals: ["data", "dashboard", "kpi", "bi", "sql", "analytics", "reporting", "metric", "cohort", "forecast", "model", "attribution", "data quality", "data warehouse", "etl", "pipeline", "segmentation"],
    capability_labels: ["Data reasoning", "KPI design", "Reporting governance", "Dashboard design", "Metric interpretation", "Data quality improvement", "Analytics translation", "Data pipeline understanding"],
    preferred_radar_labels: ["Data reasoning", "KPI design", "Reporting governance", "Metric interpretation", "Data quality", "Decision support"],
    summary_template: "Evidence suggests a data-oriented profile focused on metrics, reporting, KPI interpretation and evidence-based decision support.",
    contribution_template: "Typically translates metrics and reporting into decision support, KPI interpretation and structured data-informed prioritization."
  },
  {
    id: "operations_execution",
    label: "Operations & Execution",
    signals: ["process", "workflow", "operations", "sla", "handover", "incident", "runbook", "coordination", "delivery plan", "dependency", "timeline", "issue tracking", "blocker", "escalation", "process improvement"],
    capability_labels: ["Operational execution", "Process improvement", "Dependency management", "Issue resolution", "Workflow coordination", "Execution discipline", "Escalation management"],
    preferred_radar_labels: ["Operational execution", "Process improvement", "Dependency management", "Issue resolution", "Workflow coordination", "Execution"],
    summary_template: "Evidence suggests an operations-oriented profile focused on coordinating workflows, resolving blockers and improving execution reliability.",
    contribution_template: "Typically coordinates workflows, dependencies and escalation paths to improve delivery reliability and reduce execution blockers."
  },
  {
    id: "risk_compliance_governance",
    label: "Risk, Compliance & Governance",
    signals: ["risk", "compliance", "privacy", "security", "audit", "regulation", "governance", "policy", "control", "insurance", "legal review", "documentation", "dora", "gdpr", "incident response", "approval flow"],
    capability_labels: ["Risk awareness", "Compliance coordination", "Governance design", "Documentation ownership", "Control management", "Regulatory awareness", "Security coordination"],
    preferred_radar_labels: ["Risk awareness", "Governance", "Compliance coordination", "Documentation", "Control management", "Stakeholder alignment"],
    summary_template: "Evidence suggests a governance-oriented profile focused on risk awareness, compliance coordination, documentation and control of regulated activities.",
    contribution_template: "Typically helps structure responsibilities, documentation, controls and coordination mechanisms across regulated or risk-sensitive activities."
  },
  {
    id: "people_leadership",
    label: "People & Leadership",
    signals: ["team", "hiring", "interview", "candidate", "feedback", "performance", "leadership", "alignment", "delegation", "coaching", "meeting", "stakeholder", "cross-functional", "one-to-one", "team structure"],
    capability_labels: ["Team leadership", "Hiring support", "Stakeholder alignment", "Meeting facilitation", "Feedback management", "Cross-functional coordination", "Team structuring"],
    preferred_radar_labels: ["Team leadership", "Stakeholder alignment", "Cross-functional coordination", "Feedback management", "Meeting facilitation", "Execution"],
    summary_template: "Evidence suggests a leadership-oriented profile focused on aligning people, coordinating teams, supporting hiring and enabling cross-functional execution.",
    contribution_template: "Typically aligns teams, clarifies responsibilities and supports cross-functional execution through communication, coordination and feedback loops."
  },
  {
    id: "sales_partnerships",
    label: "Sales & Partnerships",
    signals: ["partner", "client", "commercial", "contract", "renewal", "proposal", "negotiation", "account", "pipeline", "deal", "revenue share", "commission", "pricing", "sales", "account plan", "business development"],
    capability_labels: ["Partner management", "Commercial negotiation", "Client communication", "Renewal strategy", "Proposal development", "Revenue-share modeling", "Account growth", "Business development"],
    preferred_radar_labels: ["Partner management", "Commercial negotiation", "Client communication", "Renewal strategy", "Proposal development", "Revenue thinking"],
    summary_template: "Evidence suggests a commercial profile focused on partner management, client communication, renewals, proposals and revenue-related decisions.",
    contribution_template: "Typically supports partner-facing initiatives by clarifying commercial terms, coordinating stakeholders and translating business opportunities into actionable plans."
  },
  {
    id: "communication_stakeholder",
    label: "Communication & Stakeholder Management",
    signals: ["email", "message", "presentation", "deck", "follow-up", "alignment", "stakeholder", "update", "executive summary", "meeting note", "communication", "narrative", "framing", "briefing"],
    capability_labels: ["Professional communication", "Executive synthesis", "Stakeholder management", "Presentation refinement", "Follow-up discipline", "Message framing", "Narrative building"],
    preferred_radar_labels: ["Professional communication", "Executive synthesis", "Stakeholder management", "Message framing", "Follow-up discipline", "Alignment"],
    summary_template: "Evidence suggests a communication-oriented profile focused on clarifying messages, aligning stakeholders and translating work into structured professional updates.",
    contribution_template: "Typically improves professional communication by clarifying messages, structuring updates, refining presentations and aligning stakeholders around next steps."
  }
];

const archetypeSignals = {
  individual_contributor: ["implemento", "eseguo", "delivery personale", "mi occupo direttamente"],
  technical_specialist: ["specialist", "specialista", "deep dive", "expertise tecnica"],
  backend_developer: ["backend", "api", "service", "microserv", "database", "python", "node"],
  frontend_developer: ["frontend", "ui", "ux", "react", "css", "component"],
  data_analyst: ["dashboard", "reporting", "analisi dati", "kpi", "sql"],
  data_engineer: ["etl", "pipeline", "data model", "warehouse", "orchestrazione"],
  product_owner: ["product owner", "backlog", "user story", "acceptance criteria", "prioritizzazione"],
  product_manager: ["product manager", "roadmap", "go to market", "discovery", "value"],
  project_manager: ["project manager", "timeline", "milestone", "piano progetto", "rischio progetto"],
  program_manager: ["program manager", "workstream", "cross-functional", "governance programma"],
  operations_manager: ["operations manager", "operazioni", "process governance", "service continuity"],
  consultant: ["consulente", "consulenza", "raccomando", "assessment"],
  senior_consultant: ["advisory", "cliente executive", "trasformazione", "framework decisionale"],
  manager: ["gestisco team", "people management", "1:1", "obiettivi del team"],
  senior_manager: ["piu team", "manager dei manager", "portfolio", "org-wide"],
  functional_lead: ["functional lead", "guido la funzione", "standard della funzione"],
  head_of_function: ["head of", "funzione", "capability building", "ownership funzione"],
  director: ["director", "direzione", "strategic planning", "executive stakeholder"],
  partner: ["partner", "practice", "commercial strategy", "account growth"],
  executive: ["executive", "board", "company-level", "strategic leadership"],
  hr_lead: ["hr", "people strategy", "talent strategy", "org design"],
  recruiter: ["recruiter", "candidate", "sourcing", "interview pipeline"],
  customer_success_manager: ["customer success", "onboarding", "renewal", "adoption"],
  sales_manager: ["sales manager", "sales team", "pipeline", "quota"]
};

const workModeSignals = {
  individual_delivery: ["eseguo", "delivery personale", "implemento", "produco"],
  specialist_execution: ["specialista", "expertise", "deep dive", "focus tecnico"],
  cross_functional_coordination: ["cross-functional", "allineo stakeholder", "coordino team", "dipendenze"],
  people_management: ["people management", "1:1", "gestione persone", "performance review"],
  strategic_leadership: ["strategia", "strategic", "portfolio", "company direction", "governance"],
  advisory_consulting: ["consulenza", "advisory", "raccomando", "diagnosi"],
  operational_ownership: ["operativo", "operations", "ownership operativo", "continuita"],
  commercial_ownership: ["sales", "revenue", "commercial", "negoziazione", "deal"],
  technical_ownership: ["ownership tecnica", "architecture decision", "reliability", "incident", "api design"]
};

const operatingLevelSignals = {
  junior: {
    support: ["con supporto", "aiutami", "non sono sicuro", "sto imparando", "entry level"],
    counter: ["decido autonomamente", "guido", "ownership"]
  },
  mid_level: {
    support: ["implemento", "gestisco task", "consegno", "eseguo in autonomia"],
    counter: ["guido strategia", "gestisco team", "board"]
  },
  senior: {
    support: ["trade-off", "ownership", "decido", "autonomia", "prioritizzo", "mentoring"],
    counter: ["non posso decidere", "aspetto conferma su tutto"]
  },
  lead: {
    support: ["coordino", "allineo team", "cross-functional", "guido iniziativa", "governance"],
    counter: ["solo task individuali", "nessun coordinamento"]
  },
  manager: {
    support: ["people management", "1:1", "gestisco team", "obiettivi del team", "hiring"],
    counter: ["nessuna responsabilita persone"]
  },
  senior_manager: {
    support: ["piu team", "manager dei manager", "portfolio", "org-wide execution"],
    counter: ["solo contributo individuale"]
  },
  head_of: {
    support: ["head of", "guida funzione", "ownership funzione", "functional strategy"],
    counter: ["scope limitato al singolo task"]
  },
  director: {
    support: ["director", "strategic planning", "executive stakeholder", "budget ownership"],
    counter: ["solo execution operativa"]
  },
  executive_partner: {
    support: ["board", "company strategy", "enterprise", "partner", "p&l", "org design"],
    counter: ["scope solo operativo"]
  }
};

const roleSpecificCapabilityTemplates = {
  product_owner: [
    { label: "Product ownership", canonical_dimension: "execution", support: ["product ownership", "ownership prodotto", "own product"], counter: ["non posso decidere prodotto"] },
    { label: "Roadmap and backlog management", canonical_dimension: "planning", support: ["roadmap", "backlog", "user story", "priorit"], counter: ["senza backlog", "no piano"] },
    { label: "Stakeholder alignment", canonical_dimension: "collaboration", support: ["stakeholder", "allineo", "cross-functional", "allineamento"], counter: ["non coinvolgo stakeholder", "alignment mancante"] },
    { label: "Delivery coordination", canonical_dimension: "execution", support: ["delivery", "milestone", "dipendenze", "coordino"], counter: ["delivery bloccata", "nessun coordinamento"] },
    { label: "Data-informed prioritization", canonical_dimension: "data_reasoning", support: ["kpi", "metric", "data", "priorit"], counter: ["senza dati", "priorita non supportata"] }
  ],
  backend_developer: [
    { label: "Python backend expertise", canonical_dimension: "domain_knowledge", support: ["python", "backend", "service", "django", "fastapi"], counter: ["bassa confidenza tecnica", "serve specialista"] },
    { label: "API and service design", canonical_dimension: "execution", support: ["api", "endpoint", "payload", "service design", "schema"], counter: ["non definisco api"] },
    { label: "Performance diagnosis", canonical_dimension: "problem_solving", support: ["performance", "latency", "profiling", "ottimizz", "bottleneck"], counter: ["non so diagnosticare"] },
    { label: "Reliability engineering", canonical_dimension: "risk_awareness", support: ["reliability", "retry", "fallback", "monitoring", "uptime"], counter: ["nessun monitoraggio", "nessuna mitigazione"] },
    { label: "Incident resolution", canonical_dimension: "problem_solving", support: ["incident", "root cause", "rollback", "fix", "postmortem"], counter: ["incident non risolto"] },
    { label: "Independent technical execution", canonical_dimension: "execution", support: ["implemento", "decido", "ownership tecnica", "autonomia"], counter: ["aspetto sempre conferma", "non posso decidere"] },
    { label: "Collaboration and communication", canonical_dimension: "communication", support: ["allineo", "comunico", "stakeholder", "handover"], counter: ["lavoro da solo", "non collaboro", "messaggio non chiaro"] }
  ]
};

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
  const reportLanguage = ["it", "en"].includes(String(input.report_language || "").toLowerCase())
    ? String(input.report_language).toLowerCase()
    : "en";
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
    report_language: reportLanguage,
    generated_for: `AI Work Passport - ${profileName}`,
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
  const requestPath = getRequestPath(req);
  const urlPath = requestPath === "/" ? "/index.html" : safeDecodePath(requestPath);
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code !== "ENOENT") {
        sendError(res, 500, err, { ...requestMeta(req), filePath });
        return;
      }
      if (!path.extname(urlPath)) {
        const indexPath = path.join(PUBLIC_DIR, "index.html");
        fs.readFile(indexPath, (indexErr, indexData) => {
          if (indexErr) {
            sendError(res, 500, indexErr, { ...requestMeta(req), indexPath });
            return;
          }
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store, max-age=0"
          });
          res.end(indexData);
        });
        return;
      }
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

function safeDecodePath(requestPath) {
  try {
    return decodeURIComponent(requestPath);
  } catch (error) {
    throw new Error(`Invalid request path: ${requestPath}`);
  }
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

function skillMatchScore(messageText, skill) {
  const normalizedText = messageText.toLowerCase();
  const actionMatches = matchedTerms(normalizedText, skill.action_terms || []);
  const contextMatches = matchedTerms(normalizedText, skill.context_terms || []);
  const uniqueMatches = new Set([...actionMatches, ...contextMatches]);
  const hasPattern = (actionMatches.length >= 1 && contextMatches.length >= 1) || contextMatches.length >= 2;
  const score = hasPattern ? uniqueMatches.size + 1 : uniqueMatches.size;
  return {
    score,
    hasPattern,
    actionMatches,
    contextMatches,
    uniqueMatches: Array.from(uniqueMatches)
  };
}

function buildSkillEvidence(message, conversation, skill) {
  const matches = skillMatchScore(message.text, skill);
  if (!matches.hasPattern || matches.score < 3 || !canCreateCapabilityClaim(message)) return null;
  return {
    conversation_id: conversation.id,
    conversation_title: conversation.title,
    date: message.created_at || conversation.created_at,
    excerpt: message.text.slice(0, 280),
    matched_terms: matches.uniqueMatches.slice(0, 6),
    score: matches.score,
    source: sourceValue(message),
    source_weight: sourceWeight(message)
  };
}

function confidenceScoreFromEvidence(evidence) {
  if (!evidence.length) return 0;
  const uniqueConversationCount = new Set(evidence.map(item => item.conversation_id)).size;
  const averageSourceWeight = evidence.reduce((sum, item) => sum + (item.source_weight || 0), 0) / evidence.length;
  const breadthBonus = Math.min(18, uniqueConversationCount * 6);
  const depthBonus = Math.min(16, evidence.length * 4);
  return Math.max(18, Math.min(96, Math.round(averageSourceWeight * 55 + breadthBonus + depthBonus)));
}

function confidenceLabelFromScore(score) {
  if (score >= 78) return "high";
  if (score >= 55) return "medium";
  return "low";
}

function joinHuman(items) {
  const list = (items || []).filter(Boolean);
  if (!list.length) return "observable work signals";
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

function buildSkillReason(skill, evidence, confidenceScore) {
  const topTerms = Array.from(new Set(evidence.flatMap(item => item.matched_terms || []))).slice(0, 4);
  const conversations = new Set(evidence.map(item => item.conversation_id)).size;
  const sourceCoverage = evidence.every(item => item.source === "original_user_input")
    ? "supported by direct user-authored evidence"
    : "supported by attributable but mixed-origin evidence";
  return `${skill.label} emerges across ${conversations} conversation${conversations === 1 ? "" : "s"} through ${joinHuman(topTerms)}; ${sourceCoverage}; confidence ${confidenceScore}/100.`;
}

function buildSkillPassport(normalized) {
  const userMessages = normalized.flatMap(conversation =>
    conversation.messages
      .filter(message => message.author === "user")
      .map(message => ({ message, conversation }))
  );

  const groups = skillPassportGroups.map(group => {
    const skills = group.skills.map(skill => {
      const evidence = userMessages
        .map(({ message, conversation }) => buildSkillEvidence(message, conversation, skill))
        .filter(Boolean)
        .sort((a, b) => b.score - a.score)
        .slice(0, 4);
      if (!evidence.length) return null;
      const confidence_score = confidenceScoreFromEvidence(evidence);
      return {
        id: skill.id,
        label: skill.label,
        evidence_label: skill.evidence_label,
        confidence_score,
        confidence: confidenceLabelFromScore(confidence_score),
        evidence_count: evidence.length,
        examples: evidence.slice(0, 3).map(item => ({
          conversation_id: item.conversation_id,
          conversation_title: item.conversation_title,
          date: item.date,
          excerpt: item.excerpt
        })),
        ranking_reason: buildSkillReason(skill, evidence, confidence_score)
      };
    }).filter(Boolean).sort((a, b) => b.confidence_score - a.confidence_score);

    const groupScore = skills.length
      ? Math.round(skills.reduce((sum, skill) => sum + skill.confidence_score, 0) / skills.length)
      : 0;
    return {
      id: group.id,
      title: group.title,
      summary: group.summary,
      confidence_score: groupScore,
      confidence: confidenceLabelFromScore(groupScore),
      skills,
      observed_skills: skills.length
    };
  }).filter(group => group.skills.length);

  return {
    title: "AI Work Passport",
    subtitle: "Evidence-backed professional profile built from approved conversations.",
    groups,
    strengths: groups
      .flatMap(group => group.skills.map(skill => ({ group: group.title, ...skill })))
      .sort((a, b) => b.confidence_score - a.confidence_score)
      .slice(0, 5),
    development_areas: groups
      .flatMap(group => group.skills.map(skill => ({ group: group.title, ...skill })))
      .filter(skill => skill.confidence_score < 60)
      .slice(0, 5)
  };
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

function identityEvidenceId(layer, key, message, conversation) {
  return `identity:${layer}:${key}:${conversation.id}:${message.id}`;
}

function collectAttributableUserMessages(normalized) {
  return normalized.flatMap(conversation =>
    conversation.messages
      .filter(message => message.author === "user")
      .map(message => ({
        ...message,
        conversation,
        lower: String(message.text || "").toLowerCase(),
        attributable: canCreateCapabilityClaim(message)
      }))
  );
}

function scoreTaxonomy(messages, taxonomy, signalsMap, layer) {
  const rows = taxonomy.map(key => {
    const terms = signalsMap[key] || [];
    let score = 0;
    const evidence = [];
    const conversations = new Set();
    for (const message of messages) {
      const matched = matchedTerms(message.lower, terms);
      if (!matched.length || !message.attributable) continue;
      const increment = Math.max(1, matched.length * sourceWeight(message));
      score += increment;
      conversations.add(message.conversation.id);
      evidence.push({
        id: identityEvidenceId(layer, key, message, message.conversation),
        conversation_id: message.conversation.id,
        date: message.created_at || message.conversation.created_at,
        matched_terms: matched.slice(0, 6),
        excerpt: message.text.slice(0, 220)
      });
    }
    return {
      key,
      score,
      evidence,
      conversation_count: conversations.size
    };
  });
  return rows.sort((a, b) => b.score - a.score || b.conversation_count - a.conversation_count);
}

function inferOperatingLevel(messages) {
  const titleOnlyTerms = new Set(["junior", "senior", "lead", "manager", "senior manager", "head of", "director", "executive", "partner"]);
  const scopeAutonomySignals = [
    "ownership", "autonomia", "decido", "trade-off", "coordino", "cross-functional", "strategic", "portfolio", "people management", "1:1", "board", "budget"
  ];
  const rows = operatingLevels
    .filter(level => level !== "uncertain")
    .map(level => {
      const profile = operatingLevelSignals[level] || { support: [], counter: [] };
      let support = 0;
      let counter = 0;
      const supportEvidence = [];
      const counterEvidence = [];
      const conversations = new Set();
      for (const message of messages) {
        const supportTerms = matchedTerms(message.lower, profile.support || []);
        const counterTerms = matchedTerms(message.lower, profile.counter || []);
        const hasScopeSignal = matchedTerms(message.lower, scopeAutonomySignals).length > 0;
        const titleOnlyMatch = supportTerms.length > 0 && supportTerms.every(term => titleOnlyTerms.has(String(term || "").toLowerCase()));
        if (supportTerms.length && message.attributable && !(titleOnlyMatch && !hasScopeSignal)) {
          support += Math.max(1, supportTerms.length * sourceWeight(message));
          conversations.add(message.conversation.id);
          supportEvidence.push(identityEvidenceId("level_support", level, message, message.conversation));
        }
        if (counterTerms.length && message.attributable) {
          counter += Math.max(1, counterTerms.length * 0.8);
          counterEvidence.push(identityEvidenceId("level_counter", level, message, message.conversation));
        }
      }
      return {
        level,
        score: Math.max(0, support - counter * 0.8),
        support,
        counter,
        support_evidence_ids: supportEvidence,
        counter_evidence_ids: counterEvidence,
        conversation_count: conversations.size
      };
    })
    .sort((a, b) => b.score - a.score || b.conversation_count - a.conversation_count);

  const top = rows[0] || null;
  const second = rows[1] || null;
  if (!top || top.score < 2 || top.conversation_count < 1) {
    return {
      operating_level: "uncertain",
      confidence: "low",
      supporting_evidence_ids: [],
      limitations: ["Insufficient evidence on scope, autonomy and ownership to infer operating level."]
    };
  }

  const dominance = top.score - (second ? second.score : 0);
  const confidence = top.score >= 6 && dominance >= 2 && top.conversation_count >= 2
    ? "high"
    : top.score >= 3
      ? "medium"
      : "low";
  return {
    operating_level: top.level,
    confidence,
    supporting_evidence_ids: top.support_evidence_ids.slice(0, 10),
    limitations: top.counter ? ["Counter-evidence indicates potential limits on demonstrated scope or autonomy."] : []
  };
}

function mapPrimaryRoleTemplate(identity, messages) {
  const text = messages.map(message => message.lower).join("\n");
  if (identity.observed_archetype === "product_owner" || identity.observed_archetype === "product_manager") return "product_owner";
  if (identity.observed_archetype === "backend_developer") return "backend_developer";
  if (identity.primary_function === "engineering" && /\bpython\b/.test(text)) return "backend_developer";
  if (identity.primary_function === "product") return "product_owner";
  return identity.primary_function === "engineering" ? "backend_developer" : "product_owner";
}

function roleSpecificStatus(weightedPositive, positiveCount, counterCount) {
  if (!positiveCount) return "insufficient_evidence";
  const net = Math.max(0, weightedPositive - counterCount * 0.8);
  if (net >= 8 && positiveCount >= 3) return "strongly_supported";
  if (net >= 5 && positiveCount >= 2) return "recurring";
  if (net >= 2.5) return "observed";
  return "emerging";
}

function buildRoleSpecificCapabilities(normalized, professionalIdentity) {
  const messages = collectAttributableUserMessages(normalized);
  const templateKey = mapPrimaryRoleTemplate(professionalIdentity, messages);
  const templates = roleSpecificCapabilityTemplates[templateKey] || [];
  return templates.map(template => {
    let weightedPositive = 0;
    const positiveEvidence = [];
    const counterEvidence = [];
    const conversations = new Set();
    for (const message of messages) {
      const supportTerms = matchedTerms(message.lower, template.support || []);
      const counterTerms = matchedTerms(message.lower, template.counter || []);
      if (supportTerms.length && message.attributable) {
        weightedPositive += Math.max(1, supportTerms.length * sourceWeight(message));
        conversations.add(message.conversation.id);
        positiveEvidence.push(identityEvidenceId("role_capability", template.label.toLowerCase().replace(/[^a-z0-9]+/g, "_"), message, message.conversation));
      }
      if (counterTerms.length && message.attributable) {
        counterEvidence.push(identityEvidenceId("role_capability_counter", template.label.toLowerCase().replace(/[^a-z0-9]+/g, "_"), message, message.conversation));
      }
    }
    const coverage = evidenceCoverageScore(weightedPositive + counterEvidence.length, conversations.size);
    return {
      label: template.label,
      canonical_dimension: template.canonical_dimension,
      evidence_status: roleSpecificStatus(weightedPositive, positiveEvidence.length, counterEvidence.length),
      coverage,
      supporting_evidence_ids: positiveEvidence.slice(0, 10),
      counter_evidence_ids: counterEvidence.slice(0, 8)
    };
  });
}

function domainToFunction(domain) {
  const map = {
    strategy: "product",
    project_management: "program_project_management",
    product_management: "product",
    technology: "engineering",
    programming: "engineering",
    data_analytics: "data_analytics",
    professional_communication: "consulting",
    leadership: "executive_management",
    recruiting: "hr_people",
    negotiation: "sales_business_development",
    execution: "operations",
    learning: "consulting",
    other: "other",
    uncategorized: "other"
  };
  return map[domain] || "other";
}

function recencyWeightForDate(dateIso, latestIso) {
  if (!dateIso || !latestIso) return 0.72;
  const date = new Date(dateIso);
  const latest = new Date(latestIso);
  if (Number.isNaN(date.getTime()) || Number.isNaN(latest.getTime())) return 0.72;
  const days = Math.max(0, Math.round((latest - date) / (1000 * 60 * 60 * 24)));
  if (days <= 30) return 1;
  if (days <= 90) return 0.9;
  if (days <= 180) return 0.8;
  return 0.68;
}

function sourcePenaltyWeight(source) {
  if (source === "original_user_input") return 1;
  if (source === "mixed_content") return 0.65;
  if (source === "unknown") return 0.45;
  if (source === "pasted_email" || source === "pasted_code") return 0.35;
  if (source === "pasted_external_document" || source === "pasted_job_description") return 0.2;
  if (source === "ai_generated_text") return 0.1;
  return 0.35;
}

function buildDomainWeighting(normalized, temporalMaturity) {
  const period = dateRange(normalized);
  const latestIso = period.last;
  const rows = new Map();

  const ensure = domain => {
    const key = domain || "other";
    if (!rows.has(key)) {
      rows.set(key, {
        domain: key,
        weighted_raw: 0,
        supporting_evidence_items: 0,
        direct_user_items: 0,
        attributable_items: 0,
        distinct_conversations: new Set(),
        evidence_ids: [],
        source_counts: {
          original_user_input: 0,
          mixed_content: 0,
          unknown: 0,
          pasted_content: 0,
          ai_generated_text: 0,
          external_content: 0
        },
        confidence_sum: 0,
        confidence_count: 0,
        recency_sum: 0,
        recency_count: 0,
        dimensions: new Set()
      });
    }
    return rows.get(key);
  };

  for (const conversation of normalized) {
    ensure(conversation.professional_category || "other");
    const userMessages = (conversation.messages || []).filter(message => message.author === "user");
    for (const message of userMessages) {
      const domain = conversation.professional_category || "other";
      const row = ensure(domain);
      const source = sourceValue(message);
      const sourcePenalty = sourcePenaltyWeight(source);
      const recency = recencyWeightForDate(message.created_at || conversation.created_at || conversation.updated_at, latestIso);
      const confidence = Number(conversation.confidence || 0.62);
      const weighted = Math.max(0.05, sourcePenalty * recency * confidence);

      row.weighted_raw += weighted;
      row.distinct_conversations.add(conversation.id);
      row.evidence_ids.push(identityEvidenceId("domain", domain, message, conversation));
      row.confidence_sum += confidence;
      row.confidence_count += 1;
      row.recency_sum += recency;
      row.recency_count += 1;

      if (canCreateCapabilityClaim(message)) {
        row.supporting_evidence_items += 1;
        row.attributable_items += 1;
      }
      if (source === "original_user_input") row.direct_user_items += 1;

      if (source === "original_user_input") row.source_counts.original_user_input += 1;
      else if (source === "mixed_content") row.source_counts.mixed_content += 1;
      else if (source === "ai_generated_text") row.source_counts.ai_generated_text += 1;
      else if (source === "pasted_external_document" || source === "pasted_job_description") row.source_counts.external_content += 1;
      else if (source === "pasted_email" || source === "pasted_code") row.source_counts.pasted_content += 1;
      else row.source_counts.unknown += 1;
    }
  }

  const canonicalDimensions = (temporalMaturity && temporalMaturity.dimensions || [])
    .filter(dimension => dimension.derivation === "canonical_ontology_dimension");
  for (const dimension of canonicalDimensions) {
    for (const evidence of dimension.supporting_evidence || []) {
      const conversation = normalized.find(item => item.id === evidence.conversation_id);
      if (!conversation) continue;
      const domain = conversation.professional_category || "other";
      ensure(domain).dimensions.add(dimension.canonical_dimension || dimension.id);
    }
  }

  const packed = Array.from(rows.values()).map(row => {
    const conversationCount = row.distinct_conversations.size;
    const diversity = row.dimensions.size;
    const recurrenceBoost = conversationCount >= 4 ? 1.22 : conversationCount >= 3 ? 1.14 : conversationCount >= 2 ? 1.05 : 0.86;
    const diversityBoost = 1 + Math.min(0.24, Math.max(0, diversity - 1) * 0.06);
    const totalSources = Object.values(row.source_counts).reduce((sum, value) => sum + value, 0) || 1;
    const externalRatio = (row.source_counts.external_content + row.source_counts.ai_generated_text + row.source_counts.pasted_content) / totalSources;
    const isolatedPenalty = conversationCount < 2 ? 0.18 : 0;
    const attributionPenalty = Math.min(0.42, externalRatio * 0.5 + isolatedPenalty);
    const weighted_score = row.weighted_raw * recurrenceBoost * diversityBoost * (1 - attributionPenalty);
    return {
      domain: row.domain,
      weighted_score,
      weighted_raw: row.weighted_raw,
      supporting_evidence_items: row.supporting_evidence_items,
      distinct_conversations: conversationCount,
      direct_user_items: row.direct_user_items,
      attributable_items: row.attributable_items,
      average_confidence: row.confidence_count ? row.confidence_sum / row.confidence_count : 0,
      average_recency: row.recency_count ? row.recency_sum / row.recency_count : 0,
      diversity_count: diversity,
      recurrence_factor: recurrenceBoost,
      attribution_penalty: attributionPenalty,
      source_counts: row.source_counts,
      evidence_ids: Array.from(new Set(row.evidence_ids)).slice(0, 20)
    };
  }).sort((a, b) => b.weighted_score - a.weighted_score);

  const totalWeighted = packed.reduce((sum, item) => sum + item.weighted_score, 0) || 1;
  const enriched = packed.map(item => {
    const weighted_share = item.weighted_score / totalWeighted;
    const passes_threshold =
      item.supporting_evidence_items >= 3 &&
      item.distinct_conversations >= 2 &&
      item.direct_user_items >= 2 &&
      weighted_share >= 0.25;
    return {
      ...item,
      weighted_share,
      passes_threshold
    };
  });

  return {
    total_weighted_evidence: totalWeighted,
    domains: enriched,
    dominant_domain: enriched[0] || null,
    secondary_domains: enriched.slice(1, 4)
  };
}

function humanReadableCapability(label) {
  const clean = String(label || "").trim();
  if (!clean) return "";
  const normalized = clean.toLowerCase().replace(/\s+/g, "_");
  if (canonicalDimensionDisplay[normalized]) return canonicalDimensionDisplay[normalized];
  if (canonicalDimensionDisplay[clean]) return canonicalDimensionDisplay[clean];
  return clean
    .replace(/[_/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map(token => token ? token.charAt(0).toUpperCase() + token.slice(1) : token)
    .join(" ");
}

function shortCapabilityLabel(label) {
  const map = {
    "Strategic planning": "Strategy",
    Prioritization: "Prioritization",
    "Cross-functional coordination": "Cross-functional coordination",
    "Product strategy": "Product delivery",
    "Operational execution": "Growth execution",
    "Data reasoning": "Data reasoning",
    "Partner management": "Partner management",
    "Revenue planning": "Revenue planning",
    "Funnel optimization": "Funnel optimization",
    "Retention strategy": "Retention",
    "Risk awareness": "Risk governance",
    "API integration": "Technical integration",
    "System design": "System design",
    "Governance design": "Risk governance"
  };
  return map[label] || label;
}

function archetypeCategoryBoost(archetypeId, category) {
  const map = {
    growth_revenue: ["strategy", "negotiation", "marketing", "sales_business_development"],
    strategy_transformation: ["strategy", "project_management", "leadership"],
    product_delivery: ["product_management", "project_management", "execution"],
    technology_architecture: ["technology", "programming"],
    data_analytics: ["data_analytics"],
    operations_execution: ["execution", "operations", "project_management"],
    risk_compliance_governance: ["leadership", "professional_communication", "legal_compliance"],
    people_leadership: ["leadership", "recruiting", "professional_communication"],
    sales_partnerships: ["negotiation", "sales_business_development", "professional_communication"],
    communication_stakeholder: ["professional_communication", "leadership", "project_management"]
  };
  return (map[archetypeId] || []).includes(category) ? 0.8 : 0;
}

function combineArchetypePattern(primary, secondaries) {
  if (!primary) return "Evidence suggests a mixed professional profile with limited attributable evidence for a stable archetype pattern.";
  if (!secondaries.length) return primary.summary_template;
  const secondaryLabels = secondaries.map(item => item.label.toLowerCase().replace(/\s*&\s*/g, " and "));
  return `Evidence suggests a ${primary.label.toLowerCase().replace(/\s*&\s*/g, " and ")} profile with meaningful exposure to ${joinHuman(secondaryLabels)}, supported by recurring attributable evidence.`;
}

function combineContribution(primary, secondaries) {
  if (!primary) return "Typically translates professional priorities into clearer actions and stakeholder-aligned execution when enough attributable evidence is available.";
  if (!secondaries.length) return primary.contribution_template;
  const secondaryText = secondaries.map(item => item.label.toLowerCase().replace(/\s*&\s*/g, " and ")).slice(0, 2).join(" and ");
  return `${primary.contribution_template} The profile also shows practical contribution across ${secondaryText}.`;
}

function buildRadarCapabilities(normalized, temporalMaturity, primaryArchetype, secondaryArchetypes) {
  const supported = new Map();
  const canonical = (temporalMaturity && temporalMaturity.dimensions || [])
    .filter(dimension => dimension.derivation === "canonical_ontology_dimension")
    .filter(dimension => !["insufficient_evidence", "counter_evidence_only"].includes(dimension.status));
  for (const dimension of canonical) {
    const label = humanReadableCapability(canonicalDimensionDisplay[dimension.canonical_dimension || dimension.id] || dimension.label || dimension.id);
    supported.set(label, {
      label,
      short_label: shortCapabilityLabel(label),
      canonical_dimension: dimension.canonical_dimension || dimension.id,
      coverage: Number(dimension.evidence_coverage || 0),
      strength: Number(dimension.capability_score || dimension.evidence_coverage || 0),
      confidence: dimension.confidence || "medium",
      level: dimension.status || "observed",
      score: Number(dimension.evidence_coverage || 0),
      sources: ["canonical"]
    });
  }

  const messageStream = collectAttributableUserMessages(normalized);
  const selectedArchetypes = [primaryArchetype].concat(secondaryArchetypes).filter(Boolean);
  for (const archetype of selectedArchetypes) {
    for (const capability of archetype.capability_labels) {
      const label = humanReadableCapability(capability);
      const previous = supported.get(label) || {
        label,
        short_label: shortCapabilityLabel(label),
        canonical_dimension: null,
        coverage: 0,
        strength: 0,
        confidence: "medium",
        level: "observed",
        score: 0,
        sources: []
      };
      const relatedTerms = archetype.signals.slice(0, 16);
      let termHits = 0;
      let directHits = 0;
      for (const message of messageStream) {
        const lower = String(message.lower || "");
        const hits = relatedTerms.filter(term => lower.includes(String(term).toLowerCase())).length;
        if (!hits) continue;
        termHits += hits;
        if (sourceValue(message) === "original_user_input") directHits += hits;
      }
      const evidenceScore = Math.min(100, Math.round(previous.score + termHits * 6 + directHits * 3 + (archetype.preferred_radar_labels.includes(capability) ? 16 : 8)));
      const coverage = Math.max(previous.coverage, Math.min(100, Math.round((termHits * 8) + (directHits * 6))));
      const confidence = directHits >= 4 ? "high" : directHits >= 2 ? "medium" : "low";
      const level = evidenceScore >= 75 ? "strongly_supported" : evidenceScore >= 55 ? "recurring" : "observed";
      supported.set(label, {
        ...previous,
        short_label: shortCapabilityLabel(label),
        coverage,
        strength: Math.max(previous.strength, evidenceScore),
        confidence: previous.confidence === "high" ? "high" : confidence,
        level,
        score: Math.max(previous.score, evidenceScore),
        sources: Array.from(new Set(previous.sources.concat(["archetype"])))
      });
    }
  }

  const ranked = Array.from(supported.values())
    .filter(item => item.label && !/_/.test(item.label))
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 6)
    .map(item => ({
      label: item.label,
      short_label: item.short_label,
      canonical_dimension: item.canonical_dimension,
      coverage: Math.max(35, Math.min(100, Number(item.coverage || 0))),
      strength: Math.max(35, Math.min(100, Number(item.strength || 0))),
      confidence: item.confidence,
      level: item.level
    }));
  return ranked;
}

function buildProfessionalPattern(normalized, temporalMaturity, language = "en") {
  const domainWeighting = buildDomainWeighting(normalized, temporalMaturity);
  const dominant = domainWeighting.dominant_domain;
  const secondaryDomains = domainWeighting.secondary_domains;
  const messages = collectAttributableUserMessages(normalized);

  const scores = professionalArchetypes.map(archetype => {
    let weightedScore = 0;
    let attributableHits = 0;
    let directHits = 0;
    const evidenceIds = [];
    for (const message of messages) {
      const lower = String(message.lower || "");
      const hits = archetype.signals.filter(signal => lower.includes(String(signal).toLowerCase())).length;
      if (!hits) continue;
      const weight = sourceWeight(message);
      weightedScore += Math.max(0.35, hits * weight);
      if (canCreateCapabilityClaim(message)) attributableHits += hits;
      if (sourceValue(message) === "original_user_input") directHits += hits;
      evidenceIds.push(identityEvidenceId("archetype", archetype.id, message, message.conversation));
    }
    for (const conversation of normalized) {
      weightedScore += archetypeCategoryBoost(archetype.id, conversation.professional_category || "other");
    }
    return {
      ...archetype,
      weighted_score: weightedScore,
      attributable_hits: attributableHits,
      direct_hits: directHits,
      evidence_ids: Array.from(new Set(evidenceIds)).slice(0, 18)
    };
  }).sort((a, b) => b.weighted_score - a.weighted_score);

  const top = scores[0];
  const primaryArchetype = top && top.weighted_score >= 2 ? top : null;
  const secondaryArchetypes = scores
    .slice(1)
    .filter(item => primaryArchetype && item.weighted_score >= Math.max(1.4, primaryArchetype.weighted_score * 0.38))
    .slice(0, 3);

  const radarCapabilities = buildRadarCapabilities(normalized, temporalMaturity, primaryArchetype, secondaryArchetypes);
  const observedPattern = combineArchetypePattern(primaryArchetype, secondaryArchetypes);
  const typicalContribution = combineContribution(primaryArchetype, secondaryArchetypes);

  const limitations = [];
  if (!dominant || !dominant.passes_threshold) limitations.push("Dominant domain does not pass minimum evidence thresholds for a strong role label.");
  if (!primaryArchetype) limitations.push("Archetype inference remains conservative because attributable evidence is limited or mixed.");
  if (dominant && dominant.attribution_penalty > 0.22) limitations.push("Attribution penalties are material due to pasted, AI-generated or isolated evidence.");
  if (dominant && dominant.weighted_share < 0.35) limitations.push("Evidence is mixed across domains, so signature remains intentionally neutral.");

  return {
    hierarchy: ["evidence_item", "observed_activity", "capability", "domain", "professional_signature"],
    signature_text: observedPattern,
    signature_mode: primaryArchetype ? "archetype_driven" : "insufficient_evidence",
    dominant_domain: dominant ? dominant.domain : "uncertain",
    secondary_domains: secondaryDomains.map(item => item.domain),
    dominant_domain_share: dominant ? Number(dominant.weighted_share.toFixed(4)) : 0,
    main_capabilities: radarCapabilities.map(item => item.label),
    attribution_note: "Attribution measures how directly evidence comes from user-authored messages versus pasted, AI-generated or external content.",
    thresholds: {
      min_supporting_evidence_items: 3,
      min_distinct_conversations: 2,
      min_direct_user_items: 2,
      min_weighted_share: 0.25
    },
    domain_scores: domainWeighting.domains.map(item => ({
      domain: item.domain,
      weighted_score: Number(item.weighted_score.toFixed(4)),
      weighted_share: Number(item.weighted_share.toFixed(4)),
      supporting_evidence_items: item.supporting_evidence_items,
      distinct_conversations: item.distinct_conversations,
      direct_user_items: item.direct_user_items,
      attributable_items: item.attributable_items,
      diversity_count: item.diversity_count,
      recurrence_factor: Number(item.recurrence_factor.toFixed(3)),
      average_recency: Number(item.average_recency.toFixed(3)),
      attribution_penalty: Number(item.attribution_penalty.toFixed(3)),
      passes_threshold: item.passes_threshold,
      evidence_ids: item.evidence_ids
    })),
    primary_archetype: primaryArchetype ? { id: primaryArchetype.id, label: primaryArchetype.label, score: Number(primaryArchetype.weighted_score.toFixed(3)) } : null,
    secondary_archetypes: secondaryArchetypes.map(item => ({ id: item.id, label: item.label, score: Number(item.weighted_score.toFixed(3)) })),
    observed_professional_pattern: observedPattern,
    professional_domains_observed: domainWeighting.domains.slice(0, 5).map(item => item.domain),
    typical_professional_contribution: typicalContribution,
    radar_capabilities: radarCapabilities,
    limitations
  };
}

function buildProfessionalDomains(normalized, professionalPattern) {
  if (professionalPattern && Array.isArray(professionalPattern.professional_domains_observed) && professionalPattern.professional_domains_observed.length) {
    return professionalPattern.professional_domains_observed.slice(0, 5);
  }
  if (professionalPattern && Array.isArray(professionalPattern.domain_scores) && professionalPattern.domain_scores.length) {
    return professionalPattern.domain_scores
      .slice(0, 5)
      .map(item => item.domain);
  }
  const counts = normalized.reduce((acc, conversation) => {
    const key = conversation.professional_category || "other";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key]) => key);
}

function inferProfessionalIdentity(normalized, temporalMaturity, evidenceCoverage, professionalPattern) {
  const messages = collectAttributableUserMessages(normalized);
  const functionRanking = scoreTaxonomy(messages, professionalFunctions.filter(item => item !== "other"), professionalFunctionSignals, "function");
  const archetypeRanking = scoreTaxonomy(messages, roleArchetypes.filter(item => item !== "other"), archetypeSignals, "archetype");
  const workModeRanking = scoreTaxonomy(messages, workModes, workModeSignals, "work_mode");
  const level = inferOperatingLevel(messages);
  const topFunction = functionRanking[0];
  const secondFunction = functionRanking[1];
  const topArchetype = archetypeRanking[0];
  const topWorkMode = workModeRanking[0];

  const dominantDomain = professionalPattern && professionalPattern.dominant_domain;
  const dominantDomainShare = professionalPattern && professionalPattern.dominant_domain_share || 0;
  const patternPrimaryArchetype = professionalPattern && professionalPattern.primary_archetype && professionalPattern.primary_archetype.id;
  const mappedPrimaryFromDomain = dominantDomain && dominantDomain !== "uncertain" ? domainToFunction(dominantDomain) : "uncertain";
  const primaryFunction = mappedPrimaryFromDomain !== "uncertain"
    ? mappedPrimaryFromDomain
    : (!topFunction || topFunction.score < 2 ? "uncertain" : topFunction.key);
  const secondaryFunctions = functionRanking
    .slice(1)
    .filter(item => item.score >= 2 && (!topFunction || item.key !== topFunction.key))
    .slice(0, 2)
    .map(item => item.key);
  const archetypeNeedsDominance = new Set(["hr_lead", "recruiter", "executive", "director", "partner"]);
  const lowDomainDominance = dominantDomainShare < 0.35;
  let observedArchetype = !topArchetype || topArchetype.score < 2 ? "uncertain" : topArchetype.key;
  if (archetypeNeedsDominance.has(observedArchetype) && lowDomainDominance) observedArchetype = "uncertain";
  if ((observedArchetype === "hr_lead" || observedArchetype === "recruiter") && dominantDomain !== "recruiting") observedArchetype = "uncertain";
  if (professionalPattern && professionalPattern.signature_mode === "neutral_mixed" && topArchetype && topArchetype.score < 4) observedArchetype = "uncertain";
  if (patternPrimaryArchetype) observedArchetype = patternPrimaryArchetype;
  const workMode = !topWorkMode || topWorkMode.score < 2 ? "uncertain" : topWorkMode.key;

  const attributionBase = Math.max(1, Number((evidenceCoverage && evidenceCoverage.total_evidence_items) || 0));
  const directRatio = Number((evidenceCoverage && evidenceCoverage.direct_user_inputs) || 0) / attributionBase;
  const evidencePool = [
    ...(topFunction ? topFunction.evidence.map(item => item.id) : []),
    ...(topArchetype ? topArchetype.evidence.map(item => item.id) : []),
    ...(topWorkMode ? topWorkMode.evidence.map(item => item.id) : []),
    ...level.supporting_evidence_ids
  ];
  const uniqueEvidence = Array.from(new Set(evidencePool)).slice(0, 14);
  const topFunctionDominance = topFunction ? topFunction.score - ((secondFunction && secondFunction.score) || 0) : 0;
  const confidenceScore =
    (uniqueEvidence.length >= 8 ? 2 : uniqueEvidence.length >= 4 ? 1 : 0) +
    (topFunctionDominance >= 2 ? 1 : 0) +
    (directRatio >= 0.45 ? 1 : 0) +
    (level.confidence === "high" ? 1 : level.confidence === "medium" ? 0.5 : 0);
  const confidence = confidenceScore >= 4 ? "high" : confidenceScore >= 2 ? "medium" : "low";

  const limitations = [];
  if (primaryFunction === "uncertain") limitations.push("Insufficient direct evidence to infer a primary professional function.");
  if (observedArchetype === "uncertain") limitations.push("Observed role archetype remains uncertain due to limited attributable role evidence.");
  if (workMode === "uncertain") limitations.push("Work mode is uncertain because ownership and collaboration patterns are weakly evidenced.");
  if (level.operating_level === "uncertain") limitations.push(...level.limitations);
  if (directRatio < 0.35) limitations.push("Attribution quality is limited because direct user-authored evidence is a minority of the dataset.");
  if (professionalPattern && Array.isArray(professionalPattern.limitations)) limitations.push(...professionalPattern.limitations.slice(0, 3));

  return {
    primary_function: primaryFunction,
    secondary_functions: secondaryFunctions,
    observed_archetype: observedArchetype,
    operating_level: level.operating_level,
    work_mode: workMode,
    confidence,
    supporting_evidence_ids: uniqueEvidence,
    limitations
  };
}

function buildDifferentiators(professionalIdentity, roleSpecificCapabilities, professionalDomains, evidenceCoverage) {
  const items = [];
  const strongest = roleSpecificCapabilities
    .filter(capability => ["recurring", "strongly_supported"].includes(capability.evidence_status))
    .sort((a, b) => (b.coverage || 0) - (a.coverage || 0));
  if (strongest[0]) {
    items.push({
      label: strongest[0].label,
      explanation: `Recurring attributable evidence suggests this capability is a distinctive pattern in the observed role profile.`,
      supporting_evidence_ids: strongest[0].supporting_evidence_ids.slice(0, 6)
    });
  }
  if (professionalDomains.length >= 2) {
    items.push({
      label: "Cross-domain operating span",
      explanation: `Evidence spans multiple professional domains (${professionalDomains.slice(0, 3).join(", ")}), indicating non-single-lane contribution patterns.`,
      supporting_evidence_ids: professionalIdentity.supporting_evidence_ids.slice(0, 6)
    });
  }
  const attributableBase = Math.max(1, Number((evidenceCoverage && evidenceCoverage.total_evidence_items) || 0));
  const directRatio = Number((evidenceCoverage && evidenceCoverage.direct_user_inputs) || 0) / attributableBase;
  if (directRatio >= 0.55) {
    items.push({
      label: "High direct attribution",
      explanation: "A large share of evidence is directly user-authored, increasing interpretability of the professional profile.",
      supporting_evidence_ids: professionalIdentity.supporting_evidence_ids.slice(0, 5)
    });
  }
  return items.slice(0, 4);
}

function dimensionByCanonical(temporalMaturity, canonical) {
  return (temporalMaturity && temporalMaturity.dimensions || []).find(dimension =>
    (dimension.canonical_dimension || dimension.id) === canonical
  );
}

function buildWatchOuts(professionalIdentity, roleSpecificCapabilities, temporalMaturity, evidenceCoverage) {
  const watchOuts = [];
  const conversationBreadth = Number((evidenceCoverage && evidenceCoverage.total_professional_conversations) || 0);
  if (conversationBreadth < 4) {
    watchOuts.push({
      label: "Limited evidence breadth",
      explanation: "The profile is built on a narrow conversation base, so role inferences may shift with additional evidence.",
      evidence_ids: professionalIdentity.supporting_evidence_ids.slice(0, 4),
      severity: "medium"
    });
  }

  const communication = dimensionByCanonical(temporalMaturity, "communication");
  if (communication && communication.negative_count > communication.positive_count) {
    watchOuts.push({
      label: "Communication risk",
      explanation: "Counter-evidence on communication outweighs supporting evidence in the selected period.",
      evidence_ids: (communication.counter_evidence || []).map(item => item.id).slice(0, 6),
      severity: "high"
    });
  }

  const collaboration = dimensionByCanonical(temporalMaturity, "collaboration");
  if (collaboration && collaboration.status === "insufficient_evidence") {
    watchOuts.push({
      label: "Collaboration evidence gap",
      explanation: "There is not enough attributable evidence to assess collaboration behavior reliably.",
      evidence_ids: (collaboration.uncertain_evidence || []).map(item => item.id).slice(0, 5),
      severity: "low"
    });
  }

  const weakRoleSpecific = roleSpecificCapabilities.filter(capability => capability.evidence_status === "insufficient_evidence").length;
  if (weakRoleSpecific >= Math.ceil(Math.max(1, roleSpecificCapabilities.length) * 0.45)) {
    watchOuts.push({
      label: "Role-specific coverage is shallow",
      explanation: "Many role-specific capabilities remain under-evidenced, so archetype conclusions should be treated as provisional.",
      evidence_ids: professionalIdentity.supporting_evidence_ids.slice(0, 5),
      severity: "medium"
    });
  }

  return watchOuts.slice(0, 5);
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

const technicalSignalCatalog = {
  programming_languages: ["JavaScript", "TypeScript", "Python", "Java", "C#", "C++", "Go", "Rust", "PHP", "Ruby", "Kotlin", "Swift", "Dart", "Scala", "R", "SQL", "Bash", "PowerShell", "HTML", "CSS"],
  frameworks_libraries: ["React", "Angular", "Vue", "Next.js", "Node.js", "Express", "NestJS", "Django", "Flask", "FastAPI", "Spring Boot", ".NET", "Flutter", "React Native", "Laravel", "Rails", "Pandas", "NumPy", "PySpark"],
  cloud_infrastructure: ["AWS", "Azure", "GCP", "Cloudflare", "Kubernetes", "Docker", "Terraform", "Lambda", "S3", "EC2", "API Gateway", "IAM", "Databricks", "Snowflake"],
  data_bi_tools: ["SQL", "Databricks", "Qlik Sense", "Power BI", "Tableau", "Metabase", "BigQuery", "Redshift", "Snowflake", "Excel", "Google Sheets"],
  security_networking: ["WAF", "SSL", "TLS", "SSL pinning", "OAuth", "SSO", "JWT", "firewall", "whitelist", "allowlist", "DNS", "API security", "Cloudflare rules"],
  collaboration_delivery_tools: ["Jira", "Confluence", "Asana", "Trello", "GitHub", "GitLab", "Bitbucket", "Slack", "Teams", "Notion"]
};

function technicalTermRegex(term) {
  const escaped = String(term || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped.replace(/\\\s+/g, "\\\\s+")}\\b`, "i");
}

function exposureForMention(message, rawText) {
  const source = sourceValue(message);
  const text = String(rawText || "").toLowerCase();
  if (["pasted_external_document", "pasted_job_description"].includes(source)) return "third_party_context";
  if (["pasted_code", "pasted_code_authored_by_user"].includes(source)) return "pasted_code";
  if (/\b(help|aiutami|does not work|non funziona|errore|fix|debug|issue|support|come faccio|how do i)\b/.test(text)) return "requested_help";
  if (/\b(i built|i use|i wrote|i implemented|i configured|ho usato|uso|implemento|configuro|scrivo|gestisco|integro|deploy)\b/.test(text)) return "used_directly";
  if (source === "original_user_input" || source === "mixed_content") return "discussed";
  return "unknown";
}

function aggregateExposure(exposures) {
  const rank = {
    used_directly: 6,
    pasted_code: 5,
    requested_help: 4,
    discussed: 3,
    third_party_context: 2,
    unknown: 1
  };
  const best = exposures.slice().sort((a, b) => (rank[b] || 0) - (rank[a] || 0))[0] || "unknown";
  return best;
}

function exposureUiLabel(exposure) {
  const map = {
    used_directly: "Direct",
    discussed: "Discussed",
    requested_help: "Assisted",
    pasted_code: "Direct",
    third_party_context: "External context",
    unknown: "Unknown"
  };
  return map[exposure] || "Unknown";
}

function buildTechnicalSignalsObserved(normalized) {
  const rows = {
    programming_languages: new Map(),
    frameworks_libraries: new Map(),
    cloud_infrastructure: new Map(),
    data_bi_tools: new Map(),
    security_networking: new Map(),
    collaboration_delivery_tools: new Map()
  };

  const userMessages = normalized.flatMap(conversation =>
    (conversation.messages || [])
      .filter(message => message.author === "user")
      .map(message => ({ message, conversation, text: String(message.text || "") }))
  );

  for (const [group, terms] of Object.entries(technicalSignalCatalog)) {
    for (const term of terms) {
      const regex = technicalTermRegex(term);
      const exposures = [];
      const evidenceIds = [];
      for (const entry of userMessages) {
        if (!regex.test(entry.text)) continue;
        exposures.push(exposureForMention(entry.message, entry.text));
        evidenceIds.push(identityEvidenceId("technical", `${group}:${term.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`, entry.message, entry.conversation));
      }
      if (!exposures.length) continue;
      const dominantExposure = aggregateExposure(exposures);
      rows[group].set(term, {
        name: term,
        exposure: dominantExposure,
        attribution_label: exposureUiLabel(dominantExposure),
        mentions: exposures.length,
        evidence_ids: Array.from(new Set(evidenceIds)).slice(0, 10)
      });
    }
  }

  return {
    programming_languages: Array.from(rows.programming_languages.values()).sort((a, b) => b.mentions - a.mentions),
    frameworks_libraries: Array.from(rows.frameworks_libraries.values()).sort((a, b) => b.mentions - a.mentions),
    cloud_infrastructure: Array.from(rows.cloud_infrastructure.values()).sort((a, b) => b.mentions - a.mentions),
    data_bi_tools: Array.from(rows.data_bi_tools.values()).sort((a, b) => b.mentions - a.mentions),
    security_networking: Array.from(rows.security_networking.values()).sort((a, b) => b.mentions - a.mentions),
    collaboration_delivery_tools: Array.from(rows.collaboration_delivery_tools.values()).sort((a, b) => b.mentions - a.mentions)
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
  const skill_passport = buildSkillPassport(normalized);
  const privateVisualProfile = buildVisualProfile(normalized, insights, false);
  const publicVisualProfile = buildVisualProfile(normalized, insights, true);
  const privateTechnologyReasoning = buildTechnologyReasoning(normalized, insights, false);
  const publicTechnologyReasoning = buildTechnologyReasoning(normalized, insights, true);
  const privateTemporalMaturity = extractTemporalEvidence(normalized, false);
  const publicTemporalMaturity = extractTemporalEvidence(normalized, true);
  const privateEvidenceCoverage = buildEvidenceCoverage(normalized, privateTemporalMaturity);
  const publicEvidenceCoverage = buildEvidenceCoverage(normalized, publicTemporalMaturity);
  const professionalPattern = buildProfessionalPattern(normalized, privateTemporalMaturity);
  const technicalSignalsObserved = buildTechnicalSignalsObserved(normalized);
  const professionalIdentity = inferProfessionalIdentity(normalized, privateTemporalMaturity, privateEvidenceCoverage, professionalPattern);
  const professionalDomains = buildProfessionalDomains(normalized, professionalPattern);
  const roleSpecificCapabilities = buildRoleSpecificCapabilities(normalized, professionalIdentity);
  const differentiators = buildDifferentiators(professionalIdentity, roleSpecificCapabilities, professionalDomains, privateEvidenceCoverage);
  const watchOuts = buildWatchOuts(professionalIdentity, roleSpecificCapabilities, privateTemporalMaturity, privateEvidenceCoverage);
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
    professional_pattern: professionalPattern,
    observed_professional_pattern: professionalPattern.observed_professional_pattern,
    professional_domains_observed: professionalPattern.professional_domains_observed,
    typical_professional_contribution: professionalPattern.typical_professional_contribution,
    professional_identity: professionalIdentity,
    professional_domains: professionalDomains,
    technical_signals_observed: technicalSignalsObserved,
    role_specific_capabilities: roleSpecificCapabilities,
    differentiators: differentiators,
    watch_outs: watchOuts,
    skill_passport,
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
      title: config ? `AI Work Passport - ${config.profile_name}` : "Private AI Work Passport",
      report_config: config,
      generated_at: kpis.generated_at,
      period: config ? { from: config.period_from, to: config.period_to, selected_months: config.selected_months } : { first_data: range.first, last_data: range.last },
      limits: [
        "Le conversazioni AI rappresentano solo una parte del comportamento professionale.",
        "Le inferenze possono essere errate e richiedono revisione umana.",
        "Il profilo non e' una diagnosi psicologica e non deve essere usato come unico criterio di selezione."
      ],
      insights,
      professional_pattern: professionalPattern,
      observed_professional_pattern: professionalPattern.observed_professional_pattern,
      professional_domains_observed: professionalPattern.professional_domains_observed,
      typical_professional_contribution: professionalPattern.typical_professional_contribution,
      professional_identity: professionalIdentity,
      professional_domains: professionalDomains,
      technical_signals_observed: technicalSignalsObserved,
      role_specific_capabilities: roleSpecificCapabilities,
      differentiators,
      watch_outs: watchOuts,
      skill_passport,
      kpis,
      visual_profile: privateVisualProfile,
      technology_reasoning: privateTechnologyReasoning,
      temporal_maturity: privateTemporalMaturity,
      evidence_coverage_detail: privateEvidenceCoverage
    },
    public_report: {
      title: config ? `AI Work Passport - ${config.profile_name}` : "Shareable AI Work Passport",
      report_config: config,
      generated_at: kpis.generated_at,
      period: config ? { from: config.period_from, to: config.period_to, selected_months: config.selected_months } : { first_data: range.first, last_data: range.last },
      kpis,
      professional_pattern: professionalPattern,
      observed_professional_pattern: professionalPattern.observed_professional_pattern,
      professional_domains_observed: professionalPattern.professional_domains_observed,
      typical_professional_contribution: professionalPattern.typical_professional_contribution,
      professional_identity: professionalIdentity,
      professional_domains: professionalDomains,
      technical_signals_observed: technicalSignalsObserved,
      role_specific_capabilities: roleSpecificCapabilities,
      differentiators,
      watch_outs: watchOuts,
      skill_passport,
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

function pdfBuffer(render) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false, compress: false, info: { Producer: "AI Work Passport" } });
    const chunks = [];
    doc.on("data", chunk => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    render(doc);
    doc.end();
  });
}

function drawRoundedPanel(doc, x, y, width, height, options = {}) {
  const radius = options.radius || 10;
  doc.save();
  doc.roundedRect(x, y, width, height, radius);
  doc.fillAndStroke(options.fill || "#ffffff", options.stroke || "#d7e1de");
  doc.restore();
}

function drawChipRow(doc, items, x, y, maxWidth, options = {}) {
  let cursorX = x;
  let cursorY = y;
  const gap = options.gap || 6;
  const fontSize = options.fontSize || 9;
  const chipHeight = options.chipHeight || 16;
  const maxRows = options.maxRows || Number.POSITIVE_INFINITY;
  let rowsUsed = 1;
  for (const item of items) {
    const label = String(item || "");
    const width = Math.min(maxWidth, doc.widthOfString(label, { size: fontSize }) + 18);
    if (cursorX + width > x + maxWidth) {
      if (rowsUsed >= maxRows) break;
      cursorX = x;
      cursorY += chipHeight + 4;
      rowsUsed += 1;
    }
    doc.save();
    doc.roundedRect(cursorX, cursorY, width, chipHeight, 8).fill("#e8f1ef");
    doc.fillColor("#21423d").font("Helvetica-Bold").fontSize(fontSize).text(label, cursorX + 9, cursorY + 4, { width: width - 12, lineBreak: false });
    doc.restore();
    cursorX += width + gap;
  }
  return cursorY + chipHeight + 2;
}

function drawSegmentBar(doc, segments, x, y, width, height) {
  const palette = { direct: "#16877f", mixed: "#2aa79e", external: "#7c8d89", ai: "#c48d2f", unknown: "#a1b1ad" };
  const total = segments.reduce((sum, segment) => sum + Number(segment.value || 0), 0) || 1;
  let cursorX = x;
  for (const segment of segments) {
    const segmentWidth = width * (Number(segment.value || 0) / total);
    doc.save();
    doc.rect(cursorX, y, segmentWidth, height).fill(palette[segment.tone] || "#cfd8d0");
    doc.restore();
    cursorX += segmentWidth;
  }
}

function measureTextHeight(doc, text, width, style = {}) {
  doc.save();
  doc.font(style.font || "Helvetica").fontSize(style.fontSize || 10);
  const height = doc.heightOfString(String(text || ""), {
    width,
    lineGap: style.lineGap ?? 1,
    align: style.align || "left"
  });
  doc.restore();
  return height;
}

function truncateTextToHeight(doc, text, width, maxHeight, style = {}) {
  const source = String(text || "").trim();
  if (!source) return "";
  const words = source.split(/\s+/).filter(Boolean);
  let candidate = source;
  while (candidate && measureTextHeight(doc, candidate, width, style) > maxHeight && words.length > 1) {
    words.pop();
    const base = words.join(" ").trim();
    candidate = /[.,;:!?]$/.test(base) ? base : `${base}.`;
  }
  return candidate || source;
}

function drawFittedText(doc, text, x, y, width, height, style = {}) {
  const minSize = style.minFontSize || 8;
  let fontSize = style.maxFontSize || 12;
  const content = String(text || "").trim();
  while (fontSize >= minSize) {
    const measureStyle = { ...style, fontSize };
    const fitted = truncateTextToHeight(doc, content, width, height, measureStyle);
    if (measureTextHeight(doc, fitted, width, measureStyle) <= height) {
      doc.save();
      doc.font(style.font || "Helvetica").fontSize(fontSize).fillColor(style.color || "#1f2726");
      doc.text(fitted, x, y, { width, height, lineGap: style.lineGap ?? 1, align: style.align || "left", ellipsis: true });
      doc.restore();
      return;
    }
    fontSize -= 0.5;
  }
  doc.save();
  doc.font(style.font || "Helvetica").fontSize(minSize).fillColor(style.color || "#1f2726");
  doc.text(truncateTextToHeight(doc, content, width, height, { ...style, fontSize: minSize }), x, y, { width, height, lineGap: style.lineGap ?? 1, align: style.align || "left", ellipsis: true });
  doc.restore();
}

function compactPdfLabel(label) {
  const words = String(label || "").split(/\s+/).filter(Boolean);
  if (words.length <= 1) return [String(label || "")];
  if (String(label || "").length <= 16) return [String(label || "")];
  let firstLine = [];
  let secondLine = [];
  for (const word of words) {
    if (!firstLine.length || `${firstLine.join(" ")} ${word}`.trim().length <= 16) firstLine.push(word);
    else secondLine.push(word);
  }
  if (!secondLine.length) {
    const middle = Math.ceil(words.length / 2);
    return [words.slice(0, middle).join(" "), words.slice(middle).join(" ")];
  }
  return [firstLine.join(" "), secondLine.join(" ")];
}

function pdfStatusLabel(status, language = "en") {
  const map = language === "it"
    ? {
        insufficient_evidence: "Non valutata",
        counter_evidence_only: "Solo contro-evidenze",
        mixed_evidence: "Evidenza mista",
        emerging: "Emergente",
        observed: "Osservata",
        recurring: "Ricorrente",
        strongly_supported: "Fortemente supportata"
      }
    : {
        insufficient_evidence: "Not assessed",
        counter_evidence_only: "Counter-evidence only",
        mixed_evidence: "Mixed evidence",
        emerging: "Emerging",
        observed: "Observed",
        recurring: "Recurring",
        strongly_supported: "Strongly supported"
      };
  return map[status] || String(status || "Not assessed").replace(/_/g, " ");
}

function pdfConfidenceLabel(confidence, language = "en") {
  const map = language === "it" ? { high: "Alta", medium: "Media", low: "Bassa" } : { high: "High", medium: "Medium", low: "Low" };
  return map[String(confidence || "").toLowerCase()] || String(confidence || "Low");
}

function pdfCoverageMeta(value, language = "en") {
  const score = Number(value || 0);
  if (score >= 75) return { label: language === "it" ? "Alta copertura" : "High coverage", color: "#136f63" };
  if (score >= 45) return { label: language === "it" ? "Copertura media" : "Medium coverage", color: "#8d6a1b" };
  return { label: language === "it" ? "Copertura limitata" : "Limited coverage", color: "#b64f35" };
}

function pdfSegmentValue(mix, tone) {
  return Number(((mix && mix.segments) || []).find(segment => segment.tone === tone)?.value || 0);
}

function buildCapabilityRows(axes, language = "en") {
  return (axes || []).slice(0, 5).map(axis => {
    const coverage = Number(axis.coverage || 0);
    return {
      label: String(axis.label || "").split(/\s+/).slice(0, 2).join(" "),
      maturity: axis.statusLabel || pdfStatusLabel(axis.level, language),
      confidence: axis.confidenceLabel || pdfConfidenceLabel(axis.confidence, language),
      coverage,
      coverageMeta: pdfCoverageMeta(coverage, language)
    };
  });
}

function buildAttributionSummary(evidenceMix, language = "en") {
  const direct = pdfSegmentValue(evidenceMix, "direct");
  const mixed = pdfSegmentValue(evidenceMix, "mixed");
  const external = pdfSegmentValue(evidenceMix, "external") + pdfSegmentValue(evidenceMix, "ai") + pdfSegmentValue(evidenceMix, "unknown");
  return {
    weightedAttribution: Number(evidenceMix && evidenceMix.attributable || 0),
    lines: language === "it"
      ? [
          `Direttamente attribuibile: ${direct}%`,
          `Mista o parzialmente attribuibile: ${mixed}%`,
          `Contesto esterno o generato da AI: ${external}%`
        ]
      : [
          `Directly attributable: ${direct}%`,
          `Mixed or partially attributable: ${mixed}%`,
          `External or AI-generated context: ${external}%`
        ]
  };
}

function drawRadarPdf(doc, axes, x, y, size, texts) {
  const assessed = (axes || []).filter(axis => axis && axis.assessed && typeof axis.strength === "number");
  if (!assessed.length) {
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#1f2726").text(texts.notAssessed, x, y, { width: size });
    return;
  }
  const centerX = x + size / 2;
  const centerY = y + size / 2;
  const maxRadius = size * 0.31;
  const levels = [0.25, 0.5, 0.75, 1];
  const points = assessed.map((axis, index) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / assessed.length;
    const radius = maxRadius * ((axis.strength || 0) / 100);
    const labelDistance = maxRadius + 22;
    return {
      axis,
      angle,
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
      axisX: centerX + Math.cos(angle) * maxRadius,
      axisY: centerY + Math.sin(angle) * maxRadius,
      labelX: centerX + Math.cos(angle) * labelDistance,
      labelY: centerY + Math.sin(angle) * labelDistance
    };
  });

  doc.save();
  for (const level of levels) {
    doc.moveTo(centerX + Math.cos(points[0].angle) * maxRadius * level, centerY + Math.sin(points[0].angle) * maxRadius * level);
    for (let index = 1; index < points.length; index += 1) {
      doc.lineTo(centerX + Math.cos(points[index].angle) * maxRadius * level, centerY + Math.sin(points[index].angle) * maxRadius * level);
    }
    doc.closePath().strokeColor("#cfd8d0").lineWidth(1).stroke();
  }
  for (const point of points) {
    doc.moveTo(centerX, centerY).lineTo(point.axisX, point.axisY).strokeColor("#d7ddd5").lineWidth(1).stroke();
  }
  doc.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length; index += 1) doc.lineTo(points[index].x, points[index].y);
  doc.closePath().fillOpacity(0.22).fillAndStroke("#16877f", "#136f63");
  doc.fillOpacity(1);
  for (const point of points) {
    doc.circle(point.x, point.y, 3.5).fill("#b64f35");
    const lines = compactPdfLabel(point.axis.label);
    doc.fillColor("#1f2726").font("Helvetica-Bold").fontSize(8);
    lines.forEach((line, idx) => {
      doc.text(line, point.labelX - 36, point.labelY - 7 + idx * 9, { width: 72, align: "center", lineBreak: false });
    });
  }
  doc.restore();
}

function validateSnapshotPayload(snapshot) {
  if (!snapshot || typeof snapshot !== "object") throw new Error("Snapshot payload is required.");
  if (!Array.isArray(snapshot.kpis) || !Array.isArray(snapshot.axes)) throw new Error("Snapshot payload is invalid.");
  return snapshot;
}

async function renderSnapshotPdf(snapshot, reportConfig) {
  const config = normalizeReportConfig(reportConfig || snapshot.config || {});
  const model = validateSnapshotPayload(snapshot);
  return pdfBuffer(doc => {
    doc.addPage({ size: "A4", layout: "landscape", margins: { top: 24, bottom: 24, left: 24, right: 24 } });
    const language = config.report_language || "en";
    const pageWidth = doc.page.width;
    const margin = 24;
    const gap = 12;
    const contentWidth = pageWidth - margin * 2;
    const safeAxes = (model.axes || []).slice(0, 5).map(axis => ({
      ...axis,
      statusLabel: axis.statusLabel || pdfStatusLabel(axis.level, language),
      confidenceLabel: axis.confidenceLabel || pdfConfidenceLabel(axis.confidence, language),
      assessed: axis.assessed !== false && typeof axis.strength === "number"
    }));
    const capabilityRows = buildCapabilityRows(safeAxes, language);
    const attribution = buildAttributionSummary(model.evidenceMix || { attributable: 0, segments: [] }, language);
    const weightedLabel = language === "it" ? "Attribuzione pesata" : "Weighted attribution";
    const methodologyTitle = language === "it" ? "Nota metodologica" : "Methodology note";
    const disclaimerTitle = language === "it" ? "Verifica e limiti" : "Verification and limits";
    const methodologyNote = language === "it"
      ? "La coverage misura disponibilita, ricorrenza e attribuzione dell'evidenza. Non e' un punteggio di abilita."
      : "Coverage measures evidence availability, recurrence and attribution. It is not a skill score.";
    const baseVerification = String(model.verificationLabel || "AI-assisted report · User-provided content · Not independently verified");
    const footerDisclaimer = language === "it"
      ? `${baseVerification} · Estrazione ${model.extractedDate} · ${APP_VERSION}`
      : `${baseVerification} · Extracted ${model.extractedDate} · ${APP_VERSION}`;
    const headerY = 24;
    const headerH = 78;
    const identityY = headerY + headerH + gap;
    const identityH = 92;
    const kpiY = identityY + identityH + gap;
    const kpiH = 64;
    const capabilityY = kpiY + kpiH + gap;
    const capabilityH = 194;
    const footerY = capabilityY + capabilityH + gap;
    const footerH = 58;

    drawRoundedPanel(doc, margin, headerY, contentWidth, headerH, { fill: "#142322", stroke: "#142322", radius: 16 });
    doc.fillColor("#14a69a").font("Helvetica-Bold").fontSize(11).text(model.texts.snapshotTitle, margin + 18, headerY + 16);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(24).text(model.personName, margin + 18, headerY + 32, { width: 360, lineBreak: false });
    drawFittedText(doc, model.professionalSignature, margin + 18, headerY + 54, 390, 18, {
      font: "Helvetica",
      maxFontSize: 9,
      minFontSize: 8,
      color: "#d8e4e1",
      lineGap: 0
    });
    const metaX = pageWidth - 230;
    doc.fillColor("#c8d3d0").font("Helvetica-Bold").fontSize(9)
      .text(String(model.texts.extractedLabel || "EXTRACTED").toUpperCase(), metaX, headerY + 16, { width: 82 })
      .text(String(model.texts.dataAnalyzedLabel || "DATA ANALYZED").toUpperCase(), metaX, headerY + 37, { width: 100 })
      .text(String(model.texts.observationPeriodLabel || "OBSERVATION PERIOD").toUpperCase(), metaX, headerY + 58, { width: 120 });
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(10)
      .text(String(model.extractedDate), metaX + 92, headerY + 16, { width: 116, align: "right", lineBreak: false })
      .text(String(model.observationPeriod), metaX + 92, headerY + 58, { width: 116, align: "right", lineBreak: false });
    drawFittedText(doc, String(model.dataRange), metaX + 70, headerY + 36, 138, 18, {
      font: "Helvetica-Bold",
      maxFontSize: 9,
      minFontSize: 7.5,
      color: "#ffffff",
      align: "right",
      lineGap: 0
    });

    const identityColA = 352;
    const identityColB = 176;
    const identityColC = contentWidth - identityColA - identityColB - gap * 2;
    const signatureX = margin;
    const domainsX = signatureX + identityColA + gap;
    const contributionX = domainsX + identityColB + gap;

    drawRoundedPanel(doc, signatureX, identityY, identityColA, identityH);
    doc.fillColor("#136f63").font("Helvetica-Bold").fontSize(9).text(String(model.texts.signatureLabel).toUpperCase(), signatureX + 14, identityY + 12);
    drawFittedText(doc, model.professionalSignature, signatureX + 14, identityY + 28, identityColA - 28, 48, {
      font: "Helvetica-Bold",
      maxFontSize: 13,
      minFontSize: 10,
      color: "#1f2726",
      lineGap: 1
    });

    drawRoundedPanel(doc, domainsX, identityY, identityColB, identityH);
    doc.fillColor("#136f63").font("Helvetica-Bold").fontSize(9).text(String(model.texts.domainsLabel).toUpperCase(), domainsX + 14, identityY + 12);
    drawChipRow(doc, (model.observedDomains || []).slice(0, 4), domainsX + 14, identityY + 34, identityColB - 28, {
      fontSize: 8,
      chipHeight: 15,
      gap: 4,
      maxRows: 3
    });

    drawRoundedPanel(doc, contributionX, identityY, identityColC, identityH);
    doc.fillColor("#136f63").font("Helvetica-Bold").fontSize(9).text(String(model.texts.contributionLabel).toUpperCase(), contributionX + 14, identityY + 12);
    drawFittedText(doc, model.typicalContribution, contributionX + 14, identityY + 30, identityColC - 28, 48, {
      font: "Helvetica",
      maxFontSize: 11,
      minFontSize: 9,
      color: "#1f2726",
      lineGap: 1
    });

    const kpiWidth = (contentWidth - gap * 3) / 4;
    model.kpis.slice(0, 4).forEach((kpi, index) => {
      const x = margin + index * (kpiWidth + gap);
      drawRoundedPanel(doc, x, kpiY, kpiWidth, kpiH, { fill: "#f7faf9", stroke: "#d7e1de", radius: 12 });
      doc.fillColor("#136f63").font("Helvetica-Bold").fontSize(18).text(String(kpi.value), x + 12, kpiY + 12, { width: kpiWidth - 24, lineBreak: false });
      drawFittedText(doc, String(kpi.label).toUpperCase(), x + 12, kpiY + 35, kpiWidth - 24, 14, {
        font: "Helvetica-Bold",
        maxFontSize: 7.4,
        minFontSize: 6.8,
        color: "#1f2726",
        lineGap: 0
      });
      drawFittedText(doc, String(kpi.note), x + 12, kpiY + 47, kpiWidth - 24, 12, {
        font: "Helvetica",
        maxFontSize: 7.2,
        minFontSize: 7,
        color: "#5f6d69",
        lineGap: 0
      });
    });

    drawRoundedPanel(doc, margin, capabilityY, contentWidth, capabilityH, { radius: 14 });
    doc.fillColor("#136f63").font("Helvetica-Bold").fontSize(9).text(String(model.texts.capabilityTitle).toUpperCase(), margin + 16, capabilityY + 14);
    doc.fillColor("#1f2726").font("Helvetica-Bold").fontSize(18).text(model.texts.radarQuestion, margin + 16, capabilityY + 28, { width: 290 });
    const chartX = margin + 20;
    const chartY = capabilityY + 62;
    drawRadarPdf(doc, safeAxes, chartX, chartY, 154, model.texts);
    drawFittedText(doc, methodologyNote, chartX, capabilityY + 174, 238, 18, {
      font: "Helvetica",
      maxFontSize: 7.5,
      minFontSize: 7,
      color: "#5f6d69",
      lineGap: 0
    });

    const listX = margin + 290;
    const listWidth = contentWidth - 308;
    capabilityRows.forEach((row, index) => {
      const rowY = capabilityY + 52 + index * 30;
      drawRoundedPanel(doc, listX, rowY, listWidth, 26, { fill: "#f7faf9", stroke: "#d7e1de", radius: 10 });
      doc.fillColor("#1f2726").font("Helvetica-Bold").fontSize(9.5).text(row.label, listX + 12, rowY + 7, { width: 150, lineBreak: false });
      const compactSummary = `${row.maturity} · ${row.coverageMeta.label} · AI ${row.confidence}`;
      drawFittedText(doc, compactSummary, listX + 176, rowY + 7, listWidth - 188, 12, {
        font: "Helvetica",
        maxFontSize: 7.8,
        minFontSize: 7,
        color: "#5f6d69",
        lineGap: 0
      });
      doc.fillColor("#5f6d69").font("Helvetica-Bold").fontSize(7.5).text(`${language === "it" ? "Coverage" : "Coverage"} ${row.coverage}`, listX + listWidth - 70, rowY + 16, { width: 58, align: "right", lineBreak: false });
    });

    drawRoundedPanel(doc, margin, footerY, contentWidth, footerH, { fill: "#f7faf9", stroke: "#d7e1de", radius: 12 });
    const footerColA = 262;
    const footerColB = 238;
    const footerColC = contentWidth - footerColA - footerColB - gap * 2;
    doc.fillColor("#136f63").font("Helvetica-Bold").fontSize(8.5).text(String(model.texts.provenancePanelTitle || (language === "it" ? "Sintesi attribuzione" : "Attribution summary")).toUpperCase(), margin + 14, footerY + 10);
    doc.fillColor("#5f6d69").font("Helvetica-Bold").fontSize(8).text(`${weightedLabel}: ${attribution.weightedAttribution}%`, margin + footerColA - 118, footerY + 10, { width: 104, align: "right", lineBreak: false });
    drawSegmentBar(doc, model.evidenceMix.segments || [], margin + 14, footerY + 23, footerColA - 28, 8);
    attribution.lines.forEach((line, index) => {
      doc.fillColor("#5f6d69").font("Helvetica").fontSize(7.2).text(line, margin + 14, footerY + 34 + index * 7, { width: footerColA - 28, lineBreak: false });
    });

    const methodX = margin + footerColA + gap;
    doc.fillColor("#136f63").font("Helvetica-Bold").fontSize(8.5).text(methodologyTitle.toUpperCase(), methodX, footerY + 10);
    drawFittedText(doc, methodologyNote, methodX, footerY + 24, footerColB, 24, {
      font: "Helvetica",
      maxFontSize: 7.5,
      minFontSize: 7,
      color: "#5f6d69",
      lineGap: 0
    });
    doc.fillColor("#1f2726").font("Helvetica-Bold").fontSize(7.5).text(language === "it" ? "Evidence items analizzati" : "Evidence items analyzed", methodX, footerY + 49, { width: 94, lineBreak: false });
    doc.text(String(model.totalEvidenceItemCount || 0), methodX + 98, footerY + 49, { width: 22, lineBreak: false });
    doc.text(language === "it" ? "Conversazioni considerate" : "Conversations analyzed", methodX + 126, footerY + 49, { width: 96, lineBreak: false });
    doc.text(String(model.analyzedConversationCount || 0), methodX + 226, footerY + 49, { width: 20, lineBreak: false });

    const disclaimerX = methodX + footerColB + gap;
    doc.fillColor("#136f63").font("Helvetica-Bold").fontSize(8.5).text(disclaimerTitle.toUpperCase(), disclaimerX, footerY + 10);
    drawFittedText(doc, footerDisclaimer, disclaimerX, footerY + 24, footerColC, 20, {
      font: "Helvetica",
      maxFontSize: 7.5,
      minFontSize: 7,
      color: "#5f6d69",
      lineGap: 0
    });
  });
}

async function renderAppendixPdf(snapshot, reportConfig) {
  const config = normalizeReportConfig(reportConfig || snapshot.config || {});
  const model = validateSnapshotPayload(snapshot);
  return pdfBuffer(doc => {
    doc.addPage({ size: "A4", margins: { top: 34, bottom: 34, left: 34, right: 34 } });
    const language = config.report_language || model.language || "en";
    const representativeNote = language === "it"
      ? "Gli estratti sono una selezione rappresentativa e non esaustiva del periodo analizzato."
      : "Excerpts are representative selections and not a full transcript of the analyzed period.";
    const verificationNote = language === "it"
      ? "Nota di verifica: i contenuti derivano da input utente e possono includere materiale incollato o generato da AI; non sono verificati in modo indipendente."
      : "Verification note: content is user-provided and may include pasted or AI-generated material; it is not independently verified.";
    const cleanText = (value, fallback = "") => {
      const normalized = String(value || "")
        .replace(/\s+/g, " ")
        .replace(/\bContent origin:\s*\.?/gi, "")
        .trim();
      return normalized || fallback;
    };
    const addHeader = () => {
      doc.fillColor("#136f63").font("Helvetica-Bold").fontSize(12).text(model.texts.appendixTitle, 34, 34);
      doc.fillColor("#1f2726").font("Helvetica-Bold").fontSize(20).text(model.personName, 34, 52);
      doc.fillColor("#5f6d69").font("Helvetica").fontSize(10).text(cleanText(model.texts.appendixSubtitle || model.texts.appendixIntro), 34, 72, { width: doc.page.width - 68 });
      doc.fillColor("#5f6d69").font("Helvetica").fontSize(10).text(`${model.selectedConversationCount} ${model.texts.selectedConversations} ${model.texts.outOfAnalyzed} ${model.analyzedConversationCount} ${model.texts.analyzedLabel}`, 34, 90)
        .text(`${model.selectedExcerptCount} ${model.texts.selectedExcerpts} ${model.texts.outOfEvidence} ${model.totalEvidenceItemCount} ${model.texts.evidenceLabel}`, 34, 104);
      return 142;
    };
    const drawCard = (title, meta, body, badge) => {
      const width = doc.page.width - 68;
      const titleText = cleanText(title, language === "it" ? "Conversazione" : "Conversation");
      const metaText = cleanText(meta, language === "it" ? "Dettagli non disponibili" : "Details unavailable");
      const bodyText = cleanText(body, language === "it" ? "Estratto non disponibile." : "Excerpt unavailable.");
      const titleLine = truncateTextToHeight(doc, titleText, width - 140, 26, { font: "Helvetica-Bold", fontSize: 12, lineGap: 1 });
      const metaLine = truncateTextToHeight(doc, metaText, width - 28, 14, { font: "Helvetica-Bold", fontSize: 9, lineGap: 1 });
      const bodyLine = truncateTextToHeight(doc, bodyText, width - 28, 30, { font: "Helvetica", fontSize: 10, lineGap: 1 });
      const titleHeight = measureTextHeight(doc, titleLine, width - 140, { font: "Helvetica-Bold", fontSize: 12, lineGap: 1 });
      const metaHeight = measureTextHeight(doc, metaLine, width - 28, { font: "Helvetica-Bold", fontSize: 9, lineGap: 1 });
      const bodyHeight = measureTextHeight(doc, bodyLine, width - 28, { font: "Helvetica", fontSize: 10, lineGap: 1 });
      const height = Math.max(86, 16 + titleHeight + 4 + metaHeight + 6 + bodyHeight + 14);
      if (cursorY + height > doc.page.height - 50) {
        doc.addPage({ size: "A4", margins: { top: 34, bottom: 34, left: 34, right: 34 } });
        cursorY = addHeader();
      }
      drawRoundedPanel(doc, 34, cursorY, width, height);
      doc.fillColor("#1f2726").font("Helvetica-Bold").fontSize(12).text(titleLine, 48, cursorY + 14, { width: width - 140 });
      if (badge) {
        doc.fillColor("#136f63").font("Helvetica-Bold").fontSize(9).text(cleanText(badge), doc.page.width - 130, cursorY + 16, { width: 82, align: "right" });
      }
      const metaY = cursorY + 16 + titleHeight + 2;
      const bodyY = metaY + metaHeight + 4;
      doc.fillColor("#5f6d69").font("Helvetica-Bold").fontSize(9).text(metaLine, 48, metaY, { width: width - 28 });
      doc.fillColor("#1f2726").font("Helvetica").fontSize(10).text(bodyLine, 48, bodyY, { width: width - 28, height: bodyHeight + 2 });
      cursorY += height + 10;
    };

    let cursorY = addHeader();
    drawFittedText(doc, representativeNote, 34, cursorY, doc.page.width - 68, 16, {
      font: "Helvetica",
      maxFontSize: 8.8,
      minFontSize: 8,
      color: "#5f6d69",
      lineGap: 0
    });
    cursorY += 20;
    doc.fillColor("#136f63").font("Helvetica-Bold").fontSize(11).text(model.texts.analyzedConversations, 34, cursorY);
    cursorY += 18;
    (model.analyzedConversations || []).forEach(item => {
      drawCard(item.title, `${cleanText(item.date, "-")} · ${cleanText(item.category, language === "it" ? "non classificata" : "uncategorized")}`, item.excerpt, null);
    });
    cursorY += 8;
    doc.fillColor("#136f63").font("Helvetica-Bold").fontSize(11).text(model.texts.evidenceItems, 34, cursorY);
    cursorY += 18;
    (model.evidenceHighlights || []).forEach(item => {
      const meta = `${cleanText(item.group)} · ${cleanText(item.title)}${item.date ? ` · ${cleanText(String(item.date).slice(0, 10))}` : ""}`;
      drawCard(item.skill, meta, item.excerpt, item.confidence || "");
    });
    if (cursorY + 24 > doc.page.height - 34) {
      doc.addPage({ size: "A4", margins: { top: 34, bottom: 34, left: 34, right: 34 } });
      cursorY = addHeader();
    }
    doc.fillColor("#5f6d69").font("Helvetica").fontSize(8.5).text(verificationNote, 34, cursorY + 8, { width: doc.page.width - 68 });
  });
}

function sendPdf(res, fileName, buffer) {
  res.writeHead(200, {
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="${fileName}"`,
    "Content-Length": buffer.length,
    "Cache-Control": "no-store"
  });
  res.end(buffer);
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
    const requestPath = getRequestPath(req);
    if (req.method === "GET" && requestPath === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        runtime: IS_VERCEL ? "vercel" : "local",
        timestamp: new Date().toISOString()
      });
      return;
    }
    if (req.method === "GET" && requestPath === "/api/version") {
      sendJson(res, 200, { version: APP_VERSION });
      return;
    }
    if (req.method === "POST" && requestPath === "/api/import") {
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
    if (req.method === "POST" && requestPath === "/api/analyze") {
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
    if (req.method === "POST" && requestPath === "/api/report") {
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
    if (req.method === "POST" && requestPath === "/api/export/snapshot-pdf") {
      const payload = JSON.parse((await readBody(req)).toString("utf8"));
      const buffer = await renderSnapshotPdf(payload.snapshot, payload.reportConfig);
      const config = normalizeReportConfig(payload.reportConfig || payload.snapshot && payload.snapshot.config || {});
      sendPdf(res, `professional-evidence-snapshot-${config.sanitized_profile_name}-${config.generated_at}.pdf`, buffer);
      return;
    }
    if (req.method === "POST" && requestPath === "/api/export/appendix-pdf") {
      const payload = JSON.parse((await readBody(req)).toString("utf8"));
      const buffer = await renderAppendixPdf(payload.snapshot, payload.reportConfig);
      const config = normalizeReportConfig(payload.reportConfig || payload.snapshot && payload.snapshot.config || {});
      sendPdf(res, `detailed-evidence-appendix-${config.sanitized_profile_name}-${config.generated_at}.pdf`, buffer);
      return;
    }
    if (req.method === "POST" && requestPath === "/api/delete") {
      const payload = JSON.parse((await readBody(req)).toString("utf8"));
      sessions.delete(payload.sessionId);
      sendJson(res, 200, { deleted: true });
      return;
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendError(res, 400, error, requestMeta(req));
  }
}

function handleRequest(req, res) {
  try {
    const requestPath = getRequestPath(req);
    if (requestPath.startsWith("/api/")) {
      Promise.resolve(handleApi(req, res)).catch(error => {
        sendError(res, 500, error, requestMeta(req));
      });
      return;
    }
    serveStatic(req, res);
  } catch (error) {
    sendError(res, 500, error, requestMeta(req));
  }
}

const server = http.createServer(handleRequest);

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`AI Work Passport running at http://localhost:${PORT}`);
  });
}

module.exports = handleRequest;
module.exports.APP_VERSION = APP_VERSION;
module.exports.handleRequest = handleRequest;
module.exports.normalizeChatGptExport = normalizeChatGptExport;
module.exports.buildNormalized = buildNormalized;
module.exports.generateInsights = generateInsights;
module.exports.buildReports = buildReports;
module.exports.renderSnapshotPdf = renderSnapshotPdf;
module.exports.renderAppendixPdf = renderAppendixPdf;
module.exports.scanSummary = scanSummary;
module.exports.redactText = redactText;
module.exports.classifyConversation = classifyConversation;
