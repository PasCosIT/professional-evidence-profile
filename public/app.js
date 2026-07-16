let state = {
  sessionId: null,
  conversations: [],
  summary: null,
  reports: null,
  reportMode: "private",
  reportConfig: null,
  reviewExpanded: true
};

const PROMPT_PREFS_KEY = "aiWorkPassportPromptPrefsV1";
const SESSION_STATE_KEY = "professionalEvidenceProfileState";
const SESSION_STATE_VERSION = "2026-07-16-selection-v2";
const PromptBuilder = window.PromptBuilder || null;
const ConversationSelection = window.ConversationSelection || null;
let promptGeneratedPayload = null;
let promptGenerationAttempted = false;

const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));

function setView(name) {
  $$(".view").forEach(view => view.classList.toggle("active", view.id === name));
  $$(".step").forEach(step => step.classList.toggle("active", step.dataset.step === name));
  if (name === "report") {
    if (state.reports) renderReports();
    else renderEmptySnapshot();
  }
}

function metric(label, value) {
  return `<div class="metric"><strong>${value ?? "-"}</strong><span>${label}</span></div>`;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function subtractCalendarMonths(dateIso, months) {
  const [year, month, day] = String(dateIso).split("-").map(Number);
  if (!year || !month || !day || !Number.isInteger(months)) return null;
  const targetMonthIndex = month - 1 - months;
  const lastTargetDay = new Date(Date.UTC(year, targetMonthIndex + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastTargetDay);
  return new Date(Date.UTC(year, targetMonthIndex, clampedDay)).toISOString().slice(0, 10);
}

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

function buildCurrentReportConfig() {
  const profileName = sanitizeProfileName($("#profileNameInput") ? $("#profileNameInput").value : "");
  const selectedMonths = Number($("#analysisPeriodSelect") ? $("#analysisPeriodSelect").value : 6);
  const sourcePlatform = $("#aiSourceSelect") ? $("#aiSourceSelect").value : "";
  const exportMode = $("#exportModeSelect") ? $("#exportModeSelect").value : "quick";
  const reportLanguage = "en";
  if (state.reportConfig &&
      sanitizeProfileName(state.reportConfig.profile_name) === profileName &&
      Number(state.reportConfig.selected_months) === selectedMonths &&
      String(state.reportConfig.source_platform || "") === String(sourcePlatform || "") &&
      String(state.reportConfig.export_mode || "quick") === String(exportMode || "quick") &&
      state.reportConfig.period_from &&
      state.reportConfig.period_to &&
      state.reportConfig.generated_at) {
    return {
      ...state.reportConfig,
      valid: Boolean(profileName) && selectedMonths >= 1 && selectedMonths <= 12,
      report_language: reportLanguage,
      sanitized_profile_name: sanitizedFilenameName(profileName)
    };
  }
  const generatedAt = todayIso();
  const periodTo = generatedAt;
  const periodFrom = subtractCalendarMonths(periodTo, selectedMonths);
  const valid = Boolean(profileName) && profileName.length <= 120 && selectedMonths >= 1 && selectedMonths <= 12 && Boolean(periodFrom);
  return {
    profile_name: profileName,
    selected_months: selectedMonths,
    source_platform: sourcePlatform,
    export_mode: exportMode,
    period_from: periodFrom,
    period_to: periodTo,
    generated_at: generatedAt,
    report_language: reportLanguage,
    valid,
    sanitized_profile_name: sanitizedFilenameName(profileName)
  };
}

function applyReportConfig(config) {
  if (!config) return;
  state.reportConfig = {
    profile_name: sanitizeProfileName(config.profile_name),
    selected_months: Math.max(1, Math.min(12, Number(config.selected_months || 6))),
    source_platform: String(config.source_platform || ""),
    export_mode: String(config.export_mode || "quick") === "complete" ? "complete" : "quick",
    period_from: config.period_from,
    period_to: config.period_to,
    generated_at: config.generated_at || todayIso(),
    report_language: "en",
    sanitized_profile_name: sanitizedFilenameName(config.profile_name)
  };
}

function getReportLanguage() {
  return "en";
}

function getUiLocale() {
  return "en";
}

function readPromptPreferences() {
  try {
    const raw = localStorage.getItem(PROMPT_PREFS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

function savePromptPreferences(config) {
  try {
    const payload = {
      source_platform: String(config.source_platform || ""),
      export_mode: String(config.export_mode || "quick") === "complete" ? "complete" : "quick",
      selected_months: Math.max(1, Math.min(12, Number(config.selected_months || 6)))
    };
    localStorage.setItem(PROMPT_PREFS_KEY, JSON.stringify(payload));
  } catch (error) {
    // Ignore persistence errors in private browsing contexts.
  }
}

function updateGeneratePromptButtonLabel() {
  const button = $("#generatePromptBtn");
  if (!button || !PromptBuilder) return;
  button.textContent = PromptBuilder.getGeneratePromptButtonLabel(
    $("#aiSourceSelect") ? $("#aiSourceSelect").value : "",
    getUiLocale()
  );
}

function setPromptActionsEnabled(enabled) {
  if ($("#copyPromptBtn")) $("#copyPromptBtn").disabled = !enabled;
  if ($("#downloadPromptBtn")) $("#downloadPromptBtn").disabled = !enabled;
  if ($("#toggleInstructionsBtn")) $("#toggleInstructionsBtn").disabled = !enabled;
  if ($("#importJsonBtn")) $("#importJsonBtn").disabled = !enabled;
  if ($("#promptActions")) $("#promptActions").hidden = !enabled;
}

function renderPromptValidationErrors(errors) {
  const box = $("#exportConfigError");
  if (!box) return;
  if (!errors || !errors.length) {
    box.hidden = true;
    box.textContent = "";
    return;
  }
  box.hidden = false;
  box.textContent = errors.join(" ");
}

function renderPromptInstructions(payload) {
  const section = $("#promptInstructions");
  const title = $("#promptInstructionsTitle");
  const list = $("#promptInstructionsList");
  const promptTitle = $("#promptTitle");
  if (!section || !title || !list || !promptTitle || !payload) return;
  title.textContent = payload.instructions_title;
  list.innerHTML = (payload.instructions || []).map(item => `<li>${escapeHtml(item)}</li>`).join("");
  section.hidden = true;
  promptTitle.textContent = `Prompt for ${payload.platform_name}`;
}

function clearGeneratedPrompt() {
  promptGeneratedPayload = null;
  const prompt = $("#evidencePrompt");
  if (prompt) prompt.value = "Configure fields and generate the prompt.";
  if ($("#copyPromptStatus")) $("#copyPromptStatus").textContent = "";
  if ($("#promptInstructions")) $("#promptInstructions").hidden = true;
  if ($("#promptTitle")) $("#promptTitle").textContent = "Prompt";
  setPromptActionsEnabled(false);
}

function updateExportPrompt() {
  const config = buildCurrentReportConfig();
  applyReportConfig(config.valid ? config : { ...config, profile_name: config.profile_name });
  const summary = $("#exportConfigSummary");
  if (!summary) return;

  updateGeneratePromptButtonLabel();
  savePromptPreferences(config);

  if (!config.profile_name || !config.valid) {
    summary.innerHTML = `
      <strong>Export configuration</strong>
      <span>Fill required fields and generate the prompt.</span>
    `;
  } else {
    const source = PromptBuilder ? PromptBuilder.platformDisplayName(config.source_platform) : (config.source_platform || "-");
    const modeLabel = config.export_mode === "complete" ? "Complete" : "Quick";
    summary.innerHTML = `
      <strong>Profile: EviLayer Profile - ${escapeHtml(config.profile_name)}</strong>
      <span>Data analyzed: ${escapeHtml(config.period_from)} - ${escapeHtml(config.period_to)}</span>
      <span>Observation window: ${config.selected_months} months · Source: ${escapeHtml(source)} · Mode: ${modeLabel}</span>
    `;
  }

  if (!promptGeneratedPayload) {
    clearGeneratedPrompt();
  }

  if (!promptGenerationAttempted) {
    renderPromptValidationErrors([]);
  }

  persistState();
}

function generateEvidencePrompt() {
  if (!PromptBuilder) {
    renderPromptValidationErrors(["Prompt builder is not available."]);
    return;
  }
  promptGenerationAttempted = true;
  const current = buildCurrentReportConfig();
  const errors = PromptBuilder.validateEvidencePromptConfig(current);
  if (errors.length) {
    renderPromptValidationErrors(errors);
    clearGeneratedPrompt();
    persistState();
    return;
  }

  renderPromptValidationErrors([]);
  const payload = PromptBuilder.buildEvidencePrompt(current, getUiLocale());
  promptGeneratedPayload = payload;
  applyReportConfig({ ...current, ...payload.trusted });
  $("#evidencePrompt").value = payload.prompt;
  renderPromptInstructions(payload);
  setPromptActionsEnabled(true);
  if ($("#copyPromptStatus")) {
    $("#copyPromptStatus").textContent = "Prompt generated.";
  }
  persistState();
}

function downloadPromptAsText() {
  if (!promptGeneratedPayload || !PromptBuilder) return;
  const config = buildCurrentReportConfig();
  const filename = PromptBuilder.getPromptDownloadFilename(config);
  const blob = new Blob([promptGeneratedPayload.prompt], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 200);
}

function togglePromptInstructions() {
  const section = $("#promptInstructions");
  if (!section || !promptGeneratedPayload) return;
  section.hidden = !section.hidden;
}

function importPromptJsonFlow() {
  setView("upload");
}

function buildEvidencePrompt() {
  const config = buildCurrentReportConfig();
  if (!PromptBuilder) return "";
  const payload = PromptBuilder.buildEvidencePrompt(config, getUiLocale());
  return payload.prompt;
}

function renderSummary() {
  const summary = state.summary;
  if (!summary) return;
  $("#summaryGrid").innerHTML = [
    metric("Conversations", summary.total_conversations),
    metric("Messages", summary.total_messages),
    metric("Professional", summary.counts.professional || 0),
    metric("Mixed", summary.counts.mixed || 0),
    metric("Personal", summary.counts.personal || 0),
    metric("Uncertain", summary.counts.uncertain || 0),
    metric("From", summary.period.first || "-"),
    metric("To", summary.period.last || "-")
  ].join("");
}

function classificationPill(classification) {
  const cls = ["personal", "excluded_sensitive"].includes(classification) ? "danger" :
    classification === "mixed" || classification === "uncertain" ? "warn" : "";
  return `<span class="pill ${cls}">${classification}</span>`;
}

function isConversationIncluded(conversation) {
  if (ConversationSelection && typeof ConversationSelection.resolveInitialConversationIncluded === "function") {
    return ConversationSelection.resolveInitialConversationIncluded(conversation);
  }
  return Boolean(conversation && conversation.approved);
}

function setConversationIncluded(conversation, include) {
  if (!conversation) return;
  if (ConversationSelection && typeof ConversationSelection.applyUserConversationSelection === "function") {
    const next = ConversationSelection.applyUserConversationSelection(conversation, include);
    Object.assign(conversation, next);
    return;
  }
  conversation.approved = Boolean(include);
}

function renderReview() {
  const clusters = buildConversationClusters(state.conversations);
  const included = state.conversations.filter(conversation => isConversationIncluded(conversation)).length;
  const professional = state.conversations.filter(conversation => ["professional", "mixed"].includes(conversation.classification)).length;
  const excluded = state.conversations.length - included;
  const categories = Array.from(new Set(state.conversations
    .filter(conversation => isConversationIncluded(conversation))
    .map(conversation => conversation.professional_category)
    .filter(Boolean))).slice(0, 6);
  $("#conversationList").innerHTML = `
    <section class="review-summary-panel">
      <div>
        <p class="eyebrow">Dataset ready</p>
        <h4>${included} conversations selected</h4>
        <p>${professional} professional or mixed conversations detected. ${excluded} conversations excluded from the snapshot.</p>
      </div>
      <div class="review-summary-metrics">
        ${metric("Selected", included)}
        ${metric("Professional", professional)}
        ${metric("Excluded", excluded)}
      </div>
      ${categories.length ? `<p class="review-categories">${categories.map(category => `<span>${escapeHtml(category)}</span>`).join("")}</p>` : ""}
    </section>
    <details class="advanced-review" ${state.reviewExpanded ? "open" : ""}>
      <summary>Review selected conversations</summary>
      <div class="conversation-detail compact-review-list">
        ${state.conversations.map(conversation => renderConversationCard(conversation)).join("")}
      </div>
    </details>
  `;
  const details = $(".advanced-review");
  if (details) {
    details.addEventListener("toggle", () => {
      state.reviewExpanded = details.open;
      persistState();
    });
  }
  bindConversationControls();
  bindClusterControls();
  $("#analyzeBtn").disabled = false;
}

function buildConversationClusters(conversations) {
  const map = new Map();
  for (const conversation of conversations) {
    const key = `${conversation.classification}:${conversation.professional_category || "uncategorized"}`;
    const current = map.get(key) || {
      id: key.replace(/[^a-z0-9_-]/gi, "_"),
      classification: conversation.classification,
      category: conversation.professional_category || "uncategorized",
      conversations: [],
      sensitive_count: 0,
      approved_count: 0,
      confidence_sum: 0,
      dates: []
    };
    current.conversations.push(conversation);
    current.sensitive_count += (conversation.sensitive_flags || []).length ? 1 : 0;
    current.approved_count += isConversationIncluded(conversation) ? 1 : 0;
    current.confidence_sum += conversation.confidence || 0;
    [conversation.created_at, conversation.updated_at].filter(Boolean).forEach(date => current.dates.push(date));
    map.set(key, current);
  }
  return Array.from(map.values()).map(cluster => ({
    ...cluster,
    count: cluster.conversations.length,
    avg_confidence: cluster.count ? cluster.confidence_sum / cluster.count : 0,
    first: cluster.dates.length ? cluster.dates.slice().sort()[0].slice(0, 10) : "-",
    last: cluster.dates.length ? cluster.dates.slice().sort().slice(-1)[0].slice(0, 10) : "-",
    sample_titles: cluster.conversations.slice(0, 3).map(conversation => conversation.title)
  })).sort((a, b) => {
    const order = { professional: 0, mixed: 1, uncertain: 2, personal: 3, excluded_sensitive: 4 };
    return (order[a.classification] ?? 9) - (order[b.classification] ?? 9) || b.count - a.count;
  });
}

function renderCluster(cluster) {
  const includeDisabled = ["personal", "excluded_sensitive"].includes(cluster.classification) ? "disabled" : "";
  return `
    <article class="cluster" data-cluster="${escapeHtml(cluster.id)}" data-classification="${escapeHtml(cluster.classification)}" data-category="${escapeHtml(cluster.category)}">
      <div>
        <div class="meta">
          ${classificationPill(cluster.classification)}
          <span class="pill">${escapeHtml(cluster.category)}</span>
          ${cluster.sensitive_count ? `<span class="pill danger">${cluster.sensitive_count} sensitive</span>` : ""}
        </div>
        <h4>${cluster.count} conversations</h4>
        <p>${cluster.first} - ${cluster.last} · avg confidence ${cluster.avg_confidence.toFixed(2)} · ${cluster.approved_count} included</p>
        <p>${cluster.sample_titles.map(escapeHtml).join(" · ")}</p>
      </div>
      <div class="cluster-actions">
        <button type="button" class="cluster-include" ${includeDisabled}>Include cluster</button>
        <button type="button" class="cluster-exclude">Exclude cluster</button>
      </div>
    </article>
  `;
}

function renderConversationCard(conversation) {
    const flags = conversation.sensitive_flags || [];
  const includeChecked = isConversationIncluded(conversation) ? "checked" : "";
    const firstUser = conversation.messages.find(message => message.author === "user");
    const excerpt = firstUser ? firstUser.text.slice(0, 120) : "No user message found.";
    const date = (conversation.created_at || conversation.updated_at || "").slice(0, 10) || "-";
    return `
      <article class="conversation" data-id="${conversation.id}" data-classification="${conversation.classification}" data-category="${conversation.professional_category}">
        <div>
          <h4>${escapeHtml(conversation.title)}</h4>
          <div class="meta">
            ${classificationPill(conversation.classification)}
            <span class="pill">${conversation.professional_category}</span>
            <span class="pill">conf. ${conversation.confidence}</span>
            ${flags.map(flag => `<span class="pill danger">${flag}</span>`).join("")}
          </div>
          <p class="conversation-brief">${escapeHtml(date)} · ${escapeHtml(excerpt)}${excerpt.length >= 120 ? "..." : ""}</p>
        </div>
        <div class="controls">
          <label class="include-toggle">Include <input type="checkbox" class="include" ${includeChecked}></label>
        </div>
      </article>
    `;
}

function bindClusterControls() {
  $$(".cluster-include").forEach(button => {
    button.addEventListener("click", () => {
      const cluster = button.closest(".cluster");
      setClusterIncluded(cluster.dataset.classification, cluster.dataset.category, true);
    });
  });
  $$(".cluster-exclude").forEach(button => {
    button.addEventListener("click", () => {
      const cluster = button.closest(".cluster");
      setClusterIncluded(cluster.dataset.classification, cluster.dataset.category, false);
    });
  });
}

function setClusterIncluded(classification, category, include) {
  $$(".conversation").forEach(card => {
    if (card.dataset.classification === classification && card.dataset.category === category) {
      card.querySelector(".include").checked = include;
      const conversation = state.conversations.find(item => String(item.id) === String(card.dataset.id));
      setConversationIncluded(conversation, include);
    }
  });
  persistState();
  renderReview();
  if (state.reports) renderReports();
}

function bindConversationControls() {
  $$(".conversation .include").forEach(input => {
    input.addEventListener("change", () => {
      const card = input.closest(".conversation");
      if (!card) return;
      const conversation = state.conversations.find(item => String(item.id) === String(card.dataset.id));
      setConversationIncluded(conversation, input.checked);
      persistState();
      renderReview();
      if (state.reports) renderReports();
    });
  });
}

function renderReports() {
  if (!state.reports) return;
  renderSnapshotPreview();
  $("#downloadSnapshotPdf").disabled = false;
  if ($("#downloadAppendixPdf")) $("#downloadAppendixPdf").disabled = false;
  if ($("#downloadCombinedPdf")) $("#downloadCombinedPdf").disabled = false;
  $("#regenerateReport").disabled = false;
}

function renderEmptySnapshot() {
  const hasConversations = state.conversations && state.conversations.length;
  const title = hasConversations ? "Report not generated yet" : "No dataset uploaded";
  const message = hasConversations
    ? "Go to Review and click Generate snapshot. The report preview will appear here after analysis."
    : "Upload an export or a Professional Evidence Pack first, then confirm included conversations in Review.";
  $("#snapshotPreviewHost").innerHTML = `
    <article class="snapshot-empty-state">
      <h4>${escapeHtml(title)}</h4>
      <p>${escapeHtml(message)}</p>
      <button type="button" id="emptySnapshotAction">${hasConversations ? "Go to Review" : "Go to Upload"}</button>
    </article>
  `;
  $("#downloadSnapshotPdf").disabled = true;
  if ($("#downloadAppendixPdf")) $("#downloadAppendixPdf").disabled = true;
  if ($("#downloadCombinedPdf")) $("#downloadCombinedPdf").disabled = true;
  $("#regenerateReport").disabled = true;
  const action = $("#emptySnapshotAction");
  if (action) action.addEventListener("click", () => setView(hasConversations ? "review" : "upload"));
}

function renderSnapshotPreview() {
  const snapshot = buildSnapshotData();
  const vm = snapshot.snapshotViewModel || snapshot.reportViewModel || null;
  if (!vm || !window.ReportViewModel || typeof window.ReportViewModel.renderSnapshotHtml !== "function") {
    $("#snapshotPreviewHost").innerHTML = `<div class="snapshot-empty">Snapshot model unavailable.</div>`;
    return;
  }
  $("#snapshotPreviewHost").innerHTML = `
    <div class="snapshot-zoom-row" aria-label="Preview zoom">
      <span>Preview</span>
      <input id="snapshotZoom" type="range" min="70" max="125" value="100" aria-label="Zoom preview">
      <strong id="snapshotZoomValue">100%</strong>
    </div>
    <div class="snapshot-page-shell" style="--snapshot-zoom: 1">
      ${window.ReportViewModel.renderSnapshotHtml(vm)}
    </div>
  `;
  bindSnapshotZoom();
}

function renderSnapshotFooter(snapshot) {
  const direct = Number((snapshot.evidenceMix.segments.find(item => item.tone === "direct") || {}).value || 0);
  const mixed = Number((snapshot.evidenceMix.segments.find(item => item.tone === "mixed") || {}).value || 0);
  const external = Number((snapshot.evidenceMix.segments.find(item => item.tone === "external") || {}).value || 0) +
    Number((snapshot.evidenceMix.segments.find(item => item.tone === "ai") || {}).value || 0) +
    Number((snapshot.evidenceMix.segments.find(item => item.tone === "unknown") || {}).value || 0);
  const method = snapshot.language === "it"
    ? "Coverage measures evidence availability, recurrence and attribution. It is not a skill score."
    : "Coverage measures evidence availability, recurrence and attribution. It is not a skill score.";
  const verification = snapshot.language === "it"
    ? `${snapshot.verificationLabel || "AI-assisted report · User-provided content · Not independently verified"} · Estratto ${snapshot.extractedDate}`
    : `${snapshot.verificationLabel || "AI-assisted report · User-provided content · Not independently verified"} · Extracted ${snapshot.extractedDate}`;
  return `
    <footer class="snapshot-footer">
      <article class="snapshot-card footer-card">
        <p class="snapshot-eyebrow">${escapeHtml(snapshot.texts.provenancePanelTitle)}</p>
        <p>Direct ${direct}% · Partial ${mixed}% · External ${external}%</p>
      </article>
      <article class="snapshot-card footer-card">
        <p class="snapshot-eyebrow">${escapeHtml(snapshot.texts.methodologyTitle || "Method")}</p>
        <p>${escapeHtml(method)}</p>
      </article>
      <article class="snapshot-card footer-card">
        <p class="snapshot-eyebrow">Verification</p>
        <p>${escapeHtml(verification)}</p>
      </article>
    </footer>
  `;
}

function renderSnapshotAxis(axis) {
  const coverage = Math.max(0, Math.min(100, axis.coverage || 0));
  return `
    <div class="capability-row">
      <div class="capability-label">
        <strong>${escapeHtml(axis.label)}</strong>
        <span>${escapeHtml(displayStatus(axis.level))}</span>
      </div>
      <div class="capability-track" aria-label="${escapeHtml(axis.label)} coverage ${coverage}/100">
        <i style="width: ${coverage}%"></i>
      </div>
      <b>${coverage}</b>
    </div>
  `;
}

function renderSnapshotKpi(kpi) {
  const meter = Math.max(0, Math.min(100, Number(kpi.meter || 0)));
  const tooltip = kpi.tooltip ? ` title="${escapeHtml(kpi.tooltip)}"` : "";
  return `
    <article class="snapshot-kpi with-meter">
      <div class="kpi-meter" style="--meter:${meter}%">
        <strong>${escapeHtml(kpi.value)}</strong>
      </div>
      <span${tooltip}>${escapeHtml(kpi.label)}</span>
      <p>${escapeHtml(kpi.note)}</p>
    </article>
  `;
}

const MIN_RADAR_EVIDENCE_COVERAGE = 40;

function reportText(language) {
  if (language === "it") {
    return {
      snapshotTitle: "EviLayer Snapshot",
      extractedLabel: "Estratto",
      dataAnalyzedLabel: "Dati analizzati",
      observationPeriodLabel: "Periodo di osservazione",
      executiveSummary: "Sintesi esecutiva",
      signatureLabel: "Pattern professionale osservato",
      domainsLabel: "Domini professionali osservati",
      contributionLabel: "Contributo professionale tipico",
      domainPanelTitle: "Evidenze per dominio professionale",
      provenancePanelTitle: "Sintesi attribuzione",
      attributableLabel: "attribuzione diretta",
      capabilityTitle: "Capacita osservate",
      capabilitySubtitle: "Il radar mostra coverage, ricorrenza e attribuzione dell'evidenza. Non e' un punteggio di skill.",
      areasLabel: "aree",
      analyzedConversations: "Conversazioni professionali analizzate",
      evidenceItems: "Elementi di evidenza",
      supportedAreas: "Capacita valutate",
      attributableEvidence: "Quota evidenza diretta",
      retainedNote: "Conversazioni analizzate",
      evidenceNote: "Supporting, counter e uncertain",
      supportedNote: "Coverage sufficiente",
      attributableNote: "Share of evidence directly attributable to the user",
      notAssessed: "Non valutata — evidenza insufficiente",
      snapshotFooterA: "Disponibilita di evidenze, non punteggio di skill.",
      snapshotFooterB: "Profilo basato su conversazioni approvate, non verificato in modo indipendente.",
      appendixTitle: "Evidence Appendix",
      appendixSubtitle: "Evidenze professionali rappresentative estratte dal periodo analizzato.",
      appendixIntro: "Conversazioni ed estratti selezionati per supportare lo snapshot.",
      selectedConversations: "conversazioni selezionate",
      outOfAnalyzed: "su",
      analyzedLabel: "analizzate",
      selectedExcerpts: "estratti selezionati",
      outOfEvidence: "su",
      evidenceLabel: "evidence items",
      confidence: { high: "Alta", medium: "Media", low: "Bassa" },
      provenance: { direct: "Diretta", mixed: "Mista", external: "Esterna", ai: "AI", unknown: "Sconosciuta" },
      observedDomainsQuestion: "In quali ambiti opera?",
      signatureQuestion: "Chi emerge essere professionalmente?",
      radarQuestion: "Capacita osservate",
      observedArchetypeLabel: "Archetipo osservato",
      operatingLevelLabel: "Livello operativo",
      workModeLabel: "Modalita di lavoro",
      roleSpecificTitle: "Capacita specifiche del ruolo",
      differentiatorsTitle: "Differenziatori",
      watchOutsTitle: "Watch-outs",
      methodologyTitle: "Attribuzione e metodologia",
      directAttributionTooltip: "Share of evidence directly attributable to the user."
    };
  }
  return {
    snapshotTitle: "EviLayer Snapshot",
    extractedLabel: "Extracted",
    dataAnalyzedLabel: "Data analyzed",
    observationPeriodLabel: "Observation period",
    executiveSummary: "Executive summary",
    signatureLabel: "Observed professional pattern",
    domainsLabel: "Professional domains observed",
    contributionLabel: "Typical professional contribution",
    domainPanelTitle: "Evidence by professional domain",
    provenancePanelTitle: "Attribution summary",
    attributableLabel: "direct attribution",
    capabilityTitle: "Observed capabilities",
    capabilitySubtitle: "The radar shows evidence coverage, recurrence and attribution. It is not a skill score.",
    areasLabel: "areas",
    analyzedConversations: "Professional conversations analyzed",
    evidenceItems: "Evidence items",
    supportedAreas: "Capabilities assessed",
    attributableEvidence: "Direct evidence share",
    retainedNote: "Conversations analyzed",
    evidenceNote: "Supporting, counter and uncertain",
    supportedNote: "Sufficient evidence coverage",
    attributableNote: "Share of evidence directly attributable to the user",
    notAssessed: "Not assessed — insufficient evidence",
    snapshotFooterA: "Coverage means evidence availability, not a skill score.",
    snapshotFooterB: "Profile built from approved conversations and not independently verified.",
    appendixTitle: "Evidence Appendix",
    appendixSubtitle: "Representative professional evidence extracted from the analyzed period.",
    appendixIntro: "Selected conversations and excerpts supporting the snapshot.",
    selectedConversations: "selected conversations",
    outOfAnalyzed: "out of",
    analyzedLabel: "analyzed",
    selectedExcerpts: "selected excerpts",
    outOfEvidence: "out of",
    evidenceLabel: "evidence items",
    confidence: { high: "High", medium: "Medium", low: "Low" },
    provenance: { direct: "Direct", mixed: "Mixed", external: "External", ai: "AI", unknown: "Unknown" },
    observedDomainsQuestion: "In which domains does this person operate?",
    signatureQuestion: "Who emerges professionally?",
    radarQuestion: "Observed capabilities",
    observedArchetypeLabel: "Observed archetype",
    operatingLevelLabel: "Operating level",
    workModeLabel: "Work mode",
    roleSpecificTitle: "Role-specific capabilities",
    differentiatorsTitle: "Differentiators",
    watchOutsTitle: "Watch-outs",
    methodologyTitle: "Attribution and methodology",
    directAttributionTooltip: "Share of evidence directly attributable to the user."
  };
}

function taxonomyLabel(value, language = getReportLanguage()) {
  const key = String(value || "").toLowerCase();
  const labels = {
    engineering: language === "it" ? "Engineering" : "Engineering",
    product: language === "it" ? "Product" : "Product",
    program_project_management: language === "it" ? "Program/Project management" : "Program/Project management",
    operations: language === "it" ? "Operations" : "Operations",
    data_analytics: language === "it" ? "Data analytics" : "Data analytics",
    sales_business_development: language === "it" ? "Sales e business development" : "Sales and business development",
    marketing: "Marketing",
    customer_success: language === "it" ? "Customer success" : "Customer success",
    finance: "Finance",
    hr_people: language === "it" ? "HR / People" : "HR / People",
    legal_compliance: language === "it" ? "Legal e compliance" : "Legal and compliance",
    consulting: language === "it" ? "Consulenza" : "Consulting",
    executive_management: language === "it" ? "Executive management" : "Executive management",
    individual_contributor: language === "it" ? "Individual contributor" : "Individual contributor",
    technical_specialist: language === "it" ? "Specialista tecnico" : "Technical specialist",
    backend_developer: language === "it" ? "Backend developer" : "Backend developer",
    frontend_developer: language === "it" ? "Frontend developer" : "Frontend developer",
    data_analyst: language === "it" ? "Data analyst" : "Data analyst",
    data_engineer: language === "it" ? "Data engineer" : "Data engineer",
    product_owner: language === "it" ? "Product owner" : "Product owner",
    product_manager: language === "it" ? "Product manager" : "Product manager",
    project_manager: language === "it" ? "Project manager" : "Project manager",
    program_manager: language === "it" ? "Program manager" : "Program manager",
    operations_manager: language === "it" ? "Operations manager" : "Operations manager",
    consultant: language === "it" ? "Consulente" : "Consultant",
    senior_consultant: language === "it" ? "Senior consultant" : "Senior consultant",
    manager: "Manager",
    senior_manager: language === "it" ? "Senior manager" : "Senior manager",
    functional_lead: language === "it" ? "Functional lead" : "Functional lead",
    head_of_function: language === "it" ? "Head of function" : "Head of function",
    director: "Director",
    partner: "Partner",
    executive: "Executive",
    hr_lead: language === "it" ? "HR lead" : "HR lead",
    recruiter: "Recruiter",
    customer_success_manager: language === "it" ? "Customer success manager" : "Customer success manager",
    sales_manager: language === "it" ? "Sales manager" : "Sales manager",
    junior: language === "it" ? "Junior" : "Junior",
    mid_level: language === "it" ? "Mid level" : "Mid level",
    senior: language === "it" ? "Senior" : "Senior",
    lead: language === "it" ? "Lead" : "Lead",
    head_of: language === "it" ? "Head of" : "Head of",
    executive_partner: language === "it" ? "Executive / Partner" : "Executive / Partner",
    individual_delivery: language === "it" ? "Contributo individuale" : "Individual delivery",
    specialist_execution: language === "it" ? "Execution specialistica" : "Specialist execution",
    cross_functional_coordination: language === "it" ? "Coordinamento cross-funzionale" : "Cross-functional coordination",
    people_management: language === "it" ? "People management" : "People management",
    strategic_leadership: language === "it" ? "Leadership strategica" : "Strategic leadership",
    advisory_consulting: language === "it" ? "Advisory/consulting" : "Advisory/consulting",
    operational_ownership: language === "it" ? "Ownership operativa" : "Operational ownership",
    commercial_ownership: language === "it" ? "Ownership commerciale" : "Commercial ownership",
    technical_ownership: language === "it" ? "Ownership tecnica" : "Technical ownership",
    uncertain: language === "it" ? "Incerto" : "Uncertain",
    other: language === "it" ? "Altro" : "Other"
  };
  return labels[key] || String(value || "").replace(/_/g, " ");
}

function limitChars(text, maxChars) {
  const value = String(text || "").trim();
  if (!value || value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

function compactCapabilityLabel(label, language = getReportLanguage()) {
  const canonical = {
    "Decision making": language === "it" ? "Decision making" : "Decision making",
    "Problem solving": language === "it" ? "Problem solving" : "Problem solving",
    Communication: language === "it" ? "Communication" : "Communication",
    Execution: language === "it" ? "Execution" : "Execution",
    Leadership: language === "it" ? "Leadership" : "Leadership",
    Collaboration: language === "it" ? "Collaboration" : "Collaboration",
    Planning: language === "it" ? "Planning" : "Planning",
    Learning: language === "it" ? "Learning" : "Learning",
    "Domain knowledge": language === "it" ? "Domain knowledge" : "Domain knowledge",
    "Data reasoning": language === "it" ? "Data reasoning" : "Data reasoning",
    "Risk awareness": language === "it" ? "Risk awareness" : "Risk awareness",
    "Quality improvement": language === "it" ? "Quality" : "Quality improvement"
  };
  const direct = canonical[String(label || "")];
  return limitChars(direct || String(label || ""), 26);
}

function resolveSnapshotCapabilityLabel(item) {
  const raw = item && (item.resolved_label || item.full_label || item.label || item.short_label) ? String(item.resolved_label || item.full_label || item.label || item.short_label) : "";
  return raw.replace(/[.!?]+$/g, "").replace(/\s+/g, " ").trim();
}

function professionalCategoryLabel(category, language = getReportLanguage()) {
  const labels = {
    strategy: language === "it" ? "strategia e prioritizzazione" : "strategy and prioritization",
    project_management: language === "it" ? "program management" : "program management",
    product_management: language === "it" ? "prodotto e delivery" : "product and delivery",
    technology: language === "it" ? "integrazioni tecnologiche" : "technology integrations",
    programming: language === "it" ? "execution ingegneristica" : "engineering execution",
    data_analytics: language === "it" ? "dati e reporting" : "data and reporting",
    professional_communication: language === "it" ? "comunicazione con stakeholder" : "stakeholder communication",
    leadership: language === "it" ? "coordinamento cross-funzionale" : "cross-functional coordination",
    recruiting: language === "it" ? "valutazione talenti" : "talent evaluation",
    negotiation: language === "it" ? "gestione partner" : "partner management",
    execution: language === "it" ? "execution operativa" : "operational execution",
    learning: language === "it" ? "miglioramento continuo" : "continuous improvement",
    other: language === "it" ? "operazioni professionali" : "professional operations",
    uncategorized: language === "it" ? "operazioni professionali" : "professional operations"
  };
  return labels[category] || String(category || (language === "it" ? "operazioni professionali" : "professional operations")).replace(/_/g, " ");
}

function canonicalDimensionLabel(idOrLabel, language = getReportLanguage()) {
  const key = String(idOrLabel || "").toLowerCase().replace(/\s+/g, "_");
  const labels = {
    decision_making: language === "it" ? "Capacita decisionale" : "Decision making",
    problem_solving: language === "it" ? "Problem solving" : "Problem solving",
    communication: language === "it" ? "Comunicazione" : "Communication",
    growth_revenue: language === "it" ? "Growth & Revenue" : "Growth & Revenue",
    strategy_transformation: language === "it" ? "Strategy & Transformation" : "Strategy & Transformation",
    product_delivery: language === "it" ? "Product & Delivery" : "Product & Delivery",
    technology_architecture: language === "it" ? "Technology & Architecture" : "Technology & Architecture",
    operations_execution: language === "it" ? "Operations & Execution" : "Operations & Execution",
    risk_compliance_governance: language === "it" ? "Risk, Compliance & Governance" : "Risk, Compliance & Governance",
    people_leadership: language === "it" ? "People & Leadership" : "People & Leadership",
    sales_partnerships: language === "it" ? "Sales & Partnerships" : "Sales & Partnerships",
    communication_stakeholder: language === "it" ? "Communication & Stakeholder Management" : "Communication & Stakeholder Management",
    execution: language === "it" ? "Execution" : "Execution",
    leadership: language === "it" ? "Leadership" : "Leadership",
    collaboration: language === "it" ? "Collaborazione" : "Collaboration",
    planning: language === "it" ? "Pianificazione" : "Planning",
    learning: language === "it" ? "Apprendimento" : "Learning",
    domain_knowledge: language === "it" ? "Conoscenza del dominio" : "Domain knowledge",
    data_reasoning: language === "it" ? "Ragionamento sui dati" : "Data reasoning",
    risk_awareness: language === "it" ? "Consapevolezza del rischio" : "Risk awareness",
    quality_improvement: language === "it" ? "Miglioramento continuo" : "Quality improvement"
  };
  return labels[key] || String(idOrLabel || "");
}

function joinHumanLocalized(items, language = getReportLanguage()) {
  const clean = items.filter(Boolean);
  if (clean.length <= 1) return clean[0] || "";
  if (clean.length === 2) return `${clean[0]} ${language === "it" ? "e" : "and"} ${clean[1]}`;
  return `${clean.slice(0, -1).join(", ")} ${language === "it" ? "e" : "and"} ${clean[clean.length - 1]}`;
}

function buildProfessionalSignature(identity, axes, categoryBreakdown, professionalPattern, language) {
  if (professionalPattern && professionalPattern.observed_professional_pattern) {
    return limitWords(String(professionalPattern.observed_professional_pattern), 30);
  }
  if (professionalPattern && professionalPattern.signature_text) {
    return limitWords(String(professionalPattern.signature_text), 30);
  }
  const topAxes = axes.slice(0, 3).map(axis => axis.label.toLowerCase());
  const topDomain = categoryBreakdown[0] ? professionalCategoryLabel(categoryBreakdown[0].raw || categoryBreakdown[0].label, language) : (language === "it" ? "domini professionali multipli" : "multiple professional domains");
  if (language === "it") {
    return limitWords(`Le evidenze suggeriscono un profilo con attivita ricorrente tra ${topDomain}, ${joinHumanLocalized(topAxes, language)} e coordinamento cross-funzionale.`, 26);
  }
  return limitWords(`Evidence suggests recurring work across ${topDomain}, ${joinHumanLocalized(topAxes, language)} and cross-functional coordination.`, 24);
}

function buildTypicalContribution(axes, categoryBreakdown, language) {
  const domainA = categoryBreakdown[0] ? professionalCategoryLabel(categoryBreakdown[0].raw || categoryBreakdown[0].label, language) : (language === "it" ? "esigenze di business" : "business needs");
  const domainB = categoryBreakdown[1] ? professionalCategoryLabel(categoryBreakdown[1].raw || categoryBreakdown[1].label, language) : (language === "it" ? "execution operativa" : "operational execution");
  if (language === "it") {
    return limitWords(`Trasforma priorita e bisogni in azioni coordinate, requisiti chiari e delivery condivisa tra ${domainA} e ${domainB}.`, 20);
  }
  return limitWords(`Typically turns priorities into coordinated actions, clearer requirements and shared delivery across ${domainA} and ${domainB}.`, 20);
}

function renderIdentityCard(snapshot) {
  const identity = snapshot.professionalIdentity || {};
  const language = snapshot.language || getReportLanguage();
  return `
    <article class="snapshot-card identity-card">
      <div class="identity-block">
        <p class="snapshot-eyebrow">${escapeHtml(snapshot.texts.signatureLabel)}</p>
        <h3>${escapeHtml(snapshot.professionalSignature)}</h3>
      </div>
      <div class="identity-meta-grid">
        <div class="identity-meta-item">
          <span>${escapeHtml(snapshot.texts.observedArchetypeLabel)}</span>
          <strong>${escapeHtml(taxonomyLabel(identity.observed_archetype || "uncertain", language))}</strong>
        </div>
        <div class="identity-meta-item">
          <span>${escapeHtml(snapshot.texts.operatingLevelLabel)}</span>
          <strong>${escapeHtml(taxonomyLabel(identity.operating_level || "uncertain", language))}</strong>
        </div>
        <div class="identity-meta-item">
          <span>${escapeHtml(snapshot.texts.workModeLabel)}</span>
          <strong>${escapeHtml(taxonomyLabel(identity.work_mode || "uncertain", language))}</strong>
        </div>
      </div>
      <div class="identity-block">
        <p class="snapshot-eyebrow">${escapeHtml(snapshot.texts.domainsLabel)}</p>
        <div class="identity-chip-row">
          ${snapshot.observedDomains.map(domain => `<span>${escapeHtml(domain)}</span>`).join("")}
        </div>
      </div>
      <div class="identity-block">
        <p class="snapshot-eyebrow">${escapeHtml(snapshot.texts.contributionLabel)}</p>
        <p>${escapeHtml(snapshot.typicalContribution)}</p>
      </div>
    </article>
  `;
}

function renderRoleSpecificCapabilities(snapshot) {
  const items = (snapshot.roleSpecificCapabilities || []).slice(0, 5);
  if (!items.length) {
    return `<div class="snapshot-empty">${escapeHtml(snapshot.texts.notAssessed)}</div>`;
  }
  return `
    <div class="bottom-list">
      ${items.map(item => `
        <article>
          <div class="bottom-head">
            <strong>${escapeHtml(item.label)}</strong>
            <span>${escapeHtml(displayStatus(item.evidence_status, snapshot.language))}</span>
          </div>
          <div class="capability-track"><i style="width:${Math.max(0, Math.min(100, Number(item.coverage || 0)))}%"></i></div>
          <p>${escapeHtml(canonicalDimensionLabel(item.canonical_dimension, snapshot.language))} · coverage ${escapeHtml(String(item.coverage || 0))}/100</p>
        </article>
      `).join("")}
    </div>
  `;
}

function renderDifferentiators(snapshot) {
  const items = (snapshot.differentiators || []).slice(0, 3);
  if (!items.length) return `<div class="snapshot-empty">${escapeHtml(snapshot.texts.notAssessed)}</div>`;
  return `
    <div class="bottom-list compact">
      ${items.map(item => `
        <article>
          <div class="bottom-head">
            <strong>${escapeHtml(item.label)}</strong>
          </div>
          <p>${escapeHtml(item.explanation)}</p>
        </article>
      `).join("")}
    </div>
  `;
}

function renderWatchOuts(snapshot) {
  const items = (snapshot.watchOuts || []).slice(0, 3);
  if (!items.length) return `<div class="snapshot-empty">${escapeHtml(snapshot.texts.notAssessed)}</div>`;
  return `
    <div class="bottom-list compact">
      ${items.map(item => `
        <article>
          <div class="bottom-head">
            <strong>${escapeHtml(item.label)}</strong>
            <span class="watch-pill ${escapeHtml(item.severity || "low")}">${escapeHtml(item.severity || "low")}</span>
          </div>
          <p>${escapeHtml(item.explanation)}</p>
        </article>
      `).join("")}
    </div>
  `;
}

function buildSnapshotData() {
  const reports = state.reports || {};
  const kpis = reports.kpis || {};
  const coverage = reports.evidence_coverage_detail || {};
  const temporal = reports.temporal_maturity || {};
  const currentConfig = buildCurrentReportConfig();
  const config = {
    ...(reports.report_config || {}),
    ...(state.reportConfig || {}),
    report_language: currentConfig.report_language || (state.reportConfig && state.reportConfig.report_language) || (reports.report_config && reports.report_config.report_language) || "en"
  };
  const language = config.report_language || getReportLanguage();
  const texts = reportText(language);
  const professionalIdentity = reports.professional_identity || (reports.private_report && reports.private_report.professional_identity) || {};
  const roleSpecificCapabilities = reports.role_specific_capabilities || (reports.private_report && reports.private_report.role_specific_capabilities) || [];
  const professionalPattern = reports.professional_pattern || (reports.private_report && reports.private_report.professional_pattern) || null;
  const technicalSignalsObserved = reports.technical_signals_observed || (reports.private_report && reports.private_report.technical_signals_observed) || null;
  const differentiators = reports.differentiators || (reports.private_report && reports.private_report.differentiators) || [];
  const watchOuts = reports.watch_outs || (reports.private_report && reports.private_report.watch_outs) || [];
  const identityDomains = reports.professional_domains || (reports.private_report && reports.private_report.professional_domains) || [];
  const canonicalAxes = buildRadarAxesFromTemporal(temporal)
    .filter(axis => axis.derivation === "canonical_ontology_dimension" && !isMetadataLikeLabel(axis.label));
  const canonicalFallbackAxes = canonicalAxes
    .filter(axis => axis.assessed && axis.radar_eligible && !["insufficient_evidence", "counter_evidence_only"].includes(axis.level) && Number(axis.coverage || 0) >= MIN_RADAR_EVIDENCE_COVERAGE)
    .map(axis => ({
      ...axis,
      label: compactCapabilityLabel(canonicalDimensionLabel(axis.canonical_dimension || axis.dimension || axis.label, language), language),
      statusLabel: displayStatus(axis.level, language),
      confidenceLabel: texts.confidence[axis.confidence] || axis.confidence
    }))
    .slice(0, 6);
  const patternAxes = Array.isArray(professionalPattern && professionalPattern.radar_capabilities)
    ? professionalPattern.radar_capabilities
      .filter(item => item && item.label)
      .map(item => ({
        label: resolveSnapshotCapabilityLabel(item) || compactCapabilityLabel(item.short_label || item.label, language),
        canonical_dimension: item.canonical_dimension || null,
        coverage: Number(item.coverage || 0),
        strength: Number(item.strength || item.coverage || 0),
        level: item.level || "observed",
        assessed: true,
        confidence: item.confidence || "medium",
        statusLabel: displayStatus(item.level || "observed", language),
        confidenceLabel: texts.confidence[item.confidence] || item.confidence || "medium"
      }))
      .slice(0, 6)
    : [];
  const recurringSummaryLabels = Array.isArray(professionalPattern && professionalPattern.recurring_strengths)
    ? professionalPattern.recurring_strengths
      .filter(item => item && item.is_recurring_strength)
      .map(item => resolveSnapshotCapabilityLabel(item))
      .filter(Boolean)
      .filter((label, index, arr) => arr.findIndex(candidate => String(candidate).toLowerCase() === String(label).toLowerCase()) === index)
      .slice(0, 3)
    : [];
  const axes = patternAxes.length ? patternAxes : canonicalFallbackAxes;
  const allDimensions = (temporal.dimensions || [])
    .filter(dimension => dimension.derivation === "canonical_ontology_dimension" && !isMetadataLikeLabel(dimension.label));
  const notAssessed = allDimensions
    .filter(dimension => isNotAssessedStatus(dimension.status) || dimension.capability_score == null || Number(dimension.evidence_coverage || 0) < MIN_RADAR_EVIDENCE_COVERAGE)
    .slice(0, 3)
    .map(dimension => canonicalDimensionLabel(dimension.canonical_dimension || dimension.id || dimension.label, language));
  const evidenceItems = Number(coverage.total_evidence_items || 0);
  const professionalConversations = Number(coverage.total_professional_conversations || kpis.evidence_coverage || 0);
  const attributablePercentage = computeAttributablePercentage(coverage, evidenceItems);
  const evidenceMix = buildEvidenceMix(coverage, evidenceItems, attributablePercentage);
  const categoryBreakdown = Object.entries((reports.normalized || []).reduce((acc, conversation) => {
    const key = conversation.professional_category || "other";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {}))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([label, count]) => ({ label: professionalCategoryLabel(label, language), raw: label, count }));
  const normalizedConversations = (reports.normalized || []).slice().sort((a, b) => {
    const aDate = new Date(a.created_at || a.updated_at || 0).getTime() || 0;
    const bDate = new Date(b.created_at || b.updated_at || 0).getTime() || 0;
    return bDate - aDate;
  });
  const representative = [];
  const selectedIds = new Set();
  const seenCategories = new Set();
  for (const conversation of normalizedConversations) {
    if (representative.length >= 4) break;
    const category = conversation.professional_category || "uncategorized";
    if (seenCategories.has(category)) continue;
    representative.push(conversation);
    selectedIds.add(conversation.id);
    seenCategories.add(category);
  }
  for (const conversation of normalizedConversations) {
    if (representative.length >= 4) break;
    if (selectedIds.has(conversation.id)) continue;
    representative.push(conversation);
  }
  const analyzedConversations = representative.map(conversation => {
    const firstUser = (conversation.messages || []).find(message => message.author === "user");
    const cleanExcerpt = String((firstUser && firstUser.text) || "No attributable user excerpt available.")
      .replace(/\s+/g, " ")
      .replace(/\bContent origin:\s*\.?/gi, "")
      .trim();
    const origin = (firstUser && firstUser.content_origin && firstUser.content_origin.value) || "unknown";
    return {
      id: conversation.id,
      title: conversation.title,
      category: professionalCategoryLabel(conversation.professional_category || "uncategorized", language),
      date: (conversation.created_at || conversation.updated_at || "").slice(0, 10) || "-",
      excerpt: limitWords(cleanExcerpt || "No attributable user excerpt available.", 22),
      summary: limitWords(cleanExcerpt || "No attributable user excerpt available.", 28),
      provenance: originLabel(origin),
      classification: conversation.classification === "professional" ? "Professional" : conversation.classification === "mixed" ? "Mixed" : "Uncertain"
    };
  });
  const evidenceHighlights = allDimensions
    .filter(dimension => Array.isArray(dimension.supporting_evidence) && dimension.supporting_evidence.length)
    .flatMap(dimension => [
      ...dimension.supporting_evidence.slice(0, 1).map(item => ({ type: "supporting", dimension, item })),
      ...dimension.counter_evidence.slice(0, 1).map(item => ({ type: "counter", dimension, item })),
      ...dimension.uncertain_evidence.slice(0, 1).map(item => ({ type: "uncertain", dimension, item }))
    ])
    .sort((a, b) => (b.dimension.evidence_coverage || 0) - (a.dimension.evidence_coverage || 0))
    .slice(0, 4)
    .map(entry => ({
      group: canonicalDimensionLabel(entry.dimension.canonical_dimension || entry.dimension.id || entry.dimension.label, language),
      skill: canonicalDimensionLabel(entry.dimension.canonical_dimension || entry.dimension.id || entry.dimension.label, language),
      confidence: texts.confidence[entry.dimension.confidence] || entry.dimension.confidence,
      confidenceScore: Number(entry.dimension.capability_score || entry.dimension.evidence_coverage || 0),
      evidenceType: entry.type,
      excerpt: limitWords(String(entry.item.excerpt || "").replace(/\s+/g, " ").replace(/\bContent origin:\s*\.?/gi, "").trim(), 24),
      claim: limitWords(String(entry.item.excerpt || "").replace(/\s+/g, " ").trim(), 28),
      supportingExcerpt: limitWords(String(entry.item.excerpt || "").replace(/\s+/g, " ").trim(), 32),
      counterEvidence: entry.type === "counter" ? limitWords(String(entry.item.excerpt || "").replace(/\s+/g, " ").trim(), 24) : null,
      attribution: originLabel((entry.item.source && entry.item.source.value) || "mixed_content"),
      candidateConcept: canonicalDimensionLabel(entry.dimension.canonical_dimension || entry.dimension.id || entry.dimension.label, language),
      title: entry.item.conversation_title || "Conversation",
      date: entry.item.date || ""
    }));
  const fallbackDomains = categoryBreakdown.slice(0, 4).map(item => item.raw || item.label);
  const observedDomains = ((professionalPattern && professionalPattern.professional_domains_observed) || (identityDomains.length ? identityDomains : fallbackDomains))
    .slice(0, 5)
    .map(domain => professionalCategoryLabel(domain, language));
  const professionalSignature = buildProfessionalSignature(professionalIdentity, axes, categoryBreakdown, professionalPattern, language);
  const typicalContribution = (professionalPattern && professionalPattern.typical_professional_contribution)
    ? limitWords(String(professionalPattern.typical_professional_contribution), 26)
    : buildTypicalContribution(axes, categoryBreakdown, language);
  const normalizedSource = reports.normalized || [];
  const isEvidencePack = normalizedSource.some(conversation => conversation.source && conversation.source.verification);
  const looksSynthetic = !isEvidencePack && normalizedSource.length > 0 && normalizedSource.every(conversation => /^conv_/i.test(String(conversation.id || "")));
  const verificationLabel = looksSynthetic
    ? "AI-assisted report · Synthetic test data · Not independently verified"
    : "AI-assisted report · User-provided content · Not independently verified";

  const rawSnapshot = {
    language,
    texts,
    personName: config.profile_name || "Professional profile",
    extractedDate: formatSnapshotDate(config.generated_at || kpis.generated_at || new Date().toISOString(), language),
    dataRange: formatDataRange(config.period_from || kpis.first_data, config.period_to || kpis.last_data, language),
    observationPeriod: language === "it"
      ? `${config.selected_months || 6} ${Number(config.selected_months || 6) === 1 ? "mese" : "mesi"}`
      : `${config.selected_months || 6} month${Number(config.selected_months || 6) === 1 ? "" : "s"}`,
    axes,
    summary: buildSnapshotSummary(axes, notAssessed, language, recurringSummaryLabels),
    kpis: [
      { value: String(professionalConversations || "-"), label: limitChars(texts.analyzedConversations, 24), note: limitWords(texts.retainedNote, 8), meter: Math.min(100, professionalConversations * 10) },
      { value: String(evidenceItems || "-"), label: limitChars(texts.evidenceItems, 24), note: limitWords(texts.evidenceNote, 8), meter: Math.min(100, evidenceItems * 3) },
      { value: String(axes.length), label: limitChars(texts.supportedAreas, 24), note: limitWords(texts.supportedNote, 8), meter: Math.min(100, axes.length * 16) },
      {
        value: `${attributablePercentage}%`,
        label: limitChars(texts.attributableEvidence, 24),
        note: limitWords(texts.attributableNote, 8),
        meter: attributablePercentage,
        tooltip: texts.directAttributionTooltip || (professionalPattern && professionalPattern.attribution_note
          ? professionalPattern.attribution_note
          : "Attribution reflects direct user-authored evidence versus pasted, AI-generated or external content.")
      }
    ],
    interpretation: buildSnapshotInterpretation(axes, notAssessed, language),
    professionalSignature,
    professionalIdentity,
    professionalPattern,
    observedDomains,
    technicalSignalsObserved,
    roleSpecificCapabilities,
    differentiators,
    watchOuts,
    typicalContribution,
    verificationLabel,
    evidenceMix,
    notAssessed,
    categoryBreakdown,
    analyzedConversations,
    evidenceHighlights,
    selectedConversationCount: analyzedConversations.length,
    analyzedConversationCount: professionalConversations,
    selectedExcerptCount: evidenceHighlights.length,
    totalEvidenceItemCount: evidenceItems
  };

  const reportVmApi = window.ReportViewModel;
  const buildVm = reportVmApi && (reportVmApi.buildSnapshotViewModel || reportVmApi.buildReportViewModel);
  if (!buildVm || typeof reportVmApi.validateReportViewModel !== "function") {
    return rawSnapshot;
  }
  const candidateVm = buildVm(rawSnapshot);
  const vmValidation = reportVmApi.validateReportViewModel(candidateVm);
  if (vmValidation.warnings && vmValidation.warnings.length) {
    console.warn("[snapshot-vm] validation warnings", vmValidation.warnings);
  }
  return {
    ...rawSnapshot,
    snapshotViewModel: vmValidation.model,
    reportViewModel: vmValidation.model
  };
}

function originLabel(value) {
  const map = {
    original_user_input: "Direct user evidence",
    user_instruction: "Direct user instruction",
    mixed_content: "Mixed attribution",
    pasted_email: "Pasted professional email",
    pasted_code: "Code or technical material",
    ai_generated_text: "AI-assisted content",
    pasted_external_document: "External professional document",
    unknown: "Unclear provenance"
  };
  return map[String(value || "").toLowerCase()] || "Unclear provenance";
}

function buildEvidenceMix(source, evidenceItems, attributablePercentage) {
  const direct = Number(source.original_user_input || source.user_provided || source.direct_user_inputs || 0);
  const mixed = Number(source.mixed_content || source.mixed_content_items || 0);
  const external = Number(source.external_content || source.external_documents || 0);
  const ai = Number(source.ai_generated_text || source.ai_generated_items || 0);
  const unknown = Number(source.unknown || source.unknown_items || 0);
  const total = direct + mixed + external + ai + unknown || evidenceItems || 1;
  return {
    attributable: attributablePercentage,
    segments: [
      { label: "Direct", value: Math.round((direct / total) * 100), tone: "direct" },
      { label: "Mixed", value: Math.round((mixed / total) * 100), tone: "mixed" },
      { label: "External", value: Math.round((external / total) * 100), tone: "external" },
      { label: "AI", value: Math.round((ai / total) * 100), tone: "ai" },
      { label: "Unknown", value: Math.round((unknown / total) * 100), tone: "unknown" }
    ].filter(segment => segment.value > 0)
  };
}

function renderEvidenceMix(mix, texts = reportText(getReportLanguage())) {
  const total = mix.segments.reduce((sum, segment) => sum + segment.value, 0) || 100;
  return `
    <div class="evidence-mix-bar" aria-label="Evidence mix">
      ${mix.segments.map(segment => `<i class="${escapeHtml(segment.tone)}" style="width:${(segment.value / total) * 100}%"></i>`).join("")}
    </div>
    <div class="evidence-mix-legend">
      ${mix.segments.map(segment => `<span><b class="${escapeHtml(segment.tone)}"></b>${escapeHtml(texts.provenance[segment.tone] || segment.label)} ${escapeHtml(String(segment.value))}%</span>`).join("")}
    </div>
  `;
}

function technicalGroupLabel(key, language = getReportLanguage()) {
  const labels = {
    programming_languages: language === "it" ? "Languages" : "Languages",
    frameworks_libraries: language === "it" ? "Frameworks / Libraries" : "Frameworks / Libraries",
    cloud_infrastructure: language === "it" ? "Platforms / Tools" : "Platforms / Tools",
    data_bi_tools: language === "it" ? "Data & BI" : "Data & BI",
    security_networking: language === "it" ? "Security / Infrastructure" : "Security / Infrastructure",
    collaboration_delivery_tools: language === "it" ? "Delivery tools" : "Delivery tools"
  };
  return labels[key] || key;
}

function formatTechnicalItem(item) {
  return `${item.name} · ${item.attribution_label}`;
}

function renderTechnicalSignalsCompact(signals, language = getReportLanguage()) {
  if (!signals || typeof signals !== "object") return "";
  const groups = ["programming_languages", "cloud_infrastructure", "data_bi_tools", "security_networking"]
    .map(key => ({ key, items: (signals[key] || []).slice(0, 3) }))
    .filter(group => group.items.length);
  if (!groups.length) return "";
  return `
    <section class="tech-mini-block">
      <p class="snapshot-eyebrow">Technical Signals Observed</p>
      <div class="tech-mini-grid">
        ${groups.map(group => `
          <article class="tech-mini-group">
            <strong>${escapeHtml(technicalGroupLabel(group.key, language))}</strong>
            <p>${escapeHtml(group.items.map(formatTechnicalItem).join("  |  "))}</p>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function renderPrintableKpiCards(kpis) {
  return `
    <section class="pdf-kpi-grid">
      ${kpis.map(kpi => `
        <article class="pdf-kpi-card">
          <strong>${escapeHtml(kpi.value)}</strong>
          <span>${escapeHtml(kpi.label)}</span>
          <p>${escapeHtml(kpi.note)}</p>
        </article>
      `).join("")}
    </section>
  `;
}

function renderPrintableSkillTable(groups) {
  if (!groups.length) {
    return `<p class="pdf-empty">No observed skill group has enough attributable evidence for this report.</p>`;
  }
  return `
    <table class="pdf-table">
      <thead>
        <tr>
          <th>Group</th>
          <th>Observed skills</th>
          <th>Confidence</th>
        </tr>
      </thead>
      <tbody>
        ${groups.map(group => `
          <tr>
            <td>${escapeHtml(group.title)}</td>
            <td>${escapeHtml((group.skills || []).slice(0, 3).map(skill => skill.label).join(", "))}</td>
            <td>${escapeHtml(String(group.confidence_score || 0))}/100</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderPrintableEvidenceTable(items) {
  if (!items.length) {
    return `<p class="pdf-empty">No attributable excerpts are available for this report.</p>`;
  }
  return `
    <table class="pdf-table pdf-table-compact">
      <thead>
        <tr>
          <th>Skill</th>
          <th>Context</th>
          <th>Excerpt</th>
        </tr>
      </thead>
      <tbody>
        ${items.map(item => `
          <tr>
            <td>${escapeHtml(item.skill)}</td>
            <td>${escapeHtml(item.group)}<br>${escapeHtml(item.title)}</td>
            <td>${escapeHtml(item.excerpt)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderPrintableConversationTable(items) {
  if (!items.length) {
    return `<p class="pdf-empty">No approved conversation is available for this report.</p>`;
  }
  return `
    <table class="pdf-table pdf-table-compact">
      <thead>
        <tr>
          <th>Date</th>
          <th>Conversation</th>
          <th>Category</th>
          <th>Sample</th>
        </tr>
      </thead>
      <tbody>
        ${items.map(item => `
          <tr>
            <td>${escapeHtml(item.date)}</td>
            <td>${escapeHtml(item.title)}</td>
            <td>${escapeHtml(item.category)}</td>
            <td>${escapeHtml(item.excerpt)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function buildPrintableReportHtml(snapshot, config) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>ai-work-passport-${escapeHtml(config.sanitized_profile_name || sanitizedFilenameName(config.profile_name))}</title>
    <style>
      :root {
        --ink: #1f2726;
        --muted: #5f6d69;
        --line: #d7e1de;
        --accent: #136f63;
        --accent-soft: #e8f1ef;
        --panel: #ffffff;
        --paper: #f7f8f6;
      }
      * { box-sizing: border-box; }
      @page { size: A4 portrait; margin: 12mm; }
      html, body { margin: 0; padding: 0; background: var(--paper); color: var(--ink); font-family: "Segoe UI", Arial, sans-serif; }
      body { counter-reset: page; }
      .pdf-root { width: 100%; }
      .pdf-page {
        width: 186mm;
        min-height: 273mm;
        margin: 0 auto 10mm;
        padding: 0;
        background: var(--panel);
        page-break-after: always;
        break-after: page;
        display: grid;
        gap: 8mm;
      }
      .pdf-page:last-child { page-break-after: auto; break-after: auto; }
      .pdf-header {
        padding: 8mm 9mm 0;
        display: flex;
        justify-content: space-between;
        gap: 8mm;
        align-items: flex-start;
      }
      .pdf-header h1 { margin: 0 0 3mm; font-size: 24px; line-height: 1.05; }
      .pdf-header p { margin: 0; color: var(--muted); font-size: 11px; line-height: 1.4; }
      .pdf-meta { display: grid; gap: 2mm; text-align: right; font-size: 10px; color: var(--muted); text-transform: uppercase; }
      .pdf-meta strong { color: var(--ink); font-size: 12px; }
      .pdf-section { padding: 0 9mm; }
      .pdf-panel { border: 1px solid var(--line); border-radius: 4mm; padding: 5mm; background: #fff; }
      .pdf-panel h2, .pdf-panel h3 { margin: 0 0 3mm; }
      .pdf-panel p { margin: 0; line-height: 1.5; font-size: 11px; }
      .pdf-kpi-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4mm; }
      .pdf-kpi-card { border: 1px solid var(--line); border-radius: 4mm; padding: 4mm; background: #fff; }
      .pdf-kpi-card strong { display: block; color: var(--accent); font-size: 22px; line-height: 1; margin-bottom: 2mm; }
      .pdf-kpi-card span { display: block; font-size: 10px; font-weight: 700; text-transform: uppercase; line-height: 1.3; }
      .pdf-kpi-card p { margin-top: 2mm; font-size: 10px; color: var(--muted); }
      .pdf-grid-two { display: grid; grid-template-columns: 1.2fr 0.8fr; gap: 5mm; align-items: start; }
      .pdf-grid-two-equal { display: grid; grid-template-columns: 1fr 1fr; gap: 5mm; align-items: start; }
      .pdf-chip-row { display: flex; flex-wrap: wrap; gap: 2mm; margin-top: 3mm; }
      .pdf-chip-row span { padding: 1.5mm 2.5mm; border-radius: 999px; background: var(--accent-soft); color: #21423d; font-size: 9px; font-weight: 700; }
      .pdf-table { width: 100%; border-collapse: collapse; font-size: 10px; }
      .pdf-table th, .pdf-table td { border-bottom: 1px solid var(--line); padding: 2.5mm 2mm; text-align: left; vertical-align: top; }
      .pdf-table th { font-size: 9px; text-transform: uppercase; color: var(--muted); letter-spacing: 0.03em; }
      .pdf-table-compact td { font-size: 9.5px; line-height: 1.35; }
      .pdf-empty { margin: 0; color: var(--muted); font-size: 10px; }
      .pdf-footer {
        margin-top: auto;
        padding: 0 9mm 7mm;
        display: flex;
        justify-content: space-between;
        gap: 4mm;
        color: var(--muted);
        font-size: 9px;
      }
      .pdf-radar .radar-wrap { display: grid; grid-template-columns: minmax(250px, 1fr) minmax(130px, 0.7fr); gap: 4mm; align-items: center; }
      .pdf-radar .radar-chart { width: 100%; max-width: 320px; aspect-ratio: 1; }
      .pdf-radar .radar-grid { fill: none; stroke: #cfd8d0; stroke-width: 1; }
      .pdf-radar .radar-axis { stroke: #d7ddd5; stroke-width: 1; }
      .pdf-radar .radar-shape { fill: rgba(19, 111, 99, 0.22); stroke: var(--accent); stroke-width: 3; }
      .pdf-radar .radar-dot { fill: #b64f35; stroke: #fff; stroke-width: 2; }
      .pdf-radar .radar-label { fill: var(--ink); font-size: 10px; font-weight: 700; }
      .pdf-radar .radar-side { display: grid; gap: 3mm; }
      .pdf-radar .radar-legend { display: grid; gap: 2mm; padding: 0; margin: 0; list-style: none; }
      .pdf-radar .radar-legend li { display: grid; gap: 1mm; padding-bottom: 2mm; border-bottom: 1px solid var(--line); }
      .pdf-radar .radar-legend span { font-size: 10px; font-weight: 700; }
      .pdf-radar .radar-legend strong { color: var(--muted); font-size: 9px; font-weight: 600; }
      .pdf-radar .not-assessed-list { border: 1px dashed var(--line); border-radius: 3mm; padding: 3mm; }
      .pdf-radar .not-assessed-list strong { display: block; margin-bottom: 2mm; font-size: 10px; }
      .pdf-radar .not-assessed-list p { margin: 0 0 2mm; font-size: 9px; }
      .pdf-radar .not-assessed-list em { display: block; color: var(--muted); font-style: normal; }
      .pdf-evidence-mix { display: grid; gap: 3mm; }
      .pdf-evidence-bar { display: flex; height: 10px; overflow: hidden; border-radius: 999px; background: #dce9e6; }
      .pdf-evidence-bar i { display: block; height: 100%; }
      .pdf-evidence-bar .direct { background: #16877f; }
      .pdf-evidence-bar .mixed { background: #2aa79e; }
      .pdf-evidence-bar .external { background: #7c8d89; }
      .pdf-evidence-bar .ai { background: #c48d2f; }
      .pdf-evidence-bar .unknown { background: #a1b1ad; }
      .pdf-legend { display: flex; flex-wrap: wrap; gap: 2mm; }
      .pdf-legend span { display: inline-flex; align-items: center; gap: 1.5mm; padding: 1.5mm 2.5mm; background: var(--accent-soft); border-radius: 999px; font-size: 9px; }
      .pdf-legend b { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
      .pdf-legend .direct { background: #16877f; }
      .pdf-legend .mixed { background: #2aa79e; }
      .pdf-legend .external { background: #7c8d89; }
      .pdf-legend .ai { background: #c48d2f; }
      .pdf-legend .unknown { background: #a1b1ad; }
    </style>
  </head>
  <body>
    <main class="pdf-root">
      <section class="pdf-page">
        <header class="pdf-header">
          <div>
            <p>EviLayer Snapshot</p>
            <h1>${escapeHtml(snapshot.personName)}</h1>
            <p>${escapeHtml(snapshot.summary)}</p>
          </div>
          <div class="pdf-meta">
            <span>Extracted <strong>${escapeHtml(snapshot.extractedDate)}</strong></span>
            <span>Data analyzed <strong>${escapeHtml(snapshot.dataRange)}</strong></span>
            <span>Observation period <strong>${escapeHtml(snapshot.observationPeriod)}</strong></span>
          </div>
        </header>
        <section class="pdf-section">
          <article class="pdf-panel">
            <h2>Professional signature</h2>
            <p>${escapeHtml(snapshot.professionalSignature)}</p>
            <div class="pdf-chip-row">
              ${snapshot.observedDomains.map(domain => `<span>${escapeHtml(domain)}</span>`).join("")}
            </div>
            <p style="margin-top:3mm"><strong>Typical contribution:</strong> ${escapeHtml(snapshot.typicalContribution)}</p>
          </article>
        </section>
        <section class="pdf-section">
          ${renderPrintableKpiCards(snapshot.kpis)}
        </section>
        <section class="pdf-section pdf-grid-two">
          <article class="pdf-panel pdf-radar">
            <h2>Observed capability profile</h2>
            ${renderRadar(snapshot.axes)}
          </article>
          <article class="pdf-panel pdf-evidence-mix">
            <h3>Evidence mix</h3>
            <div class="pdf-evidence-bar">
              ${snapshot.evidenceMix.segments.map(segment => `<i class="${escapeHtml(segment.tone)}" style="width:${escapeHtml(String(segment.value))}%"></i>`).join("")}
            </div>
            <div class="pdf-legend">
              ${snapshot.evidenceMix.segments.map(segment => `<span><b class="${escapeHtml(segment.tone)}"></b>${escapeHtml(segment.label)} ${escapeHtml(String(segment.value))}%</span>`).join("")}
            </div>
            <div class="pdf-chip-row">
              ${snapshot.categoryBreakdown.map(item => `<span>${escapeHtml(item.label)} ${escapeHtml(String(item.count))}</span>`).join("")}
            </div>
          </article>
        </section>
        <footer class="pdf-footer">
          <span>Evidence-backed profile from approved professional conversations.</span>
          <span>Not a hiring score and not independently verified.</span>
        </footer>
      </section>
      <section class="pdf-page">
        <header class="pdf-header">
          <div>
            <p>Observed skill groups</p>
            <h1>EviLayer Evidence Report</h1>
            <p>A detailed and explainable analysis of professional evidence.</p>
          </div>
          <div class="pdf-meta">
            <span>Skill groups <strong>${escapeHtml(String(snapshot.skillGroups.length))}</strong></span>
            <span>Conversations <strong>${escapeHtml(String(snapshot.analyzedConversations.length))}</strong></span>
            <span>Evidence excerpts <strong>${escapeHtml(String(snapshot.evidenceHighlights.length))}</strong></span>
          </div>
        </header>
        <section class="pdf-section">
          <article class="pdf-panel">
            <h2>Observed skill groups</h2>
            ${renderPrintableSkillTable(snapshot.skillGroups)}
          </article>
        </section>
        <section class="pdf-section pdf-grid-two-equal">
          <article class="pdf-panel">
            <h3>Approved conversations</h3>
            ${renderPrintableConversationTable(snapshot.analyzedConversations)}
          </article>
          <article class="pdf-panel">
            <h3>Evidence highlights</h3>
            ${renderPrintableEvidenceTable(snapshot.evidenceHighlights)}
          </article>
        </section>
        <footer class="pdf-footer">
          <span>Excerpts are shortened and redacted for readability.</span>
          <span>Missing evidence is treated as not assessed.</span>
        </footer>
      </section>
    </main>
  </body>
</html>`;
}

function openPrintableReport(snapshot, config) {
  const previousFrame = document.getElementById("printFrame");
  if (previousFrame) previousFrame.remove();

  const frame = document.createElement("iframe");
  frame.id = "printFrame";
  frame.setAttribute("aria-hidden", "true");
  frame.style.position = "fixed";
  frame.style.right = "0";
  frame.style.bottom = "0";
  frame.style.width = "0";
  frame.style.height = "0";
  frame.style.border = "0";
  frame.style.opacity = "0";
  document.body.appendChild(frame);

  frame.onload = () => {
    const printWindow = frame.contentWindow;
    if (!printWindow) {
      frame.remove();
      alert("Unable to initialize PDF printing.");
      return;
    }

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      window.setTimeout(() => frame.remove(), 300);
    };

    printWindow.onafterprint = cleanup;
    window.setTimeout(cleanup, 2000);
    printWindow.focus();
    printWindow.print();
  };

  const doc = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document);
  if (!doc) {
    frame.remove();
    alert("Unable to prepare the PDF document.");
    return;
  }
  doc.open();
  doc.write(buildPrintableReportHtml(snapshot, config));
  doc.close();
}

function renderSnapshotSkillGroups(groups) {
  if (!groups.length) {
    return `<div class="snapshot-empty">No skill group has enough attributable evidence for this period.</div>`;
  }
  return `
    <div class="skill-group-grid">
      ${groups.map(group => `
        <article class="skill-group-card">
          <div class="skill-group-head">
            <strong>${escapeHtml(group.title)}</strong>
            <span>${escapeHtml(String(group.confidence_score || 0))}/100</span>
          </div>
          <div class="skill-group-track"><i style="width:${Math.max(0, Math.min(100, group.confidence_score || 0))}%"></i></div>
          <ul class="skill-list">
            ${group.skills.slice(0, 2).map(skill => `
              <li>
                <div class="skill-list-head">
                  <strong>${escapeHtml(skill.label)}</strong>
                  <span>${escapeHtml(String(skill.confidence_score || 0))}/100</span>
                </div>
                <div class="skill-mini-track"><i style="width:${Math.max(0, Math.min(100, skill.confidence_score || 0))}%"></i></div>
                ${(skill.examples || []).length ? `<em>${escapeHtml(limitWords(skill.examples[0].excerpt || "", 10))}</em>` : ""}
              </li>
            `).join("")}
          </ul>
        </article>
      `).join("")}
    </div>
  `;
}

function renderAnalyzedConversations(items) {
  if (!items.length) {
    return `<div class="snapshot-empty">No approved conversation is available for this appendix.</div>`;
  }
  return `
    <div class="appendix-list">
      ${items.map(item => `
        <article class="appendix-item">
          <div class="appendix-item-head">
            <strong>${escapeHtml(item.title)}</strong>
            <span>${escapeHtml(item.date)}</span>
          </div>
          <p>${escapeHtml(item.category)}</p>
          <div class="conversation-spark"><i style="width:${Math.min(100, 35 + item.excerpt.length / 2)}%"></i></div>
          <em>${escapeHtml(limitWords(item.excerpt, 10))}</em>
        </article>
      `).join("")}
    </div>
  `;
}

function renderEvidenceHighlights(items) {
  if (!items.length) {
    return `<div class="snapshot-empty">No attributable excerpt is available for this appendix.</div>`;
  }
  return `
    <div class="appendix-list">
      ${items.map(item => `
        <article class="appendix-item">
          <div class="appendix-item-head">
            <strong>${escapeHtml(item.skill)}</strong>
            <span>${escapeHtml(String(item.confidenceScore))}/100</span>
          </div>
          <p>${escapeHtml(item.group)} · ${escapeHtml(item.title)}${item.date ? ` · ${escapeHtml(String(item.date).slice(0, 10))}` : ""}</p>
          <div class="conversation-spark"><i style="width:${Math.max(12, Math.min(100, item.confidenceScore || 0))}%"></i></div>
          <em>${escapeHtml(limitWords(item.excerpt, 10))}</em>
        </article>
      `).join("")}
    </div>
  `;
}

function computeAttributablePercentage(coverage, evidenceItems) {
  const source = coverage.source_breakdown || {};
  const direct = Number(source.original_user_input || source.user_provided || coverage.direct_user_inputs || 0);
  const mixed = Number(source.mixed_content || coverage.mixed_content_items || 0);
  const external = Number(source.external_content || coverage.external_documents || 0);
  const ai = Number(source.ai_generated_text || coverage.ai_generated_items || 0);
  const unknown = Number(source.unknown || coverage.unknown_items || 0);
  const total = Object.values(source).reduce((sum, value) => sum + Number(value || 0), 0) || direct + mixed + external + ai + unknown || evidenceItems || 0;
  if (!total) return 0;
  return Math.round(((direct + mixed * 0.5) / total) * 100);
}

function buildSnapshotSummary(axes, notAssessed, language = getReportLanguage(), recurringLabels = []) {
  if (!axes.length) {
    return language === "it"
      ? "Le conversazioni professionali analizzate non contengono abbastanza evidenza attribuibile per sostenere un profilo di capacita nel periodo selezionato."
      : "The analyzed professional conversations do not contain enough attributable evidence to support a visual capability profile for the selected period.";
  }
  const top = recurringLabels.length ? recurringLabels : axes.slice(0, 3).map(axis => axis.label);
  if (language === "it") {
    return `Le conversazioni professionali analizzate mostrano evidenze ricorrenti in ${joinHuman(top)}.`;
  }
  return `The analyzed professional conversations show recurring evidence around ${joinHuman(top)}.`;
}

function buildSnapshotInterpretation(axes, notAssessed, language = getReportLanguage()) {
  if (!axes.length) {
    return language === "it"
      ? "Il limite principale e la disponibilita di evidenze: le conversazioni disponibili non sono sufficienti per valutare le capacita professionali."
      : "The most important limitation is evidence availability: the available conversations are not sufficient to assess professional capability areas.";
  }
  if (language === "it") {
    const limitation = notAssessed.length
      ? `${joinHuman(notAssessed)} ${notAssessed.length === 1 ? "resta" : "restano"} non valutate per evidenza insufficiente.`
      : "Nessuna dimensione con evidenza mancante viene convertita in bassa capacita.";
    return `Il pattern ricorrente piu forte e ${axes[0].label}. Il limite principale riguarda la copertura delle fonti: ${limitation}`;
  }
  const limitation = notAssessed.length
    ? `${joinHuman(notAssessed)} ${notAssessed.length === 1 ? "is" : "are"} not assessed because evidence is insufficient.`
    : "No missing-evidence dimension is converted into a low score.";
  return `The strongest recurring pattern is ${axes[0].label}. The most important limitation is source coverage: ${limitation}`;
}

function formatSnapshotDate(value, language = getReportLanguage()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "-");
  return new Intl.DateTimeFormat(language === "it" ? "it-IT" : "en-GB", { day: "numeric", month: "long", year: "numeric" }).format(date);
}

function formatDataRange(first, last, language = getReportLanguage()) {
  if (!first && !last) return "-";
  if (first && last) return `${formatSnapshotDate(first, language)} - ${formatSnapshotDate(last, language)}`;
  return formatSnapshotDate(first || last, language);
}

function joinHuman(items) {
  const clean = items.filter(Boolean);
  if (clean.length <= 1) return clean[0] || "";
  if (clean.length === 2) return `${clean[0]} and ${clean[1]}`;
  return `${clean.slice(0, -1).join(", ")} and ${clean[clean.length - 1]}`;
}

function limitWords(text, maxWords) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  return words.length <= maxWords ? text : `${words.slice(0, maxWords).join(" ")}.`;
}

function isMetadataLikeLabel(label) {
  return ["original input", "mixed", "partner", "monthly", "surgeon", "operating room"].includes(String(label || "").trim().toLowerCase());
}

function bindSnapshotZoom() {
  const zoom = $("#snapshotZoom");
  const shell = $(".snapshot-page-shell");
  const value = $("#snapshotZoomValue");
  if (!zoom || !shell || !value) return;
  zoom.addEventListener("input", () => {
    const factor = Number(zoom.value) / 100;
    shell.style.setProperty("--snapshot-zoom", factor);
    value.textContent = `${zoom.value}%`;
  });
}

function persistState() {
  try {
    const safeState = {
      ...state,
      __state_version: SESSION_STATE_VERSION,
      reportConfig: state.reportConfig
        ? {
            ...state.reportConfig,
            profile_name: "",
            sanitized_profile_name: ""
          }
        : null
    };
    sessionStorage.setItem(SESSION_STATE_KEY, JSON.stringify(safeState));
    savePromptPreferences(buildCurrentReportConfig());
  } catch (error) {
    console.warn("Unable to persist local session", error);
  }
}

function restoreState() {
  try {
    const prefs = readPromptPreferences();
    if (prefs) {
      if ($("#analysisPeriodSelect") && prefs.selected_months) $("#analysisPeriodSelect").value = String(prefs.selected_months);
      if ($("#aiSourceSelect")) $("#aiSourceSelect").value = String(prefs.source_platform || "");
      if ($("#exportModeSelect")) $("#exportModeSelect").value = String(prefs.export_mode || "quick");
    }
    const raw = sessionStorage.getItem(SESSION_STATE_KEY);
    if (!raw) {
      updateExportPrompt();
      renderEmptySnapshot();
      return;
    }
    const restored = JSON.parse(raw);
    if (!restored || restored.__state_version !== SESSION_STATE_VERSION) {
      sessionStorage.removeItem(SESSION_STATE_KEY);
      updateExportPrompt();
      renderEmptySnapshot();
      return;
    }
    state = {
      sessionId: restored.sessionId || null,
      conversations: restored.conversations || [],
      summary: restored.summary || null,
      reports: restored.reports || null,
      reportMode: restored.reportMode || "private",
      reportConfig: restored.reportConfig || null,
      reviewExpanded: restored.reviewExpanded !== false
    };
    if (state.reportConfig) {
      if ($("#profileNameInput")) $("#profileNameInput").value = "";
      if ($("#analysisPeriodSelect")) $("#analysisPeriodSelect").value = String(state.reportConfig.selected_months || 6);
      if ($("#aiSourceSelect")) $("#aiSourceSelect").value = String(state.reportConfig.source_platform || ($("#aiSourceSelect").value || ""));
      if ($("#exportModeSelect")) $("#exportModeSelect").value = String(state.reportConfig.export_mode || ($("#exportModeSelect").value || "quick"));
    }
    promptGeneratedPayload = null;
    promptGenerationAttempted = false;
    updateExportPrompt();
    $("#deleteBtn").disabled = !state.sessionId;
    if (state.summary) renderSummary();
    if (state.conversations.length) renderReview();
    if (state.reports) renderReports();
    else renderEmptySnapshot();
  } catch (error) {
    console.warn("Unable to restore local session", error);
    renderEmptySnapshot();
  }
}

function renderVisualProfile() {
  const insights = state.reportMode === "public"
    ? state.reports.insights.filter(insight => insight.public_visibility)
    : state.reports.insights;
  const profile = buildClientVisualProfile(insights);
  const temporalMaturity = state.reportMode === "public"
    ? (state.reports.public_report && state.reports.public_report.temporal_maturity) || state.reports.temporal_maturity
    : state.reports.temporal_maturity;
  const evidenceCoverage = state.reportMode === "public"
    ? (state.reports.public_report && state.reports.public_report.evidence_coverage_detail) || state.reports.evidence_coverage_detail
    : state.reports.evidence_coverage_detail;
  const axes = buildRadarAxesFromTemporal(temporalMaturity);
  const modeLabel = state.reportMode === "public" ? "EviLayer Profile (Public)" : "EviLayer Profile (Private)";
  $("#visualProfile").innerHTML = `
    ${renderEvidenceCoverage(evidenceCoverage)}
    <section class="visual-grid">
      <div class="visual-panel radar-panel">
        <div class="visual-head">
          <div>
            <p class="eyebrow">Observed evidence strength</p>
            <h4>${modeLabel}</h4>
          </div>
          <span class="pill">${axes.length} assi</span>
        </div>
        ${renderRadar(axes)}
      </div>
      <div class="visual-panel">
        <div class="visual-head">
          <div>
            <p class="eyebrow">Temporal maturity</p>
            <h4>${escapeHtml((temporalMaturity && temporalMaturity.section_title) || "Evidence by period")}</h4>
          </div>
          <span class="pill">${temporalMaturity && temporalMaturity.years ? temporalMaturity.years.length : 0} anni</span>
        </div>
        ${renderTimeline(temporalMaturity)}
      </div>
    </section>
    ${renderTechnologyReasoning(insights)}
    <p class="visual-note">I grafici mostrano la forza delle evidenze selezionate, non un voto sulla persona. La vista pubblica esclude gli insight non condivisi.</p>
  `;
}

function renderEvidenceCoverage(coverage) {
  if (!coverage) return "";
  return `
    <section class="coverage-panel">
      <div class="visual-head">
        <div>
          <p class="eyebrow">Evidence Coverage</p>
          <h4>Qualita' e provenienza delle fonti</h4>
        </div>
        <span class="pill">${coverage.total_evidence_items || 0} evidence items</span>
      </div>
      <div class="coverage-grid">
        ${metric("Conversazioni professionali", coverage.total_professional_conversations)}
        ${metric("Direct user inputs", coverage.direct_user_inputs)}
        ${metric("Mixed content", coverage.mixed_content_items)}
        ${metric("AI-generated items", coverage.ai_generated_items)}
        ${metric("External documents", coverage.external_documents)}
        ${metric("Uncertain evidence", coverage.uncertain_evidence)}
        ${metric("Dimensioni sufficienti", coverage.dimensions_with_sufficient_evidence)}
        ${metric("Dimensioni insufficienti", coverage.dimensions_with_insufficient_evidence)}
      </div>
      <div class="evidence-key">
        <span><strong>Positive</strong> evidenza che supporta una dimensione.</span>
        <span><strong>Counter</strong> limite esplicito o dipendenza dichiarata.</span>
        <span><strong>Uncertain</strong> fonte non attribuibile o segnale troppo debole.</span>
        <span><strong>Not assessed</strong> evidenza insufficiente: nessun punteggio di abilita'.</span>
      </div>
    </section>
  `;
}

function buildRadarAxesFromTemporal(temporalMaturity) {
  if (!temporalMaturity || !temporalMaturity.dimensions) return [];
  return temporalMaturity.dimensions
    .filter(dimension => dimension.radar_eligible)
    .map(dimension => ({
      dimension: dimension.id,
      canonical_dimension: dimension.canonical_dimension || dimension.id,
      label: dimension.label,
      strength: dimension.capability_score,
      coverage: dimension.evidence_coverage,
      level: dimension.status,
      assessed: dimension.capability_score != null,
      derivation: dimension.derivation || "application_derived_dimension",
      semantic_type: dimension.semantic_type || null,
      radar_eligible: Boolean(dimension.radar_eligible),
      discovered_from: dimension.discovered_from || null,
      confidence: dimension.confidence,
      positive_count: dimension.positive_count,
      negative_count: dimension.negative_count,
      uncertain_count: dimension.uncertain_count,
      unique_conversation_count: dimension.unique_conversation_count,
      source_breakdown: dimension.source_breakdown || {}
    }))
    .sort((a, b) => (b.coverage || 0) - (a.coverage || 0));
}

function buildClientVisualProfile(insights) {
  const dimensionMap = new Map();
  for (const insight of insights) {
    const current = dimensionMap.get(insight.dimension) || {
      dimension: insight.dimension,
      label: dimensionLabel(insight.dimension),
      strength: 0,
      evidence_count: 0,
      insight_count: 0
    };
    current.strength += evidenceStrength(insight);
    current.evidence_count += insight.evidence_count || 0;
    current.insight_count += 1;
    dimensionMap.set(insight.dimension, current);
  }
  const axes = Array.from(dimensionMap.values())
    .map(axis => ({
      ...axis,
      strength: Math.round(axis.strength / Math.max(1, axis.insight_count)),
      level: evidenceLevel(axis.strength / Math.max(1, axis.insight_count))
    }))
    .sort((a, b) => b.strength - a.strength);

  return { axes };
}

function buildClientTechnologyReasoning(insights) {
  const signals = technologyReasoningSignals().map(signal => {
    const evidence = insights
      .flatMap(insight => insight.evidence_for || [])
      .filter(evidence => signal.terms.some(term => String(evidence.excerpt || "").toLowerCase().includes(term)))
      .slice(0, 4);
    const strength = evidence.length >= 4 ? 82 : evidence.length === 3 ? 68 : evidence.length === 2 ? 52 : evidence.length === 1 ? 34 : 0;
    return {
      ...signal,
      evidence,
      evidence_count: evidence.length,
      strength,
      level: evidenceLevel(strength)
    };
  });
  return {
    signals,
    observed: signals.filter(signal => signal.evidence_count > 0)
  };
}

function technologyReasoningSignals() {
  return [
    {
      id: "tech_debugging",
      label: "Debugging",
      terms: ["bug", "errore", "error", "causa", "root cause", "stack trace", "log", "riprodurre", "reproduce", "fix"],
      summary: "Indaga cause, sintomi e impatto prima di proporre una correzione."
    },
    {
      id: "tech_testing",
      label: "Testing mindset",
      terms: ["test", "edge case", "caso limite", "regression", "coverage", "unit test", "integrazione", "qa"],
      summary: "Mostra attenzione a test, regressioni, casi limite e verifica delle soluzioni."
    },
    {
      id: "tech_architecture",
      label: "Architecture reasoning",
      terms: ["architettura", "architecture", "scalabil", "servizio", "microserv", "database", "api", "caching", "queue", "dipenden"],
      summary: "Ragiona su componenti, dipendenze, trade-off architetturali e integrazioni."
    },
    {
      id: "tech_security",
      label: "Security awareness",
      terms: ["security", "sicurezza", "token", "secret", "password", "credential", "privacy", "encrypt", "auth", "permission", "accesso"],
      summary: "Considera credenziali, permessi, dati sensibili e rischi di esposizione."
    },
    {
      id: "tech_operations",
      label: "Operational reliability",
      terms: ["deploy", "rollback", "monitoring", "alert", "incident", "uptime", "timeout", "retry", "fallback", "performance"],
      summary: "Collega scelte tecniche a rilascio, monitoraggio, resilienza e continuita' operativa."
    },
    {
      id: "tech_data_api",
      label: "Data & API thinking",
      terms: ["sql", "dataset", "schema", "payload", "endpoint", "api", "json", "metric", "kpi", "validation"],
      summary: "Mostra attenzione a strutture dati, contratti API, validazione e metriche."
    }
  ];
}

function confidenceWeight(confidence) {
  if (confidence === "high") return 1;
  if (confidence === "medium") return 0.72;
  if (confidence === "low") return 0.45;
  return 0.35;
}

function evidenceStrength(insight) {
  const evidenceFactor = Math.min(1, Math.max(0.2, (insight.evidence_count || 1) / 5));
  const userFactor = insight.user_status === "accepted" ? 1.08 :
    insight.user_status === "contextualized" ? 0.96 :
    insight.user_status === "contested" ? 0.58 :
    insight.user_status === "private_only" ? 0.75 : 0.88;
  return Math.max(12, Math.min(100, Math.round(100 * evidenceFactor * confidenceWeight(insight.confidence) * userFactor)));
}

function evidenceLevel(strength) {
  if (strength >= 70) return "strongly supported";
  if (strength >= 50) return "recurring";
  if (strength >= 36) return "observed";
  if (strength > 0) return "emerging";
  return "insufficient_evidence";
}

function isNotAssessedStatus(status) {
  return status === "insufficient_evidence" || status === "not assessed";
}

function displayStatus(status, language = getReportLanguage()) {
  const map = language === "it"
    ? {
        insufficient_evidence: "non valutata",
        "not assessed": "non valutata",
        counter_evidence_only: "solo contro-evidenze",
        mixed_evidence: "evidenza mista",
        emerging: "emergente",
        observed: "osservata",
        recurring: "ricorrente",
        strongly_supported: "fortemente supportata"
      }
    : {
        insufficient_evidence: "not assessed",
        "not assessed": "not assessed",
        counter_evidence_only: "counter evidence only",
        mixed_evidence: "mixed evidence",
        emerging: "emerging",
        observed: "observed",
        recurring: "recurring",
        strongly_supported: "strongly supported"
      };
  if (isNotAssessedStatus(status)) return map["not assessed"];
  return map[status] || String(status || map["not assessed"]).replace(/_/g, " ");
}

function displayDirection(direction) {
  if (!direction || direction === "historical comparison unavailable") return "";
  return direction;
}

function compactRadarLabel(label) {
  const labels = {
    "Technical literacy": "Technical\nliteracy",
    "Technical autonomy": "Technical\nautonomy",
    "API and data reasoning": "API/data\nreasoning",
    "Architecture awareness": "Architecture\nawareness",
    "Requirement clarity": "Requirement\nclarity",
    "Decision ownership": "Decision\nownership",
    "Business-technology translation": "Business-tech\ntranslation",
    "Direct technical execution": "Direct technical\nexecution"
  };
  const value = String(label || "");
  if (labels[value]) return labels[value];
  const words = value.split(/\s+/);
  return words.length > 2 ? `${words.slice(0, 2).join(" ")}\n${words.slice(2, 4).join(" ")}` : value;
}

function svgMultilineLabel(label, x, y) {
  const lines = compactRadarLabel(label).split("\n").slice(0, 2);
  const yOffset = lines.length === 1 ? 0 : -6;
  return `
    <text x="${x}" y="${y + yOffset}" text-anchor="middle" dominant-baseline="middle" class="radar-label">
      ${lines.map((line, index) => `<tspan x="${x}" dy="${index ? 12 : 0}">${escapeHtml(line)}</tspan>`).join("")}
    </text>
  `;
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
  return labels[dimension] || String(dimension || "").replace(/_/g, " ");
}

function renderRadar(axes, texts = reportText(getReportLanguage())) {
  if (!axes.length) return `<div class="empty-visual">${escapeHtml(texts.notAssessed)}</div>`;
  if (axes.length > 6) {
    return `
      <div class="capability-bars">
        ${axes.slice(0, 6).map(axis => renderSnapshotAxis(axis)).join("")}
      </div>
    `;
  }
  const assessedAxes = axes.filter(axis => axis.assessed && typeof axis.strength === "number");
  const notAssessedAxes = axes.filter(axis => !axis.assessed || typeof axis.strength !== "number");
  if (!assessedAxes.length) {
    return `
      <div class="radar-wrap">
        <div class="empty-visual">${escapeHtml(texts.notAssessed)}</div>
        ${renderNotAssessedAxes(notAssessedAxes, texts)}
      </div>
    `;
  }
  const size = 360;
  const center = size / 2;
  const maxRadius = 118;
  const levels = [0.25, 0.5, 0.75, 1];
  const points = assessedAxes.map((axis, index) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / assessedAxes.length;
    const value = axis.strength;
    const radius = maxRadius * (value / 100);
    return {
      ...axis,
      angle,
      x: center + Math.cos(angle) * radius,
      y: center + Math.sin(angle) * radius,
      axisX: center + Math.cos(angle) * maxRadius,
      axisY: center + Math.sin(angle) * maxRadius,
      labelX: center + Math.cos(angle) * (maxRadius + 34),
      labelY: center + Math.sin(angle) * (maxRadius + 34)
    };
  });
  const polygon = points.map(point => `${point.x},${point.y}`).join(" ");
  const grid = levels.map(level => {
    const gridPoints = points.map(point => {
      const radius = maxRadius * level;
      return `${center + Math.cos(point.angle) * radius},${center + Math.sin(point.angle) * radius}`;
    }).join(" ");
    return `<polygon points="${gridPoints}" class="radar-grid"></polygon>`;
  }).join("");
  const axesLines = points.map(point => `<line x1="${center}" y1="${center}" x2="${point.axisX}" y2="${point.axisY}" class="radar-axis"></line>`).join("");
  const labels = points.map(point => `
    ${svgMultilineLabel(point.label, point.labelX, point.labelY)}
    <circle cx="${point.x}" cy="${point.y}" r="4.5" class="radar-dot">
      <title>${escapeHtml(radarTooltip(point))}</title>
    </circle>
  `).join("");
  const legend = assessedAxes.map(axis => {
    const coverage = axis.coverage >= 75 ? "high coverage" : axis.coverage >= 45 ? "medium coverage" : "limited coverage";
    const confidence = String(texts.confidence[axis.confidence] || axis.confidence || "").toLowerCase();
    return `
      <li><span>${escapeHtml(axis.label)}</span><strong>${escapeHtml(displayStatus(axis.level))} · ${escapeHtml(coverage)} · ${escapeHtml(confidence)} confidence</strong></li>
    `;
  }).join("");
  return `
    <div class="radar-wrap">
      <svg viewBox="0 0 ${size} ${size}" class="radar-chart" role="img" aria-label="Radar chart evidence strength">
        ${grid}
        ${axesLines}
        <polygon points="${polygon}" class="radar-shape"></polygon>
        ${labels}
      </svg>
      <div class="radar-side">
        <ul class="radar-legend">${legend}</ul>
        ${renderNotAssessedAxes(notAssessedAxes, texts)}
      </div>
    </div>
  `;
}

function renderNotAssessedAxes(axes, texts = reportText(getReportLanguage())) {
  if (!axes.length) return "";
  return `
    <div class="not-assessed-list">
      <strong>${escapeHtml(texts.notAssessed)}</strong>
      ${axes.map(axis => `
        <p>
          <span>${escapeHtml(axis.label)}</span>
          <em>${escapeHtml(axis.coverage >= 75 ? "High coverage" : axis.coverage >= 45 ? "Medium coverage" : "Limited coverage")}</em>
        </p>
      `).join("")}
    </div>
  `;
}

function radarTooltip(axis) {
  const sources = axis.source_breakdown || {};
  return [
    axis.label,
    `status: ${displayStatus(axis.level)}`,
    `assessment: ${axis.assessed ? "available" : "unavailable"}`,
    `evidence strength: ${axis.strength == null ? "not assessed" : `${axis.strength}/100`}`,
    `evidence coverage: ${axis.coverage || 0}/100`,
    `confidence: ${axis.confidence}`,
    `positive evidence: ${axis.positive_count || 0}`,
    `counter-evidence: ${axis.negative_count || 0}`,
    `uncertain: ${axis.uncertain_count || 0}`,
    `unique conversations: ${axis.unique_conversation_count || 0}`,
    `standard dimension: ${axis.canonical_dimension}`,
    `evidence type: ${axis.semantic_type || "n/a"}`,
    `dimension source: ${axis.derivation === "semantic_capability_extraction" ? "extracted evidence label" : "standard professional dimension"}`,
    axis.discovered_from ? `discovered term: ${axis.discovered_from.term}` : "",
    `sources: direct ${sources.original_user_input || 0}, mixed ${sources.mixed_content || 0}, ai ${sources.ai_generated_text || 0}, external ${sources.external_content || 0}`
  ].filter(Boolean).join("\n");
}

function renderTimeline(temporalMaturity) {
  if (!temporalMaturity || !temporalMaturity.years || !temporalMaturity.years.length) {
    return `<div class="empty-visual">Dated evidence is required to build the timeline.</div>`;
  }
  const preferredCore = ["decision_making", "problem_solving", "communication", "execution", "leadership", "collaboration", "planning", "learning", "domain_knowledge", "data_reasoning", "risk_awareness", "quality_improvement"];
  const dimensions = temporalMaturity.dimensions
    .slice()
    .sort((a, b) => {
      const aDiscovered = a.derivation === "semantic_capability_extraction" ? 1 : 0;
      const bDiscovered = b.derivation === "semantic_capability_extraction" ? 1 : 0;
      const aEvidence = (a.positive_count || 0) + (a.negative_count || 0) + (a.uncertain_count || 0);
      const bEvidence = (b.positive_count || 0) + (b.negative_count || 0) + (b.uncertain_count || 0);
      return bDiscovered - aDiscovered || bEvidence - aEvidence || preferredCore.indexOf(a.id) - preferredCore.indexOf(b.id);
    })
    .slice(0, 9);
  const header = temporalMaturity.years.map(year => `<th>${year}</th>`).join("");
  const rows = dimensions.map(dimension => `
    <tr>
      <th>
        <span>${escapeHtml(dimension.label)}</span>
        ${displayDirection(dimension.direction_of_change) ? `<em>${escapeHtml(displayDirection(dimension.direction_of_change))}</em>` : ""}
        <small>${dimension.derivation === "semantic_capability_extraction" ? "context label" : "standard dimension"}</small>
      </th>
      ${temporalMaturity.years.map(year => {
        const cell = dimension.years.find(item => item.year === year) || {};
        return `
          <td class="maturity-cell ${statusClass(cell.status)}">
            <strong>${escapeHtml(displayStatus(cell.status))}</strong>
            <span class="evidence-counts">positive ${cell.positive_count || 0} - counter ${cell.negative_count || 0} - uncertain ${cell.uncertain_count || 0}</span>
            <em>${escapeHtml(cell.confidence || "low")} confidence</em>
          </td>
        `;
      }).join("")}
    </tr>
  `).join("");
  const capability = renderCapabilityStages(temporalMaturity);
  return `
    <div class="maturity-wrap">
      <p class="timeline-scope">${escapeHtml(temporalMaturity.scope)}</p>
      ${temporalMaturity.dimension_strategy ? `<p class="timeline-scope">The radar uses standard professional dimensions and shows only those with at least two evidence items from two different conversations. When the file contains more specific professional concepts, they are used as contextual labels.</p>` : ""}
      <div class="evidence-key compact">
        <span><strong>Positive</strong> supports the dimension.</span>
        <span><strong>Counter</strong> explicit limitation or dependency.</span>
        <span><strong>Uncertain</strong> weak or non-attributable source.</span>
      </div>
      <table class="maturity-table">
        <thead><tr><th>Dimension</th>${header}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${renderDimensionDetails(dimensions)}
      ${capability}
    </div>
  `;
}

function renderRejectedCandidates(candidates) {
  if (!candidates || !candidates.length) return "";
  return "";
  return `
    <div class="not-assessed-list semantic-rejections">
      <strong>Elementi esclusi dal radar</strong>
      ${candidates.slice(0, 5).map(candidate => `
        <p>
          <span>${escapeHtml(candidate.candidate)}</span>
          <em>${semanticTypeLabel(candidate.semantic_type)} - non e' una capacita' valutabile</em>
        </p>
      `).join("")}
    </div>
  `;
}

function semanticTypeLabel(type) {
  const labels = {
    specialization: "specialization or context",
    metadata: "metadata",
    role: "role",
    domain: "domain",
    actor: "actor",
    frequency: "frequency",
    provenance: "provenance",
    unknown: "unclassified"
  };
  return labels[type] || String(type || "item");
}

function renderDimensionDetails(dimensions) {
  return `
    <div class="dimension-details">
      ${dimensions.map(dimension => `
        <article class="dimension-detail">
          <div class="signal-top">
            <strong>${escapeHtml(dimension.label)}</strong>
            <span>${escapeHtml(displayStatus(dimension.status))}</span>
          </div>
          <div class="dimension-origin">${dimension.derivation === "semantic_capability_extraction" ? "Extracted contextual label" : "Standard professional dimension"}</div>
          ${dimension.canonical_dimension ? `<div class="source-line user-facing-source">Standard area: ${escapeHtml(dimension.canonical_dimension)} - Evidence: ${escapeHtml(dimension.semantic_type || "capability")}</div>` : ""}
          ${dimension.canonical_dimension ? `<div class="source-line">Canonical: ${escapeHtml(dimension.canonical_dimension)} · Type: ${escapeHtml(dimension.semantic_type || "n/a")}</div>` : ""}
          ${dimension.discovered_from ? `<div class="source-line">Display label source: ${escapeHtml(dimension.discovered_from.term)} · ${dimension.discovered_from.conversation_count} conversations</div>` : ""}
          <p>${escapeHtml(dimension.interpretation || dimension.description || "")}</p>
          <div class="dimension-metrics">
            <span>Confidence: ${escapeHtml(dimension.confidence)}</span>
            <span>Evidence strength: ${dimension.capability_score == null ? "not assessed" : `${dimension.capability_score}/100`}</span>
            <span>Evidence coverage: ${dimension.evidence_coverage || 0}/100</span>
            <span>Positive: ${dimension.positive_count || 0}</span>
            <span>Counter: ${dimension.negative_count || 0}</span>
            <span>Uncertain: ${dimension.uncertain_count || 0}</span>
            <span>Conversations: ${dimension.unique_conversation_count || 0}</span>
          </div>
          <div class="source-line">Sources: direct ${dimension.source_breakdown?.original_user_input || 0}, mixed ${dimension.source_breakdown?.mixed_content || 0}, AI ${dimension.source_breakdown?.ai_generated_text || 0}, external ${dimension.source_breakdown?.external_content || 0}</div>
          ${renderEvidenceList("Supported by", dimension.supporting_evidence)}
          ${renderEvidenceList("Limits", dimension.counter_evidence)}
        </article>
      `).join("")}
    </div>
  `;
}

function renderEvidenceList(title, evidence) {
  if (!evidence || !evidence.length) return "";
  return `
    <div class="mini-evidence">
      <strong>${title}</strong>
      ${evidence.slice(0, 2).map(item => `<p>${escapeHtml(item.excerpt)} <em>${escapeHtml(item.id)}</em></p>`).join("")}
    </div>
  `;
}

function renderCapabilityStages(temporalMaturity) {
  const rows = temporalMaturity.capability_stages.map(yearGroup => `
    <div class="capability-year">
      <strong>${yearGroup.year}</strong>
      <div>
        ${yearGroup.stages.map(stage => `
          <span class="${stage.status === "insufficient_evidence" ? "muted-stage" : ""}">
            ${escapeHtml(stage.label)}: ${escapeHtml(displayStatus(stage.status))}
          </span>
        `).join("")}
      </div>
      ${(yearGroup.consistency_notes || []).map(note => `<p class="consistency-note">${escapeHtml(note)}</p>`).join("")}
    </div>
  `).join("");
  return `<div class="capability-stages"><h5>Capability stages</h5>${rows}</div>`;
}

function statusClass(status) {
  if (isNotAssessedStatus(status)) return "not-assessed";
  return String(status || "not-assessed").replace(/_/g, "-").replace(/\s+/g, "-");
}

function renderTechnologyReasoning(insights) {
  const profile = buildClientTechnologyReasoning(insights);
  const observed = profile.observed;
  const signalCards = profile.signals.map(signal => `
    <article class="tech-signal ${signal.evidence_count ? "" : "muted-signal"}">
      <div>
        <div class="signal-top">
          <strong>${escapeHtml(signal.label)}</strong>
          <span>${signal.evidence_count ? escapeHtml(displayStatus(signal.level)) : "not assessed"}</span>
        </div>
        <p>${escapeHtml(signal.summary)}</p>
      </div>
      <div class="signal-meter">
        <div class="bar"><i style="width:${signal.strength}%"></i></div>
        <em>${signal.evidence_count} evidence items</em>
      </div>
    </article>
  `).join("");
  const evidencePreview = observed
    .flatMap(signal => signal.evidence.map(evidence => ({ ...evidence, signal: signal.label })))
    .slice(0, 3)
    .map(item => `
      <li>
        <span>${escapeHtml(item.signal)}</span>
        <p>${escapeHtml(item.excerpt)}</p>
      </li>
    `).join("");
  return `
    <section class="tech-reasoning">
      <div class="visual-head">
        <div>
          <p class="eyebrow">Technology Reasoning</p>
          <h4>Observable technical reasoning</h4>
        </div>
        <span class="pill">${observed.length} observed signals</span>
      </div>
      <p class="tech-scope">Based only on approved and anonymized conversations. It does not access repositories, copy proprietary code, or certify seniority.</p>
      <div class="tech-grid">${signalCards}</div>
      ${evidencePreview ? `<ul class="tech-evidence">${evidencePreview}</ul>` : `<div class="empty-visual small">No technical evidence in the current view.</div>`}
    </section>
  `;
}

function bindInsightControls() {
  $$(".insight-status, .public-visible").forEach(control => {
    control.addEventListener("change", () => {
      state.reports.insights = collectInsights();
      renderVisualProfile();
    });
  });
  $$(".user-comment").forEach(control => {
    control.addEventListener("input", () => {
      state.reports.insights = collectInsights();
    });
  });
}

function collectDecisions() {
  return $$(".conversation").map(card => ({
    id: card.dataset.id,
    include: card.querySelector(".include").checked,
    classification: (state.conversations.find(conversation => String(conversation.id) === String(card.dataset.id)) || {}).classification || card.dataset.classification || "professional"
  }));
}

function collectInsights() {
  if (!$(".insight[data-id]")) {
    return state.reports && state.reports.insights ? state.reports.insights : [];
  }
  return $$(".insight[data-id]").map(card => {
    const current = state.reports.insights.find(insight => insight.id === card.dataset.id);
    return {
      ...current,
      user_status: card.querySelector(".insight-status").value,
      user_comment: card.querySelector(".user-comment").value,
      public_visibility: card.querySelector(".public-visible").checked
    };
  });
}

async function uploadFile(file) {
  const config = buildCurrentReportConfig();
  if (!config.valid) throw new Error("Enter a valid profile name and choose an analysis period between 1 and 12 months.");
  applyReportConfig(config);
  const form = new FormData();
  form.append("file", file);
  form.append("reportConfig", JSON.stringify(state.reportConfig));
  $("#uploadStatus").textContent = "Parsing and classification in progress...";
  const response = await fetch("/api/import", { method: "POST", body: form });
  const payload = await readJsonResponse(response, "Import failed");
  if (!response.ok) throw new Error(payload.error || "Import failed");
  state.sessionId = payload.sessionId;
  state.conversations = payload.conversations;
  state.summary = payload.summary;
  if (payload.report_config) applyReportConfig(payload.report_config);
  $("#deleteBtn").disabled = false;
  renderSummary();
  renderReview();
  persistState();
  $("#uploadStatus").textContent = "Import completed. Continue with Data scan or Review.";
  setView("scan");
}

function downloadJson(name, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 300);
}

async function readJsonResponse(response, fallbackMessage) {
  const text = await response.text();
  if (!text) {
    throw new Error(`${fallbackMessage} (empty response, status ${response.status})`);
  }
  try {
    return JSON.parse(text);
  } catch {
    const snippet = text.slice(0, 180).replace(/\s+/g, " ").trim();
    throw new Error(`${fallbackMessage} (status ${response.status}): ${snippet || "invalid response body"}`);
  }
}

async function exportPdf(endpoint, snapshot, reportConfig, fallbackName) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snapshot, reportConfig })
  });
  if (!response.ok) {
    let error = "PDF export failed";
    try {
      const payload = await readJsonResponse(response, error);
      error = payload.error || error;
    } catch {
      // ignore parse failure
    }
    throw new Error(error);
  }
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") || "";
  const match = /filename="([^"]+)"/.exec(disposition);
  downloadBlob(match ? match[1] : fallbackName, blob);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

$("#uploadForm").addEventListener("submit", async event => {
  event.preventDefault();
  const file = $("#fileInput").files[0];
  if (!file) {
    $("#uploadStatus").textContent = "Select a file first.";
    return;
  }
  try {
    await uploadFile(file);
  } catch (error) {
    $("#uploadStatus").textContent = error.message;
  }
});

$("#sampleBtn").addEventListener("click", async () => {
  const response = await fetch("/samples/synthetic-conversations.json");
  const text = await response.text();
  const file = new File([text], "synthetic-conversations.json", { type: "application/json" });
  await uploadFile(file);
});

if ($("#createProfileCta")) {
  $("#createProfileCta").addEventListener("click", () => setView("upload"));
}

if ($("#seeHowItWorksCta")) {
  $("#seeHowItWorksCta").addEventListener("click", () => {
    const target = document.querySelector(".explain");
    if (target && typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
}

$("#generatePromptBtn").addEventListener("click", () => {
  generateEvidencePrompt();
});

$("#copyPromptBtn").addEventListener("click", async () => {
  if (!promptGeneratedPayload || $("#copyPromptBtn").disabled) {
    $("#copyPromptStatus").textContent = "Generate the prompt first.";
    return;
  }
  const prompt = promptGeneratedPayload.prompt;
  try {
    await navigator.clipboard.writeText(prompt);
    $("#copyPromptStatus").textContent = "Prompt copied.";
  } catch (error) {
    $("#evidencePrompt").select();
    document.execCommand("copy");
    $("#copyPromptStatus").textContent = "Prompt selected and copied.";
  }
});

$("#downloadPromptBtn").addEventListener("click", () => {
  downloadPromptAsText();
});

$("#toggleInstructionsBtn").addEventListener("click", () => {
  togglePromptInstructions();
});

$("#importJsonBtn").addEventListener("click", () => {
  importPromptJsonFlow();
});

$("#profileNameInput").addEventListener("input", () => {
  if (promptGenerationAttempted) renderPromptValidationErrors([]);
  updateExportPrompt();
});
$("#analysisPeriodSelect").addEventListener("change", () => {
  updateExportPrompt();
});
if ($("#aiSourceSelect")) {
  $("#aiSourceSelect").addEventListener("change", () => {
    updateExportPrompt();
  });
}
if ($("#exportModeSelect")) {
  $("#exportModeSelect").addEventListener("change", () => {
    updateExportPrompt();
  });
}
$("#selectProfessional").addEventListener("click", () => {
  $$(".conversation").forEach(card => {
    const classification = card.dataset.classification;
    const include = classification === "professional";
    card.querySelector(".include").checked = include;
    const conversation = state.conversations.find(item => String(item.id) === String(card.dataset.id));
    setConversationIncluded(conversation, include);
  });
  persistState();
  renderReview();
  if (state.reports) renderReports();
});

$("#excludeSensitive").addEventListener("click", () => {
  $$(".conversation").forEach(card => {
    const danger = card.querySelector(".pill.danger");
    if (danger) {
      card.querySelector(".include").checked = false;
      const conversation = state.conversations.find(item => String(item.id) === String(card.dataset.id));
      setConversationIncluded(conversation, false);
    }
  });
  persistState();
  renderReview();
  if (state.reports) renderReports();
});

$("#analyzeBtn").addEventListener("click", async () => {
  const config = buildCurrentReportConfig();
  applyReportConfig(config);
  const response = await fetch("/api/analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: state.sessionId, decisions: collectDecisions(), reportConfig: config })
  });
  const payload = await readJsonResponse(response, "Analysis failed");
  if (!response.ok) {
    alert(payload.error || "Analysis failed");
    return;
  }
  state.reports = payload;
  persistState();
  renderReports();
  setView("report");
});

$("#downloadSnapshotPdf").addEventListener("click", () => {
  const config = buildCurrentReportConfig();
  applyReportConfig(config);
  const snapshot = buildSnapshotData();
  exportPdf("/api/export/snapshot-pdf", snapshot, config, `evilayer-snapshot-${config.sanitized_profile_name || sanitizedFilenameName(config.profile_name)}-${config.generated_at}.pdf`)
    .catch(error => alert(error.message));
});

if ($("#downloadAppendixPdf")) {
  $("#downloadAppendixPdf").addEventListener("click", () => {
    const config = buildCurrentReportConfig();
    applyReportConfig(config);
    const snapshot = buildSnapshotData();
    exportPdf("/api/export/appendix-pdf", snapshot, config, `evilayer-evidence-appendix-${config.sanitized_profile_name || sanitizedFilenameName(config.profile_name)}-${config.generated_at}.pdf`)
      .catch(error => alert(error.message));
  });
}

if ($("#downloadCombinedPdf")) {
  $("#downloadCombinedPdf").addEventListener("click", () => {
    const config = buildCurrentReportConfig();
    applyReportConfig(config);
    const snapshot = buildSnapshotData();
    exportPdf("/api/export/combined-pdf", snapshot, config, `evilayer-evidence-report-${config.sanitized_profile_name || sanitizedFilenameName(config.profile_name)}-${config.generated_at}.pdf`)
      .catch(error => alert(error.message));
  });
}

$("#regenerateReport").addEventListener("click", async () => {
  if (!state.sessionId || !state.reports) return;
  const config = buildCurrentReportConfig();
  applyReportConfig(config);
  const response = await fetch("/api/report", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: state.sessionId, insights: collectInsights(), reportConfig: config })
  });
  const payload = await readJsonResponse(response, "Report regeneration failed");
  if (!response.ok) {
    alert(payload.error || "Report regeneration failed");
    return;
  }
  state.reports = payload;
  persistState();
  renderReports();
});

$("#changePeriod").addEventListener("click", () => {
  setView("review");
});

if ($("#downloadPrivate")) {
  $("#downloadPrivate").addEventListener("click", async () => {
    const insights = collectInsights();
    const response = await fetch("/api/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: state.sessionId, insights })
    });
    state.reports = await readJsonResponse(response, "Private report export failed");
    downloadJson("private-professional-mirror.json", state.reports.private_report);
  });
}

if ($("#downloadPublic")) {
  $("#downloadPublic").addEventListener("click", async () => {
    const insights = collectInsights();
    const response = await fetch("/api/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: state.sessionId, insights })
    });
    state.reports = await readJsonResponse(response, "Public report export failed");
    downloadJson("professional-evidence-passport.json", state.reports.public_report);
  });
}

if ($("#privateMode")) {
  $("#privateMode").addEventListener("click", () => {
    state.reportMode = "private";
    renderReports();
  });
}

if ($("#publicMode")) {
  $("#publicMode").addEventListener("click", () => {
    state.reportMode = "public";
    renderReports();
  });
}

$("#deleteBtn").addEventListener("click", async () => {
  if (!state.sessionId) return;
  await fetch("/api/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: state.sessionId })
  });
  state = { sessionId: null, conversations: [], summary: null, reports: null, reportMode: "private", reportConfig: state.reportConfig };
  sessionStorage.removeItem("professionalEvidenceProfileState");
  $("#deleteBtn").disabled = true;
  $("#conversationList").innerHTML = "";
  $("#summaryGrid").innerHTML = "";
  $("#kpiGrid").innerHTML = "";
  $("#insights").innerHTML = "";
  $("#snapshotPreviewHost").innerHTML = "";
  $("#downloadSnapshotPdf").disabled = true;
  if ($("#downloadAppendixPdf")) $("#downloadAppendixPdf").disabled = true;
  if ($("#downloadCombinedPdf")) $("#downloadCombinedPdf").disabled = true;
  $("#regenerateReport").disabled = true;
  $("#uploadStatus").textContent = "Session deleted.";
  promptGeneratedPayload = null;
  promptGenerationAttempted = false;
  updateExportPrompt();
  setView("upload");
});

restoreState();

$$(".step").forEach(step => step.addEventListener("click", () => setView(step.dataset.step)));
