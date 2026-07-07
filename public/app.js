let state = {
  sessionId: null,
  conversations: [],
  summary: null,
  reports: null,
  reportMode: "private",
  reportConfig: null
};

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
  if (state.reportConfig &&
      sanitizeProfileName(state.reportConfig.profile_name) === profileName &&
      Number(state.reportConfig.selected_months) === selectedMonths &&
      state.reportConfig.period_from &&
      state.reportConfig.period_to &&
      state.reportConfig.generated_at) {
    return {
      ...state.reportConfig,
      valid: Boolean(profileName) && selectedMonths >= 1 && selectedMonths <= 12,
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
    period_from: periodFrom,
    period_to: periodTo,
    generated_at: generatedAt,
    valid,
    sanitized_profile_name: sanitizedFilenameName(profileName)
  };
}

function applyReportConfig(config) {
  if (!config) return;
  state.reportConfig = {
    profile_name: sanitizeProfileName(config.profile_name),
    selected_months: Math.max(1, Math.min(12, Number(config.selected_months || 6))),
    period_from: config.period_from,
    period_to: config.period_to,
    generated_at: config.generated_at || todayIso(),
    sanitized_profile_name: sanitizedFilenameName(config.profile_name)
  };
}

function updateExportPrompt() {
  const config = buildCurrentReportConfig();
  applyReportConfig(config.valid ? config : { ...config, profile_name: config.profile_name });
  const prompt = $("#evidencePrompt");
  const copyButton = $("#copyPromptBtn");
  const summary = $("#exportConfigSummary");
  if (!prompt || !copyButton || !summary) return;
  copyButton.disabled = !config.valid;
  if (!config.valid) {
    prompt.value = "Inserisci un nome profilo per generare il prompt.";
    summary.innerHTML = `
      <strong>Export configuration required</strong>
      <span>Profile name is required. Analysis period must be between 1 and 12 months.</span>
    `;
    persistState();
    return;
  }
  summary.innerHTML = `
    <strong>Profile: Professional Evidence Profile - ${escapeHtml(config.profile_name)}</strong>
    <span>Data analyzed: ${escapeHtml(config.period_from)} - ${escapeHtml(config.period_to)}</span>
    <span>Observation window: ${config.selected_months} months</span>
  `;
  prompt.value = buildEvidencePrompt(config);
  persistState();
}

