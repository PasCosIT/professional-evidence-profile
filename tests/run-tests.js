const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { PDFParse } = require("pdf-parse");
const {
  handleRequest,
  normalizeChatGptExport,
  buildNormalized,
  buildReports,
  renderSnapshotPdf,
  renderAppendixPdf,
  scanSummary,
  redactText
} = require("../server.cjs");
const PromptBuilder = require("../public/prompt-builder.js");

const root = path.join(__dirname, "..");
const serverPath = path.join(root, "server.cjs");
const samplePath = path.join(root, "public", "samples", "synthetic-conversations.json");
const evidencePackPath = path.join(root, "public", "samples", "sample-evidence-pack.json");

function runRequest({ method, url, headers, body }) {
  return new Promise((resolve, reject) => {
    const listeners = { data: [], end: [], error: [] };
    const req = {
      method,
      url,
      headers: headers || {},
      on(event, handler) {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(handler);
      }
    };
    const responseChunks = [];
    const res = {
      headersSent: false,
      statusCode: null,
      headers: null,
      writeHead(status, responseHeaders) {
        this.statusCode = status;
        this.headers = responseHeaders;
        this.headersSent = true;
      },
      end(chunk) {
        if (chunk) responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        resolve({
          statusCode: this.statusCode,
          headers: this.headers || {},
          body: Buffer.concat(responseChunks).toString("utf8")
        });
      }
    };

    try {
      handleRequest(req, res);
      const payload = body ? (Buffer.isBuffer(body) ? body : Buffer.from(String(body))) : null;
      if (payload) {
        listeners.data.forEach(handler => handler(payload));
      }
      listeners.end.forEach(handler => handler());
    } catch (error) {
      reject(error);
    }
  });
}

function pdfText(buffer) {
  return buffer.toString("latin1").replace(/\0/g, "");
}

function pdfPageCount(buffer) {
  return (pdfText(buffer).match(/\/Type \/Page\b/g) || []).length;
}

async function parsedPdf(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    return await parser.getText();
  } finally {
    if (typeof parser.destroy === "function") await parser.destroy();
  }
}