function buildEvidencePrompt(config) {
  const generatedFor = `Professional Evidence Profile - ${config.profile_name}`;
  return `Generate a Professional Evidence Pack for:

${generatedFor}

Analysis period:

From ${config.period_from} to ${config.period_to}
Selected window: ${config.selected_months} months

Objective:
Create a valid importable JSON file containing ONLY professional conversations or professional excerpts within the selected period.

Trusted values calculated by the application:
- profile_name: ${config.profile_name}
- generated_at: ${config.generated_at}
- period.from: ${config.period_from}
- period.to: ${config.period_to}
- selected_months: ${config.selected_months}

Do not independently choose or modify profile name, generated_at, period.from, period.to or selected month window.

Mandatory JSON header:
{
  "schema": "professional_evidence_pack_v1",
  "generated_for": "${generatedFor}",
  "generated_at": "${config.generated_at}",
  "period": {
    "from": "${config.period_from}",
    "to": "${config.period_to}"
  },
  "source": {
    "type": "chatgpt_user_generated_summary",
    "verification": "user_provided_not_verified",
    "limitations": [
      "Generated by ChatGPT from available or pasted context",
      "Not equivalent to the original ChatGPT export",
      "User should review before analysis"
    ]
  }
}

Rules:
- consider exclusively content between ${config.period_from} and ${config.period_to}, corresponding to the last ${config.selected_months} months selected by the user;
- do not calculate or alter the date range;
- include only content related to work, capabilities, problem solving, decisions, professional communication, leadership, product, technology, data, APIs, architecture, execution, collaboration or the user's specific professional domain;
- exclude private life, family, health, mental health, sex, religion, politics, personal finance, minors' data, personal legal matters and sensitive third-party information;
- anonymize names, emails, phones, confidential companies, tokens, passwords, credentials, addresses and identifying details;
- do not invent evidence;
- if unsure, mark the item as uncertain;
- distinguish original user text, pasted third-party text, code, job descriptions, email or AI output;
- do not attribute skills to the user based only on text copied from others;
- flag counter-evidence and explicit limitations, such as reliance on specialists or low technical confidence;
- separate observable professional concepts from specialization, role, actor, context, metadata or frequency;
- use a canonical dimension only among: decision_making, problem_solving, communication, execution, leadership, collaboration, planning, learning, domain_knowledge, data_reasoning, risk_awareness, quality_improvement;
- add a domain-aware display_label only when the candidate is capability, behavior or responsibility;
- do not produce psychological diagnoses, rankings, hiring scores or absolute judgments about the person.

Return ONLY valid JSON, with no Markdown and no text outside JSON.

Required schema:
{
  "schema": "professional_evidence_pack_v1",
  "generated_for": "${generatedFor}",
  "generated_at": "${config.generated_at}",
  "period": {
    "from": "${config.period_from}",
    "to": "${config.period_to}"
  },
  "source": {
    "type": "chatgpt_user_generated_summary",
    "verification": "user_provided_not_verified",
    "limitations": []
  },
  "conversations": [
    {
      "id": "pack_conv_001",
      "title": "Short professional title",
      "date": "YYYY-MM-DD",
      "professional_category": "strategy|project_management|product_management|technology|programming|data_analytics|professional_communication|leadership|recruiting|negotiation|execution|learning|other",
      "classification": "professional|mixed|uncertain",
      "summary": "Brief neutral summary",
      "content_origin_notes": "original_user_input|pasted_email|pasted_job_description|pasted_external_document|pasted_code|ai_generated_text|mixed_content|unknown",
      "evidence": [
        {
          "dimension": "decision_making|problem_solving|communication|execution|leadership|collaboration|planning|learning|domain_knowledge|data_reasoning|risk_awareness|quality_improvement",
          "candidate_concept": "Observed professional concept extracted from the user's claim or excerpt",
          "candidate_type": "capability|behavior|responsibility|role|domain|specialization|activity|context|actor|provenance|frequency|metadata|unknown",
          "display_label": "Domain-aware label only if candidate_type is capability, behavior or responsibility",
          "claim": "Contextual, evidence-based observation",
          "supporting_excerpt": "Short anonymized excerpt or paraphrase",
          "counter_evidence": "Short counter-evidence or null",
          "time_period": "YYYY-MM-DD",
          "confidence": "low|medium|high"
        }
      ]
    }
  ]
}`;
}

function renderSummary() {
  const summary = state.summary;
  if (!summary) return;
  $("#summaryGrid").innerHTML = [
    metric("Conversazioni", summary.total_conversations),
    metric("Messaggi", summary.total_messages),
    metric("Professionali", summary.counts.professional || 0),
    metric("Miste", summary.counts.mixed || 0),
    metric("Personali", summary.counts.personal || 0),
    metric("Incerte", summary.counts.uncertain || 0),
    metric("Dal", summary.period.first || "-"),
    metric("Al", summary.period.last || "-")
  ].join("");
}

function classificationPill(classification) {
  const cls = ["personal", "excluded_sensitive"].includes(classification) ? "danger" :
    classification === "mixed" || classification === "uncertain" ? "warn" : "";
  return `<span class="pill ${cls}">${classification}</span>`;
}

function renderReview() {
  const clusters = buildConversationClusters(state.conversations);
  const included = state.conversations.filter(conversation => conversation.approved).length;
  const professional = state.conversations.filter(conversation => ["professional", "mixed"].includes(conversation.classification)).length;
  const excluded = state.conversations.length - included;
  const categories = Array.from(new Set(state.conversations
    .filter(conversation => conversation.approved)
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
    <details class="advanced-review">
      <summary>Review selected conversations</summary>
      <div class="conversation-detail compact-review-list">
        ${state.conversations.map(conversation => renderConversationCard(conversation)).join("")}
      </div>
    </details>
  `;
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
    current.approved_count += conversation.approved ? 1 : 0;
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
        <h4>${cluster.count} conversazioni</h4>
        <p>${cluster.first} - ${cluster.last} · conf. media ${cluster.avg_confidence.toFixed(2)} · ${cluster.approved_count} incluse</p>
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
    const includeChecked = conversation.approved ? "checked" : "";
    const firstUser = conversation.messages.find(message => message.author === "user");
    const excerpt = firstUser ? firstUser.text.slice(0, 120) : "Nessun messaggio utente trovato.";
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
          <select class="classification">
            ${["professional", "personal", "mixed", "uncertain", "excluded_sensitive"].map(item =>
              `<option value="${item}" ${item === conversation.classification ? "selected" : ""}>${item}</option>`
            ).join("")}
          </select>
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
    }
  });
}

function renderReports() {
  if (!state.reports) return;
  renderSnapshotPreview();
  $("#downloadSnapshotPdf").disabled = false;
  $("#regenerateReport").disabled = false;
}

function renderEmptySnapshot() {
  const hasConversations = state.conversations && state.conversations.length;
  const title = hasConversations ? "Report non ancora generato" : "Nessun dataset caricato";
  const message = hasConversations
    ? "Vai in Review e premi Generate profile. Dopo l'analisi comparira' qui la pagina PDF."
    : "Carica prima un export o un Professional Evidence Pack, poi conferma le conversazioni in Review.";
  $("#snapshotPreviewHost").innerHTML = `
    <article class="snapshot-empty-state">
      <h4>${escapeHtml(title)}</h4>
      <p>${escapeHtml(message)}</p>
      <button type="button" id="emptySnapshotAction">${hasConversations ? "Go to Review" : "Go to Upload"}</button>
    </article>
  `;
  $("#downloadSnapshotPdf").disabled = true;
  $("#regenerateReport").disabled = true;
  const action = $("#emptySnapshotAction");
  if (action) action.addEventListener("click", () => setView(hasConversations ? "review" : "upload"));
}

function renderSnapshotPreview() {
  const snapshot = buildSnapshotData();
  $("#snapshotPreviewHost").innerHTML = `
    <div class="snapshot-zoom-row" aria-label="Preview zoom">
      <span>Preview</span>
      <input id="snapshotZoom" type="range" min="70" max="125" value="100" aria-label="Zoom preview">
      <strong id="snapshotZoomValue">100%</strong>
    </div>
    <div class="snapshot-page-shell" style="--snapshot-zoom: 1">
      <article id="snapshotPage" class="snapshot-page">
        <header class="snapshot-header">
          <div>
            <p>Professional Evidence Snapshot</p>
            <h1>${escapeHtml(snapshot.personName)}</h1>
          </div>
          <dl>
            <div><dt>Extracted</dt><dd>${escapeHtml(snapshot.extractedDate)}</dd></div>
            <div><dt>Data analyzed</dt><dd>${escapeHtml(snapshot.dataRange)}</dd></div>
            <div><dt>Observation period</dt><dd>${escapeHtml(snapshot.observationPeriod)}</dd></div>
          </dl>
        </header>
        <section class="snapshot-summary">
          <article class="snapshot-card executive-card">
            <p class="snapshot-eyebrow">Executive summary</p>
            <p>${escapeHtml(snapshot.summary)}</p>
          </article>
          <div class="snapshot-kpis">
            ${snapshot.kpis.map(kpi => `
              <article class="snapshot-kpi">
                <strong>${escapeHtml(kpi.value)}</strong>
                <span>${escapeHtml(kpi.label)}</span>
                <p>${escapeHtml(kpi.note)}</p>
              </article>
            `).join("")}
          </div>
          <article class="snapshot-note">
            <p class="snapshot-eyebrow">How to read this</p>
            <p>Coverage measures available evidence, not personal ability. Missing evidence is shown as not assessed, never as a low score.</p>
          </article>
        </section>
        <section class="snapshot-card profile-card">
          <div class="profile-card-head">
            <div>
              <p class="snapshot-eyebrow">Observed capability profile</p>
              <h2>Evidence status and coverage</h2>
            </div>
            <span>${snapshot.axes.length} areas</span>
          </div>
          <div class="capability-bars">
            ${snapshot.axes.length ? snapshot.axes.map(axis => renderSnapshotAxis(axis)).join("") : `
              <div class="snapshot-empty">No capability area has enough attributable evidence for this snapshot.</div>
            `}
          </div>
          <div class="interpretation-box">
            <p class="snapshot-eyebrow">Key interpretation</p>
            <p>${escapeHtml(snapshot.interpretation)}</p>
          </div>
        </section>
        <footer class="snapshot-footer">
          <span>Private AI-assisted report - user-provided data, not independently verified</span>
          <span>Six-month evidence snapshot, not a permanent profile or hiring score</span>
        </footer>
      </article>
    </div>
  `;
  bindSnapshotZoom();
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

function buildSnapshotData() {
  const reports = state.reports || {};
  const kpis = reports.kpis || {};
  const coverage = reports.evidence_coverage_detail || {};
  const temporal = reports.temporal_maturity || {};
  const config = reports.report_config || state.reportConfig || buildCurrentReportConfig();
  const axes = buildRadarAxesFromTemporal(temporal)
    .filter(axis => axis.assessed && axis.radar_eligible && !isMetadataLikeLabel(axis.label))
    .slice(0, 8);
  const allDimensions = (temporal.dimensions || []).filter(dimension => !isMetadataLikeLabel(dimension.label));
  const notAssessed = allDimensions
    .filter(dimension => isNotAssessedStatus(dimension.status) || dimension.capability_score == null)
    .slice(0, 3)
    .map(dimension => dimension.label);
  const evidenceItems = Number(coverage.total_evidence_items || 0);
  const professionalConversations = Number(coverage.total_professional_conversations || kpis.evidence_coverage || 0);
  const attributablePercentage = computeAttributablePercentage(coverage, evidenceItems);
  return {
    personName: config.profile_name || "Professional profile",
    extractedDate: formatSnapshotDate(config.generated_at || kpis.generated_at || new Date().toISOString()),
    dataRange: formatDataRange(config.period_from || kpis.first_data, config.period_to || kpis.last_data),
    observationPeriod: `${config.selected_months || 6} month${Number(config.selected_months || 6) === 1 ? "" : "s"}`,
    axes,
    summary: buildSnapshotSummary(axes, notAssessed),
    kpis: [
      { value: String(professionalConversations || "-"), label: "Professional conversations analyzed", note: "Retained for this snapshot" },
      { value: String(evidenceItems || "-"), label: "Evidence items", note: "Supporting, counter and uncertain" },
      { value: String(axes.length), label: "Supported capability areas", note: "Enough attributable evidence" },
      { value: `${attributablePercentage}%`, label: "Attributable evidence percentage", note: "Clearly linked to user contribution" }
    ],
    interpretation: buildSnapshotInterpretation(axes, notAssessed)
  };
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

function buildSnapshotSummary(axes, notAssessed) {
  if (!axes.length) {
    return "The analyzed professional conversations do not contain enough attributable evidence to support a visual capability profile for the selected period.";
  }
  const top = axes.slice(0, 3).map(axis => axis.label);
  const limitation = notAssessed.length ? "Dimensions without enough evidence remain not assessed." : "No unsupported areas are scored as low ability.";
  return limitWords(`The analyzed professional conversations show recurring evidence around ${joinHuman(top)}. The strongest observable pattern is ${axes[0].label}. ${limitation}`, 70);
}

function buildSnapshotInterpretation(axes, notAssessed) {
  if (!axes.length) {
    return "The most important limitation is evidence availability: the available conversations are not sufficient to assess professional capability areas.";
  }
  const limitation = notAssessed.length
    ? `${joinHuman(notAssessed)} ${notAssessed.length === 1 ? "is" : "are"} not assessed because evidence is insufficient.`
    : "No missing-evidence dimension is converted into a low score.";
  return `The strongest recurring pattern is ${axes[0].label}. The most important limitation is source coverage: ${limitation}`;
}

function formatSnapshotDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "-");
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" }).format(date);
}

function formatDataRange(first, last) {
  if (!first && !last) return "-";
  if (first && last) return `${formatSnapshotDate(first)} - ${formatSnapshotDate(last)}`;
  return formatSnapshotDate(first || last);
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
    sessionStorage.setItem("professionalEvidenceProfileState", JSON.stringify(state));
  } catch (error) {
    console.warn("Unable to persist local session", error);
  }
}

function restoreState() {
  try {
    const raw = sessionStorage.getItem("professionalEvidenceProfileState");
    if (!raw) {
      updateExportPrompt();
      renderEmptySnapshot();
      return;
    }
    const restored = JSON.parse(raw);
    state = {
      sessionId: restored.sessionId || null,
      conversations: restored.conversations || [],
      summary: restored.summary || null,
      reports: restored.reports || null,
      reportMode: restored.reportMode || "private",
      reportConfig: restored.reportConfig || null
    };
    if (state.reportConfig) {
      if ($("#profileNameInput")) $("#profileNameInput").value = state.reportConfig.profile_name || "";
      if ($("#analysisPeriodSelect")) $("#analysisPeriodSelect").value = String(state.reportConfig.selected_months || 6);
    }
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
  const modeLabel = state.reportMode === "public" ? "Public Passport" : "Private Mirror";
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

function displayStatus(status) {
  if (isNotAssessedStatus(status)) return "not assessed";
  return String(status || "not assessed").replace(/_/g, " ");
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

function renderRadar(axes) {
  if (!axes.length) return `<div class="empty-visual">Nessun insight visibile per questa vista.</div>`;
  const assessedAxes = axes.filter(axis => axis.assessed && typeof axis.strength === "number");
  const notAssessedAxes = axes.filter(axis => !axis.assessed || typeof axis.strength !== "number");
  if (!assessedAxes.length) {
    return `
      <div class="radar-wrap">
        <div class="empty-visual">Nessuna dimensione valutabile: le evidenze disponibili non bastano per stimare una forza osservata.</div>
        ${renderNotAssessedAxes(notAssessedAxes)}
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
  const legend = assessedAxes.map(axis => `
    <li><span>${escapeHtml(axis.label)}</span><strong>${escapeHtml(axis.level)} · coverage ${axis.coverage || 0}/100</strong></li>
  `).join("");
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
        ${renderNotAssessedAxes(notAssessedAxes)}
      </div>
    </div>
  `;
}

function renderNotAssessedAxes(axes) {
  if (!axes.length) return "";
  return `
    <div class="not-assessed-list">
      <strong>Not assessed</strong>
      ${axes.map(axis => `
        <p>
          <span>${escapeHtml(axis.label)}</span>
          <em>coverage ${axis.coverage || 0}/100 - positive ${axis.positive_count || 0} - counter ${axis.negative_count || 0} - uncertain ${axis.uncertain_count || 0}</em>
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
    return `<div class="empty-visual">Servono evidenze con data per costruire la timeline.</div>`;
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
      ${temporalMaturity.dimension_strategy ? `<p class="timeline-scope">Il radar usa dimensioni professionali standard e mostra solo quelle con almeno due evidenze da due conversazioni diverse. Quando il file contiene concetti professionali piu' specifici, li usa come etichette contestuali.</p>` : ""}
      <div class="evidence-key compact">
        <span><strong>Positive</strong> supports the dimension.</span>
        <span><strong>Counter</strong> explicit limitation or dependency.</span>
        <span><strong>Uncertain</strong> weak or non-attributable source.</span>
      </div>
      <table class="maturity-table">
        <thead><tr><th>Dimensione</th>${header}</tr></thead>
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
    specialization: "specializzazione o contesto",
    metadata: "metadato",
    role: "ruolo",
    domain: "dominio",
    actor: "attore",
    frequency: "frequenza",
    provenance: "provenienza",
    unknown: "non classificato"
  };
  return labels[type] || String(type || "elemento");
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
          <div class="dimension-origin">${dimension.derivation === "semantic_capability_extraction" ? "Etichetta contestuale estratta" : "Dimensione professionale standard"}</div>
          ${dimension.canonical_dimension ? `<div class="source-line user-facing-source">Area standard: ${escapeHtml(dimension.canonical_dimension)} - Evidenza: ${escapeHtml(dimension.semantic_type || "capability")}</div>` : ""}
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
        <em>${signal.evidence_count} evidenze</em>
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
          <h4>Ragionamento tecnico osservabile</h4>
        </div>
        <span class="pill">${observed.length} segnali osservati</span>
      </div>
      <p class="tech-scope">Basato solo su conversazioni approvate e anonimizzate. Non accede a repository, non copia codice proprietario e non certifica seniority.</p>
      <div class="tech-grid">${signalCards}</div>
      ${evidencePreview ? `<ul class="tech-evidence">${evidencePreview}</ul>` : `<div class="empty-visual small">Nessuna evidenza tecnica nella vista corrente.</div>`}
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
    classification: card.querySelector(".classification").value
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
  if (!config.valid) throw new Error("Inserisci un nome profilo valido e scegli un periodo tra 1 e 12 mesi.");
  applyReportConfig(config);
  const form = new FormData();
  form.append("file", file);
  form.append("reportConfig", JSON.stringify(state.reportConfig));
  $("#uploadStatus").textContent = "Parsing e classificazione in corso...";
  const response = await fetch("/api/import", { method: "POST", body: form });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Import failed");
  state.sessionId = payload.sessionId;
  state.conversations = payload.conversations;
  state.summary = payload.summary;
  if (payload.report_config) applyReportConfig(payload.report_config);
  $("#deleteBtn").disabled = false;
  renderSummary();
  renderReview();
  persistState();
  $("#uploadStatus").textContent = "Import completato. Passa a Data scan o Review.";
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
    $("#uploadStatus").textContent = "Seleziona prima un file.";
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

$("#copyPromptBtn").addEventListener("click", async () => {
  updateExportPrompt();
  if ($("#copyPromptBtn").disabled) {
    $("#copyPromptStatus").textContent = "Inserisci prima un nome profilo valido.";
    return;
  }
  const prompt = $("#evidencePrompt").value;
  try {
    await navigator.clipboard.writeText(prompt);
    $("#copyPromptStatus").textContent = "Prompt copiato.";
  } catch (error) {
    $("#evidencePrompt").select();
    document.execCommand("copy");
    $("#copyPromptStatus").textContent = "Prompt selezionato e copiato.";
  }
});

$("#profileNameInput").addEventListener("input", updateExportPrompt);
$("#analysisPeriodSelect").addEventListener("change", updateExportPrompt);

$("#selectProfessional").addEventListener("click", () => {
  $$(".conversation").forEach(card => {
    const classification = card.querySelector(".classification").value;
    card.querySelector(".include").checked = classification === "professional";
  });
});

$("#excludeSensitive").addEventListener("click", () => {
  $$(".conversation").forEach(card => {
    const danger = card.querySelector(".pill.danger");
    if (danger) card.querySelector(".include").checked = false;
  });
});

$("#analyzeBtn").addEventListener("click", async () => {
  const config = state.reportConfig || buildCurrentReportConfig();
  const response = await fetch("/api/analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: state.sessionId, decisions: collectDecisions(), reportConfig: config })
  });
  const payload = await response.json();
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
  const config = state.reportConfig || buildCurrentReportConfig();
  const previousTitle = document.title;
  document.title = `professional-evidence-snapshot-${config.sanitized_profile_name || sanitizedFilenameName(config.profile_name)}-${config.generated_at || todayIso()}`;
  window.print();
  window.setTimeout(() => {
    document.title = previousTitle;
  }, 800);
});

$("#regenerateReport").addEventListener("click", async () => {
  if (!state.sessionId || !state.reports) return;
  const response = await fetch("/api/report", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: state.sessionId, insights: collectInsights(), reportConfig: state.reportConfig || buildCurrentReportConfig() })
  });
  const payload = await response.json();
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
    state.reports = await response.json();
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
    state.reports = await response.json();
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
  $("#regenerateReport").disabled = true;
  $("#uploadStatus").textContent = "Sessione cancellata.";
  setView("upload");
});

restoreState();

$$(".step").forEach(step => step.addEventListener("click", () => setView(step.dataset.step)));