async function main() {
  assert.ok(fs.existsSync(serverPath), "server.js exists");
  assert.ok(fs.existsSync(samplePath), "synthetic sample exists");
  assert.ok(fs.existsSync(evidencePackPath), "evidence pack sample exists");

  const sample = JSON.parse(fs.readFileSync(samplePath, "utf8"));
  assert.ok(Array.isArray(sample), "sample is an array");
  assert.ok(sample.length >= 5, "sample has conversations");

  const quickInput = {
    profile_name: "Mario Rossi",
    selected_months: 6,
    source_platform: "chatgpt",
    export_mode: "quick",
    now: "2026-07-13T09:00:00.000Z"
  };
  const claudeQuickInput = { ...quickInput, source_platform: "claude" };
  const claudeCompleteInput = { ...quickInput, source_platform: "claude", export_mode: "complete" };

  const chatGptQuick = PromptBuilder.buildEvidencePrompt(quickInput, "en");
  const claudeQuick = PromptBuilder.buildEvidencePrompt(claudeQuickInput, "en");
  const claudeComplete = PromptBuilder.buildEvidencePrompt(claudeCompleteInput, "en");

  assert.ok(chatGptQuick.prompt.includes("Create and attach a downloadable JSON file when file creation is supported. Otherwise return only the valid JSON content."), "chatgpt quick includes downloadable file instruction");
  assert.ok(chatGptQuick.prompt.includes("Maximum 40 strongest professional evidence items."), "quick mode enforces 40 evidence cap");
  assert.ok(chatGptQuick.prompt.includes("\"platform\": \"chatgpt\""), "chatgpt quick includes source platform");
  assert.ok(chatGptQuick.prompt.includes("\"export_mode\": \"quick\""), "chatgpt quick includes export mode");

  assert.ok(claudeQuick.prompt.includes("Claude procedural instructions:"), "claude quick includes procedural section");
  assert.ok(claudeQuick.prompt.includes("maximum 40 evidence items"), "claude quick includes explicit 40 limit");
  assert.ok(claudeComplete.prompt.includes("Complete mode:"), "claude complete includes complete mode section");
  assert.ok(claudeComplete.prompt.includes("Up to 100 professional evidence items"), "claude complete allows up to 100 evidence items");
  assert.notStrictEqual(chatGptQuick.prompt, claudeQuick.prompt, "chatgpt and claude prompts are effectively different");
  assert.ok(claudeQuick.prompt.length < chatGptQuick.prompt.length, "claude prompt is shorter than chatgpt prompt");

  const trusted = PromptBuilder.buildTrustedConfig(quickInput);
  assert.strictEqual(trusted.generated_at, "2026-07-13", "trusted generated_at date is correct");
  assert.strictEqual(trusted.period_from, "2026-01-13", "trusted period from subtracts months correctly");
  assert.strictEqual(trusted.period_to, "2026-07-13", "trusted period to matches generated_at");

  const validationAllMissing = PromptBuilder.validateEvidencePromptConfig({ profile_name: "", source_platform: "", selected_months: 13 });
  assert.ok(validationAllMissing.includes("Profile name is required."), "validation requires profile name");
  assert.ok(validationAllMissing.includes("Select the AI source."), "validation requires ai source");
  assert.ok(validationAllMissing.includes("Analysis period must be between 1 and 12 months."), "validation validates month range");

  const escapedProfilePrompt = PromptBuilder.buildEvidencePrompt({
    profile_name: 'Mario "M" Rossi',
    selected_months: 6,
    source_platform: "chatgpt",
    export_mode: "quick",
    now: "2026-07-13T09:00:00.000Z"
  }, "en").prompt;
  assert.ok(escapedProfilePrompt.includes('AI Work Passport - Mario \\"M\\" Rossi'), "profile name is escaped correctly inside JSON context");

  const promptFilename = PromptBuilder.getPromptDownloadFilename({
    profile_name: "Mario Rossi",
    selected_months: 6,
    source_platform: "claude",
    export_mode: "quick",
    now: "2026-07-13T09:00:00.000Z"
  });
  assert.ok(promptFilename.endsWith(".txt"), "prompt download filename is .txt");
  assert.ok(promptFilename.includes("claude-quick"), "prompt download filename includes source and mode");

  const conversations = normalizeChatGptExport(sample);
  const summary = scanSummary(conversations);
  assert.ok(summary.total_conversations >= 5, "summary returned");
  assert.ok(conversations.some(c => c.classification === "professional"), "professional detected");
  assert.ok(conversations.some(c => ["personal", "excluded_sensitive"].includes(c.classification)), "personal or sensitive detected");

  const decisions = conversations.map(c => ({
    id: c.id,
    include: c.classification === "professional",
    classification: c.classification
  }));
  const normalized = buildNormalized(conversations, decisions);
  const report = buildReports(normalized);
  assert.ok(report.private_report, "private report returned");
  assert.ok(report.public_report, "public report returned");
  assert.ok(report.skill_passport, "skill passport returned");
  assert.ok(report.skill_passport.groups.some(group => group.id === "technical_skills"), "technical skills group returned");
  assert.ok(report.skill_passport.groups.some(group => group.id === "business_skills"), "business skills group returned");
  assert.ok(report.skill_passport.groups.some(group => group.id === "execution_capabilities"), "execution group returned");
  assert.ok(report.skill_passport.groups.some(group => group.id === "leadership_collaboration"), "leadership group returned");
  assert.ok(report.skill_passport.groups.every(group => group.skills.every(skill => Number.isInteger(skill.confidence_score))), "skill confidence scores are integers");
  assert.ok(report.skill_passport.groups.every(group => group.skills.every(skill => skill.examples.length >= 1)), "skills include concrete examples");
  assert.ok(report.normalized.every(c => c.classification === "professional"), "only professional selected");
  assert.ok(JSON.stringify(report).includes("[EMAIL_REDACTED]"), "email redacted");
  assert.ok(redactText("Mario Rossi usa mario.rossi@example.com").text.includes("[EMAIL_REDACTED]"), "direct redaction works");

  const healthResponse = await runRequest({ method: "GET", url: "/api/health" });
  assert.strictEqual(healthResponse.statusCode, 200, "health route returns 200");
  const healthPayload = JSON.parse(healthResponse.body);
  assert.strictEqual(healthPayload.ok, true, "health route reports ok");
  assert.ok(["local", "vercel"].includes(healthPayload.runtime), "health route reports runtime");
  assert.ok(healthPayload.timestamp, "health route reports timestamp");

  const pdfSnapshot = {
    personName: "Pas Test",
    extractedDate: "7 July 2026",
    dataRange: "1 January 2026 - 7 July 2026",
    observationPeriod: "6 months",
    professionalSignature: "Cross-functional professional operating across program management and technology integrations, with recurring patterns in collaboration, communication and data reasoning.",
    observedDomains: ["program management", "technology integrations", "data and reporting"],
    typicalContribution: "Typically turns priorities into coordinated actions, clearer requirements and shared delivery across program management and technology integrations.",
    texts: {
      snapshotTitle: "Professional Evidence Snapshot",
      signatureLabel: "Professional signature",
      domainsLabel: "Professional domains observed",
      contributionLabel: "Typical professional contribution",
      capabilityTitle: "Observed capabilities",
      capabilitySubtitle: "Coverage reflects evidence availability, recurrence and attribution. It is not a skill score.",
      radarQuestion: "How does this person work?",
      domainPanelTitle: "Evidence by professional domain",
      provenancePanelTitle: "Attribution summary",
      attributableLabel: "directly attributable",
      snapshotFooterA: "Coverage means evidence availability, not a skill score.",
      snapshotFooterB: "Profile built from approved conversations and not independently verified.",
      notAssessed: "Not assessed — insufficient evidence",
      confidence: { high: "High", medium: "Medium", low: "Low" },
      analyzedConversations: "Professional conversations analyzed",
      evidenceItems: "Evidence items",
      selectedConversations: "selected conversations",
      outOfAnalyzed: "out of",
      analyzedLabel: "analyzed",
      selectedExcerpts: "selected excerpts",
      outOfEvidence: "out of",
      evidenceLabel: "evidence items",
      appendixTitle: "Detailed Evidence Appendix"
    },
    kpis: [
      { value: "10", label: "Professional conversations analyzed", note: "Retained for this snapshot" },
      { value: "28", label: "Evidence items", note: "Supporting, counter and uncertain" },
      { value: "5", label: "Capabilities assessed", note: "Minimum evidence threshold reached" },
      { value: "70%", label: "Weighted attribution", note: "Direct plus partial attribution from mixed-source evidence" }
    ],
    axes: [
      { label: "Collaboration", level: "recurring", strength: 84, coverage: 78, confidence: "high", assessed: true },
      { label: "Data reasoning", level: "observed", strength: 72, coverage: 68, confidence: "high", assessed: true },
      { label: "Communication", level: "observed", strength: 70, coverage: 64, confidence: "medium", assessed: true },
      { label: "Quality improvement", level: "emerging", strength: 54, coverage: 42, confidence: "high", assessed: true },
      { label: "Leadership", level: "emerging", strength: 48, coverage: 42, confidence: "high", assessed: true }
    ],
    categoryBreakdown: [{ label: "program management", count: 4 }, { label: "technology integrations", count: 3 }],
    evidenceMix: { attributable: 70, segments: [{ tone: "direct", value: 50 }, { tone: "mixed", value: 20 }, { tone: "external", value: 20 }, { tone: "ai", value: 10 }] },
    analyzedConversations: [{ title: "Roadmap", date: "2026-01-10", category: "program management", excerpt: "Defines roadmap and dependencies." }],
    evidenceHighlights: [{ skill: "Collaboration", group: "Collaboration", title: "Roadmap", excerpt: "Coordinates stakeholders across delivery.", confidence: "High" }],
    selectedConversationCount: 1,
    analyzedConversationCount: 10,
    selectedExcerptCount: 1,
    totalEvidenceItemCount: 28
  };
  const pdfConfig = {
    profile_name: "Pas Test",
    selected_months: 6,
    period_from: "2026-01-07",
    period_to: "2026-07-07",
    generated_at: "2026-07-07",
    report_language: "en"
  };
  const snapshotPdf = await renderSnapshotPdf(pdfSnapshot, pdfConfig);
  const appendixPdf = await renderAppendixPdf(pdfSnapshot, pdfConfig);
  assert.ok(snapshotPdf.length > 1000, "snapshot pdf buffer returned");
  assert.ok(appendixPdf.length > 1000, "appendix pdf buffer returned");
  assert.strictEqual(pdfPageCount(snapshotPdf), 1, "snapshot pdf stays on exactly one page");
  const parsedSnapshot = await parsedPdf(snapshotPdf);
  const snapshotText = parsedSnapshot.text;
  const normalizedSnapshotText = snapshotText.replace(/\s+/g, " ").trim();
  assert.strictEqual(parsedSnapshot.total, 1, "snapshot pdf reports exactly one page via parser");
  assert.ok(normalizedSnapshotText.includes("Professional Evidence Snapshot"), "snapshot pdf includes title");
  assert.ok(normalizedSnapshotText.includes("Directly attributable: 50%"), "snapshot pdf includes direct attribution line");
  assert.ok(normalizedSnapshotText.includes("Mixed or partially attributable: 20%"), "snapshot pdf includes mixed attribution line");
  assert.ok(normalizedSnapshotText.includes("External or AI-generated context: 30%"), "snapshot pdf includes external/ai attribution line");
  assert.ok(normalizedSnapshotText.includes("Coverage measures evidence availability, recurrence and attribution. It is not a skill score."), "snapshot pdf keeps methodology note near the chart");
  assert.ok(normalizedSnapshotText.includes("AI-assisted report"), "snapshot pdf includes verification footer");
  assert.ok(!normalizedSnapshotText.includes("Collaboratio n"), "snapshot pdf never splits Collaboration mid-word");
  assert.ok(!normalizedSnapshotText.includes("Communica tion"), "snapshot pdf never splits Communication mid-word");
  assert.ok(!normalizedSnapshotText.includes("impr ovement"), "snapshot pdf never splits Quality improvement mid-word");

  const evidencePack = JSON.parse(fs.readFileSync(evidencePackPath, "utf8"));
  const packConversations = normalizeChatGptExport(evidencePack);
  assert.strictEqual(packConversations.length, 1, "evidence pack imports conversations");
  assert.strictEqual(packConversations[0].source.verification, "user_provided_not_verified", "evidence pack is marked unverified");
  assert.strictEqual(packConversations[0].professional_category, "technology", "evidence pack category preserved");

  const sourceAwarePack = {
    schema: "professional_evidence_pack_v1",
    generated_for: "AI Work Passport - Source Test",
    generated_at: "2026-07-13",
    period: { from: "2026-01-13", to: "2026-07-13" },
    source: {
      verification: "user_provided_not_verified",
      platform: "claude",
      export_mode: "quick"
    },
    conversations: [
      {
        id: "pack_source_1",
        title: "Source platform test",
        date: "2026-06-10",
        professional_category: "technology",
        classification: "professional",
        summary: "Synthetic summary",
        content_origin_notes: "original_user_input",
        evidence: [
          {
            dimension: "execution",
            candidate_concept: "Delivery coordination",
            candidate_type: "capability",
            claim: "Coordinates technical delivery",
            supporting_excerpt: "Coordinates release activities",
            confidence: "medium"
          }
        ]
      }
    ]
  };
  const sourceAwareConversations = normalizeChatGptExport(sourceAwarePack);
  assert.strictEqual(sourceAwareConversations[0].source.platform, "claude", "source.platform is preserved when present");
  assert.strictEqual(sourceAwareConversations[0].source.export_mode, "quick", "source.export_mode is preserved when present");

  const legacyPack = {
    schema: "professional_evidence_pack_v1",
    generated_for: "AI Work Passport - Legacy",
    generated_at: "2026-07-13",
    period: { from: "2026-01-13", to: "2026-07-13" },
    source: {
      verification: "user_provided_not_verified"
    },
    conversations: [
      {
        id: "pack_legacy_1",
        title: "Legacy pack",
        date: "2026-06-11",
        professional_category: "project_management",
        classification: "professional",
        summary: "Legacy summary",
        content_origin_notes: "mixed_content",
        evidence: []
      }
    ]
  };
  const legacyPackConversations = normalizeChatGptExport(legacyPack);
  assert.strictEqual(legacyPackConversations.length, 1, "legacy pack without source platform remains compatible");
  assert.strictEqual(legacyPackConversations[0].source.platform, null, "legacy pack sets source platform to null");

  const temporalSample = normalizeChatGptExport([
    {
      id: "low_2022",
      title: "2022 technical confidence",
      messages: [
        {
          author: "user",
          created_at: "2022-05-10T10:00:00.000Z",
          text: "Ho bassa confidenza tecnica e mi affido allo specialista. Voglio fare buone domande su API e database, ma non posso decidere l'architettura."
        }
      ]
    },
    {
      id: "growth_2023",
      title: "2023 technical governance",
      messages: [
        {
          author: "user",
          created_at: "2023-06-12T10:00:00.000Z",
          text: "Definisco requisiti, acceptance criteria, payload JSON, endpoint API e schema dati. Posso guidare la governance tecnica, scegliere il trade-off architetturale e prendere ownership della decisione."
        }
      ]
    }
  ]);
  const temporalReport = buildReports(temporalSample);
  const temporal = temporalReport.temporal_maturity;
  const byId = Object.fromEntries(temporal.dimensions.map(dimension => [dimension.id, dimension]));
  const decision2022 = byId.decision_making.years.find(year => year.year === "2022");
  const data2023 = byId.data_reasoning.years.find(year => year.year === "2023");
  const execution2023 = byId.execution.years.find(year => year.year === "2023");
  assert.ok(decision2022.counter_evidence_count > 0, "2022 decision making has counter-evidence");
  assert.ok(["counter_evidence_only", "mixed_evidence", "emerging"].includes(decision2022.status), "2022 decision making stays limited");
  assert.ok(["observed", "recurring", "strongly_supported"].includes(data2023.status), "2023 data reasoning grows");
  assert.strictEqual(execution2023.status, "insufficient_evidence", "execution remains insufficient when not evidenced");

  const emptyReport = buildReports(normalizeChatGptExport([
    { id: "empty", title: "Generic", messages: [{ author: "user", created_at: "2026-01-01T00:00:00.000Z", text: "Parliamo di un tema generico senza segnali tecnici." }] }
  ]));
  const emptyDecision = emptyReport.temporal_maturity.dimensions.find(d => d.id === "decision_making");
  assert.strictEqual(emptyDecision.status, "insufficient_evidence", "0 positive and 0 negative means insufficient_evidence");
  assert.strictEqual(emptyDecision.capability_score, null, "insufficient evidence has no capability score");

  const strongReport = buildReports(normalizeChatGptExport([
    { id: "s1", title: "API 1", messages: [{ author: "user", created_at: "2026-01-01T00:00:00.000Z", text: "Definisco endpoint API, payload JSON e schema dati.", content_origin: { value: "original_user_input" } }] },
    { id: "s2", title: "API 2", messages: [{ author: "user", created_at: "2026-02-01T00:00:00.000Z", text: "Valido API, dataset, metric e database schema.", content_origin: { value: "original_user_input" } }] },
    { id: "s3", title: "API 3", messages: [{ author: "user", created_at: "2026-03-01T00:00:00.000Z", text: "Scelgo endpoint, payload e validation per il data model.", content_origin: { value: "original_user_input" } }] }
  ]));
  const strongData = strongReport.temporal_maturity.dimensions.find(d => d.id === "data_reasoning");
  assert.ok(strongData.evidence_coverage >= 70, "4+ positive signals from 3 user conversations give high coverage");
  assert.ok(["observed", "recurring", "strongly_supported"].includes(strongData.status), "strong data evidence status is sufficient");

  const aiReport = buildReports(normalizeChatGptExport([
    { id: "ai1", title: "AI generated", messages: [{ author: "user", created_at: "2026-01-01T00:00:00.000Z", text: "endpoint API payload JSON schema database", content_origin: { value: "ai_generated_text" } }] },
    { id: "ai2", title: "AI generated 2", messages: [{ author: "user", created_at: "2026-01-02T00:00:00.000Z", text: "dataset metric validation SQL API", content_origin: { value: "ai_generated_text" } }] },
    { id: "u1", title: "User", messages: [{ author: "user", created_at: "2026-01-03T00:00:00.000Z", text: "Ho definito endpoint API.", content_origin: { value: "original_user_input" } }] }
  ]));
  const aiData = aiReport.temporal_maturity.dimensions.find(d => d.id === "data_reasoning");
  assert.strictEqual(aiData.ai_generated_count, 0, "AI-generated text is not positive capability evidence");
  assert.ok(aiData.uncertain_count >= 2, "AI-generated technical text is tracked as uncertain");

  const jdReport = buildReports(normalizeChatGptExport([
    { id: "jd", title: "JD", messages: [{ author: "user", created_at: "2026-01-01T00:00:00.000Z", text: "Job description: Kubernetes, API, database, architecture expertise required.", content_origin: { value: "pasted_job_description" } }] }
  ]));
  const jdData = jdReport.temporal_maturity.dimensions.find(d => d.id === "data_reasoning");
  assert.strictEqual(jdData.positive_count, 0, "job description does not create user skill evidence");

  const singleYear = buildReports(normalizeChatGptExport([
    { id: "one_year", title: "Only 2026", messages: [{ author: "user", created_at: "2026-04-01T00:00:00.000Z", text: "Definisco requisiti e API payload." }] }
  ])).temporal_maturity;
  assert.strictEqual(singleYear.section_title, "Evidence by period", "single year uses Evidence by period title");
  assert.ok(singleYear.scope.includes("Historical comparison unavailable"), "single year says historical comparison unavailable");

  const governanceOnly = buildReports(normalizeChatGptExport([
    { id: "gov", title: "Governance", messages: [{ author: "user", created_at: "2026-01-01T00:00:00.000Z", text: "Gestisco governance con team tecnico, developer review, criteri di accettazione e delivery." }] }
  ])).temporal_maturity;
  const govNotes = governanceOnly.capability_stages[0].consistency_notes.join(" ");
  assert.ok(govNotes.includes("Higher-order evidence exists"), "governance without lower stage produces consistency note");

  const surgeonReport = buildReports(normalizeChatGptExport([
    { id: "surgeon1", title: "Case 1", messages: [{ author: "user", created_at: "2026-01-01T00:00:00.000Z", text: "Claim: I show clinical decision-making under uncertainty. Evidence: I used intraoperative adaptability when the plan changed. Claim: Specialization: robotic surgery.", content_origin: { value: "original_user_input" } }] },
    { id: "surgeon2", title: "Case 2", messages: [{ author: "user", created_at: "2026-02-01T00:00:00.000Z", text: "Claim: Clinical decision-making improved during complex cases. Evidence: Intraoperative adaptability helped coordinate the next step. Claim: Specialization: robotic surgery.", content_origin: { value: "original_user_input" } }] }
  ]));
  const semantic = surgeonReport.temporal_maturity.dimensions.filter(dimension => dimension.derivation === "semantic_capability_extraction");
  assert.ok(semantic.some(dimension => dimension.canonical_dimension === "decision_making" && /clinical decision/.test(dimension.discovered_from.term)), "clinical decision-making maps to decision_making");
  assert.ok(semantic.some(dimension => dimension.canonical_dimension === "execution" && /intraoperative adaptability/.test(dimension.discovered_from.term)), "intraoperative adaptability maps to execution");
  assert.ok(semantic.every(dimension => dimension.radar_eligible), "semantic radar dimensions are explicitly eligible");
  assert.ok(surgeonReport.temporal_maturity.dimension_strategy.rejected_candidates.some(candidate => candidate.semantic_type === "specialization" && /robotic surgery/.test(candidate.candidate.toLowerCase())), "robotic surgery is specialization and rejected from radar");
  assert.ok(surgeonReport.temporal_maturity.dimension_strategy.semantic_capability_dimensions >= 2, "dimension strategy exposes semantic count");

  const mixedDominanceReport = buildReports(normalizeChatGptExport([
    { id: "pt1", title: "Product roadmap", professional_category: "product_management", messages: [{ author: "user", created_at: "2026-05-01T00:00:00.000Z", text: "Definisco roadmap, priorita di backlog e coordino stakeholder per delivery.", content_origin: { value: "original_user_input" } }] },
    { id: "pt2", title: "Tech integration", professional_category: "technology", messages: [{ author: "user", created_at: "2026-05-03T00:00:00.000Z", text: "Valuto trade-off API, schema dati e integrazioni tra servizi.", content_origin: { value: "original_user_input" } }] },
    { id: "pt3", title: "Execution", professional_category: "execution", messages: [{ author: "user", created_at: "2026-05-05T00:00:00.000Z", text: "Coordino dipendenze, milestone e consegna cross-functional.", content_origin: { value: "original_user_input" } }] },
    { id: "pt4", title: "Data reasoning", professional_category: "data_analytics", messages: [{ author: "user", created_at: "2026-05-08T00:00:00.000Z", text: "Uso metric, KPI e validazione dati per prioritizzare.", content_origin: { value: "original_user_input" } }] },
    { id: "pt5", title: "Stakeholder alignment", professional_category: "professional_communication", messages: [{ author: "user", created_at: "2026-05-10T00:00:00.000Z", text: "Allineo stakeholder e chiarisco decisioni operative.", content_origin: { value: "mixed_content" } }] },
    { id: "pt6", title: "Delivery governance", professional_category: "project_management", messages: [{ author: "user", created_at: "2026-05-12T00:00:00.000Z", text: "Pianifico milestone, rischio e ownership di delivery.", content_origin: { value: "original_user_input" } }] },
    { id: "pt7", title: "Product decision", professional_category: "product_management", messages: [{ author: "user", created_at: "2026-05-14T00:00:00.000Z", text: "Prendo decisioni su scope MVP e backlog sequencing.", content_origin: { value: "original_user_input" } }] },
    { id: "r1", title: "Interview prep", professional_category: "recruiting", messages: [{ author: "user", created_at: "2026-05-16T00:00:00.000Z", text: "Preparo domande colloquio e valutazione candidati.", content_origin: { value: "original_user_input" } }] },
    { id: "r2", title: "Candidate screening", professional_category: "recruiting", messages: [{ author: "user", created_at: "2026-05-18T00:00:00.000Z", text: "Review CV e shortlist candidati per ruolo tecnico.", content_origin: { value: "mixed_content" } }] },
    { id: "r3", title: "Recruiting support", professional_category: "recruiting", messages: [{ author: "user", created_at: "2026-05-20T00:00:00.000Z", text: "Supporto processo recruiting con feedback strutturato.", content_origin: { value: "original_user_input" } }] }
  ]));
  assert.notStrictEqual(mixedDominanceReport.professional_identity.observed_archetype, "hr_lead", "30% recruiting should not force HR lead archetype");
  assert.notStrictEqual(mixedDominanceReport.professional_pattern.dominant_domain, "recruiting", "recruiting should not dominate 70/30 product-tech mix");

  const oneRecruitingReport = buildReports(normalizeChatGptExport([
    { id: "main1", title: "Product", professional_category: "product_management", messages: [{ author: "user", created_at: "2026-05-01T00:00:00.000Z", text: "Definisco roadmap, backlog e stakeholder priorities.", content_origin: { value: "original_user_input" } }] },
    { id: "main2", title: "Tech", professional_category: "technology", messages: [{ author: "user", created_at: "2026-05-03T00:00:00.000Z", text: "Valuto API, integrazioni e rischi tecnici.", content_origin: { value: "original_user_input" } }] },
    { id: "main3", title: "Execution", professional_category: "execution", messages: [{ author: "user", created_at: "2026-05-05T00:00:00.000Z", text: "Coordino delivery con team cross-functional.", content_origin: { value: "original_user_input" } }] },
    { id: "rec_once", title: "One recruiting task", professional_category: "recruiting", messages: [{ author: "user", created_at: "2026-05-08T00:00:00.000Z", text: "Una tantum preparo domande per colloquio tecnico.", content_origin: { value: "original_user_input" } }] }
  ]));
  const oneRecruitingDomain = oneRecruitingReport.professional_pattern.domain_scores.find(item => item.domain === "recruiting");
  assert.ok(oneRecruitingDomain && !oneRecruitingDomain.passes_threshold, "single recruiting conversation should stay occasional");
  assert.notStrictEqual(oneRecruitingReport.professional_pattern.dominant_domain, "recruiting", "single recruiting evidence must not become dominant domain");

  const pastedDominanceReport = buildReports(normalizeChatGptExport([
    { id: "jd1", title: "JD1", professional_category: "technology", messages: [{ author: "user", created_at: "2026-05-01T00:00:00.000Z", text: "Job description: architect profile with Kubernetes, APIs, leadership, hiring responsibilities.", content_origin: { value: "pasted_job_description" } }] },
    { id: "jd2", title: "JD2", professional_category: "product_management", messages: [{ author: "user", created_at: "2026-05-02T00:00:00.000Z", text: "External document: product leadership responsibilities and hiring ownership.", content_origin: { value: "pasted_external_document" } }] },
    { id: "u_direct", title: "Direct user", professional_category: "execution", messages: [{ author: "user", created_at: "2026-05-03T00:00:00.000Z", text: "Coordino una delivery operativa con dipendenze e milestone.", content_origin: { value: "original_user_input" } }] }
  ]));
  const topPastedDomain = pastedDominanceReport.professional_pattern.domain_scores[0];
  assert.ok(topPastedDomain.direct_user_items < 2 || !topPastedDomain.passes_threshold, "mostly pasted content should not pass direct-attribution threshold");
  assert.ok(pastedDominanceReport.professional_pattern.limitations.some(item => /Attribution penalties|threshold/i.test(item)), "pasted-heavy profile should expose attribution limitations");

  const mixedContentReport = buildReports(normalizeChatGptExport([
    { id: "mix1", title: "Mixed A", professional_category: "technology", messages: [{ author: "user", created_at: "2026-05-01T00:00:00.000Z", text: "Valuto API trade-off ma allego blocchi AI-generated per bozza.", content_origin: { value: "mixed_content" } }] },
    { id: "mix2", title: "Mixed B", professional_category: "product_management", messages: [{ author: "user", created_at: "2026-05-04T00:00:00.000Z", text: "Definisco backlog prioritization con supporto di testo esterno.", content_origin: { value: "mixed_content" } }] },
    { id: "mix3", title: "AI block", professional_category: "technology", messages: [{ author: "user", created_at: "2026-05-07T00:00:00.000Z", text: "Architecture summary drafted by AI assistant pasted for review.", content_origin: { value: "ai_generated_text" } }] },
    { id: "mix4", title: "External", professional_category: "recruiting", messages: [{ author: "user", created_at: "2026-05-09T00:00:00.000Z", text: "Pasted candidate rubric from external source.", content_origin: { value: "pasted_external_document" } }] }
  ]));
  assert.ok(["archetype_driven", "insufficient_evidence"].includes(mixedContentReport.professional_pattern.signature_mode), "pattern mode should be valid after archetype refactor");
  assert.ok(mixedContentReport.professional_pattern.limitations.length >= 1, "mixed content should expose attribution limitations clearly");

  const chiefGrowthOfficerSynthetic = normalizeChatGptExport([
    {
      id: "growth_1",
      title: "Chief Growth Officer synthetic sample",
      professional_category: "strategy",
      messages: [{
        author: "user",
        created_at: "2026-06-01T00:00:00.000Z",
        text: "We are optimizing funnel conversion, CAC, LTV and retention. I am aligning marketing and sales pipeline priorities and defining pricing and monetization experiments.",
        content_origin: { value: "original_user_input" }
      }]
    },
    {
      id: "growth_2",
      title: "Revenue execution",
      professional_category: "negotiation",
      messages: [{
        author: "user",
        created_at: "2026-06-10T00:00:00.000Z",
        text: "I am driving acquisition and expansion revenue through partner channels, upsell and cross-sell plans with measurable KPI tracking.",
        content_origin: { value: "original_user_input" }
      }]
    }
  ]);
  const chiefGrowthReport = buildReports(chiefGrowthOfficerSynthetic);
  assert.ok(chiefGrowthReport.professional_pattern.primary_archetype, "growth sample should infer a primary archetype");
  assert.ok(chiefGrowthReport.professional_pattern.observed_professional_pattern.startsWith("Evidence suggests"), "observed pattern should use conservative wording");
  assert.ok(chiefGrowthReport.professional_pattern.typical_professional_contribution.includes("Typically"), "typical contribution should be generated");
  assert.ok(chiefGrowthReport.professional_pattern.radar_capabilities.length <= 6, "radar capabilities are capped at 6");
  assert.ok(chiefGrowthReport.professional_pattern.radar_capabilities.every(item => !String(item.label).includes("_")), "radar labels should not expose snake_case");

  const pasqualePackReport = buildReports(packConversations);
  assert.ok(pasqualePackReport.professional_pattern.observed_professional_pattern.startsWith("Evidence suggests"), "pasquale pack keeps conservative pattern sentence");
  assert.ok(Array.isArray(pasqualePackReport.professional_pattern.professional_domains_observed), "pasquale pack exposes professional domains observed");

  const technicalProductReport = buildReports(normalizeChatGptExport([
    {
      id: "tp_1",
      title: "Technical product coordination",
      professional_category: "product_management",
      messages: [{
        author: "user",
        created_at: "2026-06-12T00:00:00.000Z",
        text: "I prioritize roadmap requirements, coordinate release delivery and discuss API integration trade-offs with engineering.",
        content_origin: { value: "original_user_input" }
      }]
    },
    {
      id: "tp_2",
      title: "Databricks help request",
      professional_category: "technology",
      messages: [{
        author: "user",
        created_at: "2026-06-13T00:00:00.000Z",
        text: "period_diff does not work on Databricks, can you help me debug the SQL?",
        content_origin: { value: "original_user_input" }
      }]
    }
  ]));
  const tpSignals = technicalProductReport.technical_signals_observed;
  const tpSql = tpSignals.programming_languages.find(item => item.name === "SQL");
  const tpDatabricks = tpSignals.cloud_infrastructure.find(item => item.name === "Databricks");
  assert.ok(tpSql && ["requested_help", "discussed", "used_directly"].includes(tpSql.exposure), "SQL should be detected with non-expert conservative exposure");
  assert.ok(tpDatabricks && ["requested_help", "discussed"].includes(tpDatabricks.exposure), "Databricks should be detected as discussed/assisted");

  const governanceComplianceReport = buildReports(normalizeChatGptExport([
    {
      id: "gov_1",
      title: "GDPR and controls",
      professional_category: "leadership",
      messages: [{
        author: "user",
        created_at: "2026-06-14T00:00:00.000Z",
        text: "I coordinate GDPR compliance, approval flows, documentation ownership and control checks across stakeholders.",
        content_origin: { value: "original_user_input" }
      }]
    },
    {
      id: "gov_2",
      title: "Pasted security JD",
      professional_category: "technology",
      messages: [{
        author: "user",
        created_at: "2026-06-15T00:00:00.000Z",
        text: "Job description: Kubernetes, Cloudflare, WAF, API security and zero trust architecture expertise required.",
        content_origin: { value: "pasted_job_description" }
      }]
    }
  ]));
  assert.ok(governanceComplianceReport.professional_pattern.observed_professional_pattern.startsWith("Evidence suggests"), "governance pattern sentence should be natural and conservative");
  assert.ok(governanceComplianceReport.professional_pattern.typical_professional_contribution.length > 30, "governance contribution should be role-aware");
  const govKubernetes = governanceComplianceReport.technical_signals_observed.cloud_infrastructure.find(item => item.name === "Kubernetes");
  assert.ok(govKubernetes && govKubernetes.exposure === "third_party_context", "pasted JD tools should be marked as external context");

  assert.ok(chiefGrowthReport.professional_pattern.radar_capabilities.every(item => !/_[a-z]/i.test(item.label)), "no snake_case should appear in visible radar labels");
  console.log("All tests passed.");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
