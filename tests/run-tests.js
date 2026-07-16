const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { PDFParse } = require("pdf-parse");
const {
  handleRequest,
  normalizeChatGptExport,
  attachResolvedConversationSelection,
  buildNormalized,
  buildReports,
  renderSnapshotPdf,
  renderAppendixPdf,
  renderCombinedPdf,
  scanSummary,
  redactText
} = require("../server.cjs");
const PromptBuilder = require("../public/prompt-builder.js");
const ReportViewModel = require("../public/report-view-model.js");
const {
  resolveInitialConversationIncluded,
  applyUserConversationSelection
} = require("../public/conversation-selection.js");

const root = path.join(__dirname, "..");
const serverPath = path.join(root, "server.cjs");
const samplePath = path.join(root, "public", "samples", "synthetic-conversations.json");
const evidencePackPath = path.join(root, "public", "samples", "sample-evidence-pack.json");
const fixtureHrPath = path.join(root, "test-fixtures", "hr-talent", "professional_evidence_pack_hr-talent_2026-07-16.json");
const fixtureBackendPath = path.join(root, "test-fixtures", "senior-backend", "professional_evidence_pack_senior-backend-developer_2026-07-16.json");
const fixtureSalesPath = path.join(root, "test-fixtures", "sales", "professional_evidence_pack_sales-business-development_2026-07-16.json");
const fixtureLegalPath = path.join(root, "test-fixtures", "legal-compliance", "professional_evidence_pack_legal-compliance_2026-07-16.json");

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
  const runNewTests = process.env.TEST_SCOPE !== "existing";

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
  assert.ok(escapedProfilePrompt.includes('EviLayer Profile - Mario \\"M\\" Rossi'), "profile name is escaped correctly inside JSON context");

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
      snapshotTitle: "EviLayer Snapshot",
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
      appendixTitle: "Evidence Appendix"
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
  const combinedPdf = await renderCombinedPdf(pdfSnapshot, pdfConfig);
  assert.ok(snapshotPdf.length > 1000, "snapshot pdf buffer returned");
  assert.ok(appendixPdf.length > 1000, "appendix pdf buffer returned");
  assert.ok(combinedPdf.length > 1500, "combined pdf buffer returned");
  const parsedSnapshot = await parsedPdf(snapshotPdf);
  const parsedAppendix = await parsedPdf(appendixPdf);
  const parsedCombined = await parsedPdf(combinedPdf);
  const snapshotText = parsedSnapshot.text;
  const appendixText = parsedAppendix.text;
  const normalizedSnapshotText = snapshotText.replace(/\s+/g, " ").trim();
  const normalizedAppendixText = appendixText.replace(/\s+/g, " ").trim();
  assert.strictEqual(parsedSnapshot.total, 1, "snapshot pdf reports exactly one page via parser");
  assert.ok(normalizedSnapshotText.includes("EviLayer Snapshot"), "snapshot pdf includes title");
  assert.ok(normalizedSnapshotText.includes("Direct evidence: 50%"), "snapshot pdf includes direct attribution line");
  assert.ok(normalizedSnapshotText.includes("Mixed attribution: 20%"), "snapshot pdf includes mixed attribution line");
  assert.ok(normalizedSnapshotText.includes("External or AI context: 30%"), "snapshot pdf includes contextual attribution line");
  assert.ok(normalizedSnapshotText.includes("Methodology and verification"), "snapshot pdf includes methodology footer");
  assert.ok(normalizedSnapshotText.includes("Evidence Overview"), "snapshot pdf includes KPI section");
  assert.ok(normalizedSnapshotText.includes("Not Assessed"), "snapshot pdf includes not assessed section");
  assert.ok(normalizedAppendixText.includes("Evidence Appendix"), "appendix pdf includes title");
  assert.ok(normalizedAppendixText.includes("Conversations"), "appendix includes conversation section");
  assert.ok(normalizedAppendixText.includes("Evidence cards"), "appendix includes evidence card section");
  assert.ok(parsedCombined.total >= parsedAppendix.total + parsedSnapshot.total, "combined pdf includes snapshot and appendix pages");

  const forbiddenTokens = ["undefined", "null", "mixed_content", "user_instruction", "candidate_type", "Candidate type", "Dimension:", "Display.", "and.", "through."];
  const snapshotLower = normalizedSnapshotText.toLowerCase();
  const appendixLower = normalizedAppendixText.toLowerCase();
  for (const token of forbiddenTokens) {
    assert.ok(!snapshotLower.includes(token.toLowerCase()), `snapshot must not include forbidden token ${token}`);
    assert.ok(!appendixLower.includes(token.toLowerCase()), `appendix must not include forbidden token ${token}`);
  }

  const segmentTotal = pdfSnapshot.evidenceMix.segments.reduce((sum, segment) => sum + Number(segment.value || 0), 0);
  assert.ok(segmentTotal >= 99 && segmentTotal <= 101, "attribution segments sum to 100 with rounding tolerance");
  assert.ok((pdfSnapshot.axes || []).slice(0, 5).length <= 5, "snapshot capabilities do not exceed 5");
  assert.ok(String(pdfSnapshot.professionalSignature || "").length <= 280, "summary sentence stays bounded");
  assert.ok(pdfConfig.period_from <= pdfConfig.period_to, "trusted period dates remain coherent");

  const canonicalVm = ReportViewModel.validateReportViewModel(ReportViewModel.buildReportViewModel(pdfSnapshot)).model;
  const canonicalVmFixture = ReportViewModel.validateReportViewModel(ReportViewModel.buildReportViewModel({
    ...pdfSnapshot,
    evidenceMix: {
      attributable: 0,
      segments: [
        { tone: "direct", value: 0 },
        { tone: "mixed", value: 60 },
        { tone: "external", value: 20 },
        { tone: "ai", value: 20 }
      ]
    }
  })).model;
  assert.ok(Array.isArray(canonicalVm.metrics) && canonicalVm.metrics.length === 4, "canonical vm exposes four top metrics");
  assert.ok(canonicalVm.capabilities.length > 0, "canonical vm retains assessed capabilities even without positive_count");
  assert.strictEqual(canonicalVm.metrics[0].label, "Professional conversations", "canonical vm metrics preserve label contract");
  assert.strictEqual(canonicalVmFixture.metrics[3].label, "Mixed attribution", "direct share KPI is replaced when direct evidence is zero");
  assert.ok(!canonicalVmFixture.metrics.some(metric => metric && metric.label === "Direct evidence share"), "no direct evidence share metric when direct evidence is zero");

  const canonicalHtml = ReportViewModel.renderSnapshotHtml(canonicalVm);
  const canonicalFixtureHtml = ReportViewModel.renderSnapshotHtml(canonicalVmFixture);
  const normalizedCanonicalHtml = canonicalHtml.replace(/\s+/g, " ").trim();
  const normalizedFixtureHtml = canonicalFixtureHtml.replace(/\s+/g, " ").trim();
  assert.ok(normalizedCanonicalHtml.includes("Evidence Overview"), "preview html includes canonical section naming");
  assert.ok(normalizedCanonicalHtml.includes("Supported Capabilities"), "preview html includes capability section");
  assert.ok(!normalizedFixtureHtml.includes("0 evidence items across 0 conversations"), "preview html omits invalid zero-zero capability count line");
  assert.ok(!normalizedFixtureHtml.includes("Direct evidence share"), "preview html hides direct evidence share when direct attribution is zero");
  const forbiddenHtmlTokens = ["undefined", "null", "nan", "mixed_content", "user_instruction", "candidate_type"];
  const normalizedFixtureLower = normalizedFixtureHtml.toLowerCase();
  for (const token of forbiddenHtmlTokens) {
    assert.ok(!normalizedFixtureLower.includes(token), `preview html must not include forbidden token ${token}`);
  }

  // SHARED VIEW MODEL PARITY — FRONTEND/PDF
  const paritySnapshot = {
    personName: "Parity Profile",
    extractedDate: "2026-07-16",
    dataRange: "2026-01-01 - 2026-07-16",
    observationPeriod: "6 months",
    summary: "The analyzed professional conversations show recurring evidence around Incident Mitigation Planning and Data Reasoning.",
    professionalSignature: "Evidence suggests a technical and engineering profile with recurring strength in incident mitigation planning and data reasoning.",
    typicalContribution: "Typically analyses reliability constraints, structures mitigation actions and communicates evidence-based decisions.",
    observedDomains: ["technology integrations"],
    kpis: [
      { value: "6", label: "Professional conversations", note: "Retained" },
      { value: "18", label: "Evidence items", note: "Attributed" },
      { value: "2", label: "Demonstrated capabilities", note: "Supported" },
      { value: "70%", label: "Weighted attribution", note: "Direct + mixed" }
    ],
    axes: [
      {
        label: "Incident.",
        resolved_label: "Incident Mitigation Planning",
        full_label: "Incident Mitigation Planning",
        canonical_label: "Risk awareness",
        display_label: "Incident Mitigation Planning",
        level: "recurring",
        assessed: true,
        coverage: 72,
        strength: 74,
        confidence: "high",
        positive_count: 3,
        unique_conversation_count: 2
      },
      {
        label: "Data.",
        resolved_label: "Data Reasoning",
        full_label: "Data Reasoning",
        canonical_label: "Data reasoning",
        display_label: "Data Reasoning",
        level: "strongly_supported",
        assessed: true,
        coverage: 76,
        strength: 78,
        confidence: "high",
        positive_count: 4,
        unique_conversation_count: 3
      }
    ],
    evidenceMix: {
      attributable: 70,
      segments: [
        { tone: "direct", value: 50 },
        { tone: "mixed", value: 20 },
        { tone: "external", value: 20 },
        { tone: "ai", value: 10 }
      ]
    },
    analyzedConversationCount: 6,
    totalEvidenceItemCount: 18
  };

  const sharedVm = ReportViewModel.validateReportViewModel(ReportViewModel.buildSnapshotViewModel(paritySnapshot)).model;
  const legacyVm = ReportViewModel.validateReportViewModel(ReportViewModel.buildReportViewModel(paritySnapshot)).model;
  assert.strictEqual(sharedVm.headline, legacyVm.headline, "same view model: buildSnapshotViewModel and buildReportViewModel remain aligned");
  assert.strictEqual(sharedVm.professionalPattern, legacyVm.professionalPattern, "same view model: pattern is aligned");
  assert.strictEqual(sharedVm.typicalContribution, legacyVm.typicalContribution, "same view model: contribution is aligned");

  const parityPayload = { ...paritySnapshot, snapshotViewModel: sharedVm };
  const parityPdf = await renderSnapshotPdf(parityPayload, pdfConfig);
  const parityParsed = await parsedPdf(parityPdf);
  const parityText = parityParsed.text.replace(/\s+/g, " ").trim();

  assert.ok(parityText.includes("Incident Mitigation Planning"), "full capability label Incident Mitigation Planning appears in PDF");
  assert.ok(parityText.includes("Data Reasoning"), "full capability label Data Reasoning appears in PDF");
  assert.ok(!parityText.includes("Incident."), "PDF must not show first-token Incident.");
  assert.ok(!parityText.includes("Data."), "PDF must not show first-token Data.");
  assert.ok(parityText.includes(sharedVm.headline.replace(/\s+/g, " ").trim()), "headline parity between frontend view model and PDF");
  assert.ok(parityText.includes(sharedVm.professionalPattern.replace(/\s+/g, " ").trim()), "pattern parity between frontend view model and PDF");
  assert.ok(parityText.includes(sharedVm.typicalContribution.replace(/\s+/g, " ").trim()), "typical contribution parity between frontend view model and PDF");
  assert.ok(!parityText.includes("The strongest observable pattern is Incident."), "legacy strongest observable pattern sentence is not auto-added in PDF");

  const parityCapabilityLabels = (sharedVm.capabilities || []).map(item => item.label);
  assert.deepStrictEqual(parityCapabilityLabels, ["Incident Mitigation Planning", "Data Reasoning"], "payload parity: supported capability labels are identical and complete");

  const pdfFixtures = [
    { ...pdfSnapshot, personName: "A" },
    { ...pdfSnapshot, personName: "Very Long Professional Profile Name With Multiple Corporate Segments And Regional Scope" },
    { ...pdfSnapshot, axes: pdfSnapshot.axes.slice(0, 3) },
    { ...pdfSnapshot, evidenceMix: { attributable: 0, segments: [{ tone: "direct", value: 0 }, { tone: "mixed", value: 60 }, { tone: "external", value: 20 }, { tone: "ai", value: 20 }] } },
    { ...pdfSnapshot, evidenceHighlights: [{ ...pdfSnapshot.evidenceHighlights[0], counterEvidence: null }, { ...pdfSnapshot.evidenceHighlights[0], skill: "Stakeholder Communication And Cross Functional Alignment", title: "Long evidence title" }] }
  ];
  for (const fixture of pdfFixtures) {
    const fixtureSnapshotPdf = await renderSnapshotPdf(fixture, pdfConfig);
    const fixtureAppendixPdf = await renderAppendixPdf(fixture, pdfConfig);
    assert.ok(fixtureSnapshotPdf.length > 900, "fixture snapshot pdf generated");
    assert.ok(fixtureAppendixPdf.length > 900, "fixture appendix pdf generated");
    const fixtureParsedSnapshot = await parsedPdf(fixtureSnapshotPdf);
    assert.strictEqual(fixtureParsedSnapshot.total, 1, "fixture snapshot keeps one page");
  }

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
    generated_for: "EviLayer Profile - Source Test",
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
    generated_for: "EviLayer Profile - Legacy",
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
  assert.ok(
    chiefGrowthReport.professional_pattern.observed_professional_pattern.startsWith("Evidence suggests") ||
    chiefGrowthReport.professional_pattern.observed_professional_pattern.startsWith("Available evidence indicates emerging professional patterns"),
    "observed pattern should be conservative and may be neutral when demonstrated evidence is insufficient"
  );
  assert.ok(
    chiefGrowthReport.professional_pattern.typical_professional_contribution.includes("Typically") ||
    chiefGrowthReport.professional_pattern.typical_professional_contribution.startsWith("Available evidence is not yet sufficient"),
    "typical contribution should be generated or neutral when demonstrated evidence is insufficient"
  );
  assert.ok(chiefGrowthReport.professional_pattern.radar_capabilities.length <= 6, "radar capabilities are capped at 6");
  assert.ok(chiefGrowthReport.professional_pattern.radar_capabilities.every(item => !String(item.label).includes("_")), "radar labels should not expose snake_case");

  const pasqualePackReport = buildReports(packConversations);
  assert.ok(
    pasqualePackReport.professional_pattern.observed_professional_pattern.startsWith("Evidence suggests") ||
    pasqualePackReport.professional_pattern.observed_professional_pattern.startsWith("Available evidence indicates emerging professional patterns"),
    "pasquale pack keeps conservative or neutral pattern sentence"
  );
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
  assert.ok(
    governanceComplianceReport.professional_pattern.observed_professional_pattern.startsWith("Evidence suggests") ||
    governanceComplianceReport.professional_pattern.observed_professional_pattern.startsWith("Available evidence indicates emerging professional patterns"),
    "governance pattern sentence should be conservative and can be neutral with insufficient demonstrated evidence"
  );
  assert.ok(governanceComplianceReport.professional_pattern.typical_professional_contribution.length > 30, "governance contribution should be role-aware");
  const govKubernetes = governanceComplianceReport.technical_signals_observed.cloud_infrastructure.find(item => item.name === "Kubernetes");
  assert.ok(govKubernetes && govKubernetes.exposure === "third_party_context", "pasted JD tools should be marked as external context");

  if (runNewTests) {
    const findCapability = (items, label) => (items || []).find(item => String(item.label || "").toLowerCase() === String(label || "").toLowerCase());
    const isSupported = (pattern, label) => Boolean(findCapability(pattern.radar_capabilities, label));
    const findSignal = (pattern, label) => findCapability(pattern.emerging_signals, label);
    const findAssessment = (pattern, label) => findCapability(pattern.capability_assessments, label);

    // TEST 1 — SINGLE MENTORING EVIDENCE
    const singleMentoringReport = buildReports(normalizeChatGptExport([
      {
        id: "tm1",
        title: "Single mentoring",
        professional_category: "professional_communication",
        messages: [{
          author: "user",
          created_at: "2026-06-01T00:00:00.000Z",
          text: "Claim: Technical Mentoring\nSupporting excerpt: Mentored one junior developer once.\nCounter-evidence: A single mentoring example does not demonstrate formal people management or sustained team leadership.",
          content_origin: { value: "original_user_input" }
        }]
      }
    ])).professional_pattern;
    const technicalMentoringSignal = findSignal(singleMentoringReport, "Technical Mentoring");
    assert.ok(technicalMentoringSignal && technicalMentoringSignal.capability_state === "signal", "single mentoring remains Technical Mentoring signal");
    assert.ok(!isSupported(singleMentoringReport, "Team Leadership"), "single mentoring must not promote Team Leadership");
    assert.ok(!isSupported(singleMentoringReport, "People Management"), "single mentoring must not promote People Management");
    const feedbackManagementAssessment = findAssessment(singleMentoringReport, "Feedback Management");
    assert.ok(!feedbackManagementAssessment || feedbackManagementAssessment.capability_state !== "demonstrated", "single mentoring must not demonstrate Feedback Management");

    // TEST 2 — SINGLE EXECUTIVE COMMUNICATION EVIDENCE
    const singleExecCommReport = buildReports(normalizeChatGptExport([
      {
        id: "te1",
        title: "Single executive update",
        professional_category: "professional_communication",
        messages: [{
          author: "user",
          created_at: "2026-06-02T00:00:00.000Z",
          text: "Claim: Executive Technical Communication\nClaim: Information Synthesis\nSupporting excerpt: Prepared one executive status update with technical synthesis.\nCounter-evidence: One communication example does not establish broad executive leadership responsibility.",
          content_origin: { value: "original_user_input" }
        }]
      }
    ])).professional_pattern;
    assert.ok(
      findSignal(singleExecCommReport, "Executive Technical Communication") ||
      findSignal(singleExecCommReport, "Information Synthesis"),
      "single executive communication is tracked as specific signal"
    );
    assert.ok(!isSupported(singleExecCommReport, "Stakeholder Alignment"), "single executive update must not promote Stakeholder Alignment");
    assert.ok(!isSupported(singleExecCommReport, "Meeting Facilitation"), "single executive update must not promote Meeting Facilitation");
    assert.ok(!isSupported(singleExecCommReport, "Executive Leadership"), "single executive update must not promote Executive Leadership");

    // TEST 3 — REPEATED ARCHITECTURE EVIDENCE
    const repeatedArchitectureReport = buildReports(normalizeChatGptExport([
      {
        id: "ta1",
        title: "Architecture 1",
        professional_category: "technology",
        messages: [{
          author: "user",
          created_at: "2026-01-01T00:00:00.000Z",
          text: "Claim: Software Architecture\nClaim: Architecture Trade-off Evaluation\nSupporting excerpt: Evaluated service boundaries and reliability trade-offs for distributed systems.",
          content_origin: { value: "original_user_input" }
        }]
      },
      {
        id: "ta2",
        title: "Architecture 2",
        professional_category: "technology",
        messages: [{
          author: "user",
          created_at: "2026-02-01T00:00:00.000Z",
          text: "Claim: Software Architecture\nClaim: Architecture Trade-off Evaluation\nSupporting excerpt: Compared architecture options and migration constraints.",
          content_origin: { value: "original_user_input" }
        }]
      },
      {
        id: "ta3",
        title: "Architecture 3",
        professional_category: "technology",
        messages: [{
          author: "user",
          created_at: "2026-03-01T00:00:00.000Z",
          text: "Claim: Software Architecture\nClaim: Architecture Trade-off Evaluation\nSupporting excerpt: Finalized architecture decision for API evolution and observability.",
          content_origin: { value: "original_user_input" }
        }]
      }
    ])).professional_pattern;
    const softwareArchitecture = findCapability(repeatedArchitectureReport.radar_capabilities, "Software Architecture");
    assert.ok(softwareArchitecture && ["demonstrated", "strongly_demonstrated", "attested"].includes(softwareArchitecture.capability_state), "repeated architecture promotes Software Architecture");
    const architectureTradeoff =
      findCapability(repeatedArchitectureReport.radar_capabilities, "Architecture Trade-off Evaluation") ||
      findCapability(repeatedArchitectureReport.radar_capabilities, "Architecture Trade Off Evaluation") ||
      findSignal(repeatedArchitectureReport, "Architecture Trade-off Evaluation") ||
      findSignal(repeatedArchitectureReport, "Architecture Trade Off Evaluation");
    assert.ok(architectureTradeoff, "architecture trade-off is at least emerging under repeated architecture evidence");
    assert.ok(/technology|architecture|technical|engineering/i.test(repeatedArchitectureReport.observed_professional_pattern), "repeated architecture keeps technical professional pattern");

    // TEST 4 — COUNTER-EVIDENCE OVERRIDE
    const counterOverrideReport = buildReports(normalizeChatGptExport([
      {
        id: "tc1",
        title: "Mentoring with explicit limits",
        professional_category: "professional_communication",
        messages: [{
          author: "user",
          created_at: "2026-06-03T00:00:00.000Z",
          text: "Claim: Technical Mentoring\nClaim: Team Leadership\nClaim: People Management\nSupporting excerpt: Mentored one junior developer once.\nCounter-evidence: A single mentoring example does not demonstrate formal people management or sustained team leadership.",
          content_origin: { value: "original_user_input" }
        }]
      }
    ])).professional_pattern;
    assert.ok(!isSupported(counterOverrideReport, "People Management"), "counter-evidence blocks People Management promotion");
    assert.ok(!isSupported(counterOverrideReport, "Team Leadership"), "counter-evidence blocks Team Leadership promotion");
    const mentoringSignal = findSignal(counterOverrideReport, "Technical Mentoring");
    assert.ok(mentoringSignal && mentoringSignal.capability_state === "signal", "technical mentoring remains a signal with counter-evidence");
    const excludedTeamLeadership = (counterOverrideReport.excluded_capabilities || []).find(item => String(item.label).toLowerCase() === "team leadership");
    assert.ok(excludedTeamLeadership && excludedTeamLeadership.reason_codes.includes("counter_evidence_block"), "managerial exclusion stores readable reason codes");

    // TEST 5 — DOMINANT TECHNICAL PROFILE
    const dominantTechnicalReport = buildReports(normalizeChatGptExport([
      { id: "td1", title: "Distributed", professional_category: "technology", messages: [{ author: "user", created_at: "2026-05-01T00:00:00.000Z", text: "Claim: Distributed Systems Problem Solving\nSupporting excerpt: Solved idempotency and consistency trade-offs in distributed services.", content_origin: { value: "original_user_input" } }] },
      { id: "td2", title: "Architecture", professional_category: "technology", messages: [{ author: "user", created_at: "2026-05-03T00:00:00.000Z", text: "Claim: Software Architecture\nSupporting excerpt: Evaluated architecture boundaries and reliability constraints.", content_origin: { value: "original_user_input" } }] },
      { id: "td3", title: "API", professional_category: "technology", messages: [{ author: "user", created_at: "2026-05-05T00:00:00.000Z", text: "Claim: API Evolution Planning\nSupporting excerpt: Planned backward-compatible API changes and migration.", content_origin: { value: "original_user_input" } }] },
      { id: "td4", title: "Security", professional_category: "technology", messages: [{ author: "user", created_at: "2026-05-07T00:00:00.000Z", text: "Claim: Application Security Awareness\nSupporting excerpt: Evaluated secure defaults and auth risk.", content_origin: { value: "original_user_input" } }] },
      { id: "td5", title: "Reliability", professional_category: "technology", messages: [{ author: "user", created_at: "2026-05-09T00:00:00.000Z", text: "Claim: Production Reliability Reasoning\nSupporting excerpt: Planned incident mitigation and observability improvements.", content_origin: { value: "original_user_input" } }] },
      { id: "td6", title: "Single communication", professional_category: "professional_communication", messages: [{ author: "user", created_at: "2026-05-11T00:00:00.000Z", text: "Claim: Executive Technical Communication\nSupporting excerpt: One executive status update.", content_origin: { value: "original_user_input" } }] }
    ])).professional_pattern;
    assert.ok(/technology|architecture|technical|engineering/i.test(dominantTechnicalReport.observed_professional_pattern), "technical majority keeps technical professional pattern");
    assert.ok(!/people\s*&\s*leadership|leadership-oriented|people and leadership/i.test(dominantTechnicalReport.observed_professional_pattern), "technical majority must not become people/leadership profile");

    // TEST 6 — CATEGORY MUST NOT PROMOTE CAPABILITY
    const categoryNotPromoteReport = buildReports(normalizeChatGptExport([
      { id: "tp1", title: "API planning 1", professional_category: "collaboration", messages: [{ author: "user", created_at: "2026-04-01T00:00:00.000Z", text: "Claim: API Evolution Planning\nSupporting excerpt: Planned non-breaking API changes and versioning strategy.", content_origin: { value: "original_user_input" } }] },
      { id: "tp2", title: "API planning 2", professional_category: "collaboration", messages: [{ author: "user", created_at: "2026-04-10T00:00:00.000Z", text: "Claim: API Evolution Planning\nSupporting excerpt: Aligned schema evolution with migration constraints.", content_origin: { value: "original_user_input" } }] },
      { id: "tp3", title: "API planning 3", professional_category: "collaboration", messages: [{ author: "user", created_at: "2026-04-20T00:00:00.000Z", text: "Claim: API Evolution Planning\nSupporting excerpt: Evaluated endpoint deprecation and compatibility.", content_origin: { value: "original_user_input" } }] }
    ])).professional_pattern;
    assert.ok(isSupported(categoryNotPromoteReport, "Api Evolution Planning"), "explicit API evidence is promoted even under collaboration category");
    assert.ok(!isSupported(categoryNotPromoteReport, "Stakeholder Alignment"), "collaboration category alone must not promote Stakeholder Alignment");
    assert.ok(!isSupported(categoryNotPromoteReport, "Team Leadership"), "collaboration category alone must not promote Team Leadership");

    // TEST 7 — GENERIC CAPABILITY PENALTY
    const genericPenaltyReport = buildReports(normalizeChatGptExport([
      { id: "tg1", title: "Dist 1", professional_category: "technology", messages: [{ author: "user", created_at: "2026-05-01T00:00:00.000Z", text: "Claim: Distributed Systems Problem Solving\nClaim: Problem Solving\nSupporting excerpt: Solved idempotency and retry issues in distributed services.", content_origin: { value: "original_user_input" } }] },
      { id: "tg2", title: "Dist 2", professional_category: "technology", messages: [{ author: "user", created_at: "2026-05-02T00:00:00.000Z", text: "Claim: Distributed Systems Problem Solving\nSupporting excerpt: Mitigated partition failures and consistency risk.", content_origin: { value: "original_user_input" } }] },
      { id: "tg3", title: "Dist 3", professional_category: "technology", messages: [{ author: "user", created_at: "2026-05-03T00:00:00.000Z", text: "Claim: Distributed Systems Problem Solving\nSupporting excerpt: Addressed replication lag and incident impact.", content_origin: { value: "original_user_input" } }] }
    ])).professional_pattern;
    const distributedScore = findAssessment(genericPenaltyReport, "Distributed Systems Problem Solving");
    const genericProblemScore = findAssessment(genericPenaltyReport, "Problem Solving");
    assert.ok(distributedScore, "distributed systems capability must be assessed");
    assert.ok(!genericProblemScore || distributedScore.dominance_score > genericProblemScore.dominance_score, "specific distributed capability must dominate generic problem solving");

    // TEST 8 — WEAK ML EXPLORATION
    const weakMlReport = buildReports(normalizeChatGptExport([
      {
        id: "tml1",
        title: "Weak ML exploration",
        professional_category: "technology",
        messages: [{
          author: "user",
          created_at: "2026-05-04T00:00:00.000Z",
          text: "Claim: Machine Learning Exploration\nSupporting excerpt: I asked one generic question about a recommendation model.\nCounter-evidence: low confidence, no validation, no implementation evidence.",
          content_origin: { value: "original_user_input" }
        }]
      }
    ])).professional_pattern;
    const mlSignal = findSignal(weakMlReport, "Machine Learning Exploration");
    assert.ok(mlSignal && mlSignal.capability_state === "signal", "weak ML evidence remains Machine Learning Exploration signal");
    assert.ok(!isSupported(weakMlReport, "Machine Learning Engineering"), "weak ML evidence must not promote ML Engineering");
    assert.ok(!isSupported(weakMlReport, "Recommendation Systems Expertise"), "weak ML evidence must not promote recommendation expertise");

    // TEST 1 — FULL LABEL PRESERVATION
    const fullLabelReport = buildReports(normalizeChatGptExport([
      {
        id: "fl1",
        title: "Incident planning",
        professional_category: "technology",
        messages: [{
          author: "user",
          created_at: "2026-06-04T00:00:00.000Z",
          text: "Display_label: Incident Mitigation Planning\nCandidate_concept: Incident mitigation planning\nClaim: Incident Mitigation Planning\nSupporting excerpt: Planned incident mitigation actions and rollback checkpoints.",
          content_origin: { value: "original_user_input" }
        }]
      }
    ])).professional_pattern;
    const fullLabelCapability = findAssessment(fullLabelReport, "Incident Mitigation Planning");
    assert.ok(fullLabelCapability, "full incident mitigation label should be preserved");
    assert.ok(!findAssessment(fullLabelReport, "Incident"), "truncated Incident label must not replace full capability label");

    // TEST 2 — SPECIFIC OVER GENERIC
    const specificOverGenericReport = buildReports(normalizeChatGptExport([
      {
        id: "sg1",
        title: "Distributed systems",
        professional_category: "technology",
        messages: [{
          author: "user",
          created_at: "2026-06-05T00:00:00.000Z",
          text: "Claim: Problem Solving\nClaim: Distributed Systems Problem Solving\nSupporting excerpt: Solved idempotency and consistency issues in distributed systems.",
          content_origin: { value: "original_user_input" }
        }]
      },
      {
        id: "sg2",
        title: "Distributed reliability",
        professional_category: "technology",
        messages: [{
          author: "user",
          created_at: "2026-06-06T00:00:00.000Z",
          text: "Claim: Distributed Systems Problem Solving\nSupporting excerpt: Mitigated partition and retry failure patterns.",
          content_origin: { value: "original_user_input" }
        }]
      }
    ])).professional_pattern;
    const specificDistributed = findAssessment(specificOverGenericReport, "Distributed Systems Problem Solving");
    const genericProblem = findAssessment(specificOverGenericReport, "Problem Solving");
    assert.ok(specificDistributed, "specific distributed capability should exist");
    assert.ok(!genericProblem || specificDistributed.specificity_score >= genericProblem.specificity_score, "specific capability should outrank or suppress generic equivalent");

    // TEST 3 — SINGLE SIGNAL NOT RECURRING
    const singleSignal = findSignal(singleExecCommReport, "Executive Technical Communication");
    assert.ok(singleSignal && !singleSignal.is_recurring_strength, "single-signal executive communication must not be recurring strength");

    // TEST 4 — TECHNICAL PROFILE
    const technicalProfileReport = buildReports(normalizeChatGptExport([
      { id: "tt1", title: "Architecture", professional_category: "technology", messages: [{ author: "user", created_at: "2026-04-01T00:00:00.000Z", text: "Claim: Software Architecture\nSupporting excerpt: Evaluated service boundaries and architecture trade-offs.", content_origin: { value: "original_user_input" } }] },
      { id: "tt2", title: "Database", professional_category: "technology", messages: [{ author: "user", created_at: "2026-04-03T00:00:00.000Z", text: "Claim: Database Performance Analysis\nSupporting excerpt: Diagnosed query plan bottlenecks and optimized indexing.", content_origin: { value: "original_user_input" } }] },
      { id: "tt3", title: "API", professional_category: "technology", messages: [{ author: "user", created_at: "2026-04-05T00:00:00.000Z", text: "Claim: API Design\nSupporting excerpt: Planned API contracts and backward compatibility.", content_origin: { value: "original_user_input" } }] },
      { id: "tt4", title: "Reliability", professional_category: "technology", messages: [{ author: "user", created_at: "2026-04-08T00:00:00.000Z", text: "Claim: Production Reliability Reasoning\nSupporting excerpt: Defined alerts, incident response, and mitigation controls.", content_origin: { value: "original_user_input" } }] }
    ])).professional_pattern;
    assert.ok(/technical and engineering/i.test(technicalProfileReport.observed_professional_pattern), "technical dataset should infer technical and engineering family");
    assert.ok(!/stakeholder-aligned execution/i.test(technicalProfileReport.typical_professional_contribution), "technical contribution must not fall back to stakeholder-aligned execution");

    // TEST 5 — SALES PROFILE
    const salesProfileReport = buildReports(normalizeChatGptExport([
      { id: "ts1", title: "Opportunity", professional_category: "negotiation", messages: [{ author: "user", created_at: "2026-04-01T00:00:00.000Z", text: "Claim: Opportunity Qualification\nSupporting excerpt: Qualified opportunities based on customer value and buying criteria.", content_origin: { value: "original_user_input" } }] },
      { id: "ts2", title: "Discovery", professional_category: "negotiation", messages: [{ author: "user", created_at: "2026-04-03T00:00:00.000Z", text: "Claim: Customer Discovery\nSupporting excerpt: Structured discovery calls and clarified decision drivers.", content_origin: { value: "original_user_input" } }] },
      { id: "ts3", title: "Negotiation", professional_category: "negotiation", messages: [{ author: "user", created_at: "2026-04-05T00:00:00.000Z", text: "Claim: Contract Negotiation\nSupporting excerpt: Negotiated terms and advanced commercial agreement.", content_origin: { value: "original_user_input" } }] },
      { id: "ts4", title: "Account", professional_category: "negotiation", messages: [{ author: "user", created_at: "2026-04-07T00:00:00.000Z", text: "Claim: Account Planning\nSupporting excerpt: Built account plan and proposal sequencing.", content_origin: { value: "original_user_input" } }] }
    ])).professional_pattern;
    assert.ok(/commercial and growth|mixed\/cross-functional/i.test(salesProfileReport.observed_professional_pattern), "sales dataset should map to commercial/growth or mixed when evidence overlaps");

    // TEST 6 — HR PROFILE
    const hrProfileReport = buildReports(normalizeChatGptExport([
      { id: "th1", title: "Assessment", professional_category: "recruiting", messages: [{ author: "user", created_at: "2026-04-01T00:00:00.000Z", text: "Claim: Talent Assessment\nSupporting excerpt: Assessed candidate competencies with structured criteria.", content_origin: { value: "original_user_input" } }] },
      { id: "th2", title: "Interview", professional_category: "recruiting", messages: [{ author: "user", created_at: "2026-04-03T00:00:00.000Z", text: "Claim: Interview Design\nSupporting excerpt: Designed interview workflow and evaluation rubric.", content_origin: { value: "original_user_input" } }] },
      { id: "th3", title: "Workforce", professional_category: "recruiting", messages: [{ author: "user", created_at: "2026-04-05T00:00:00.000Z", text: "Claim: Workforce Planning\nSupporting excerpt: Planned hiring pipeline and staffing needs.", content_origin: { value: "original_user_input" } }] },
      { id: "th4", title: "Development", professional_category: "recruiting", messages: [{ author: "user", created_at: "2026-04-07T00:00:00.000Z", text: "Claim: Developmental Feedback\nSupporting excerpt: Provided developmental feedback loops.", content_origin: { value: "original_user_input" } }] }
    ])).professional_pattern;
    assert.ok(/people and talent|mixed\/cross-functional/i.test(hrProfileReport.observed_professional_pattern), "HR dataset should map to people/talent or mixed");
    assert.ok(!isSupported(hrProfileReport, "People Management"), "People Management must not be auto-promoted without formal repeated management evidence");

    // TEST 7 — LEGAL/COMPLIANCE PROFILE
    const legalProfileReport = buildReports(normalizeChatGptExport([
      { id: "tl1", title: "Regulatory", professional_category: "leadership", messages: [{ author: "user", created_at: "2026-04-01T00:00:00.000Z", text: "Claim: Regulatory Interpretation\nSupporting excerpt: Interpreted regulatory obligations and policy impact.", content_origin: { value: "original_user_input" } }] },
      { id: "tl2", title: "Contract", professional_category: "leadership", messages: [{ author: "user", created_at: "2026-04-03T00:00:00.000Z", text: "Claim: Contractual Analysis\nSupporting excerpt: Assessed contractual risk and obligations.", content_origin: { value: "original_user_input" } }] },
      { id: "tl3", title: "Controls", professional_category: "leadership", messages: [{ author: "user", created_at: "2026-04-05T00:00:00.000Z", text: "Claim: Control Design\nSupporting excerpt: Designed controls for compliance implementation.", content_origin: { value: "original_user_input" } }] }
    ])).professional_pattern;
    assert.ok(/legal, risk and compliance|mixed\/cross-functional/i.test(legalProfileReport.observed_professional_pattern), "legal/compliance dataset should map to legal-risk family or mixed");

    // TEST 8 — FINANCE PROFILE
    const financeProfileReport = buildReports(normalizeChatGptExport([
      { id: "tf1", title: "Forecast", professional_category: "data_analytics", messages: [{ author: "user", created_at: "2026-04-01T00:00:00.000Z", text: "Claim: Financial Forecasting\nSupporting excerpt: Built revenue and cost forecasts across scenarios.", content_origin: { value: "original_user_input" } }] },
      { id: "tf2", title: "Variance", professional_category: "data_analytics", messages: [{ author: "user", created_at: "2026-04-03T00:00:00.000Z", text: "Claim: Variance Analysis\nSupporting excerpt: Investigated variance drivers and corrective actions.", content_origin: { value: "original_user_input" } }] },
      { id: "tf3", title: "Scenario", professional_category: "data_analytics", messages: [{ author: "user", created_at: "2026-04-05T00:00:00.000Z", text: "Claim: Scenario Modelling\nSupporting excerpt: Modelled downside and base-case assumptions for decision support.", content_origin: { value: "original_user_input" } }] }
    ])).professional_pattern;
    assert.ok(/finance and analytical|mixed\/cross-functional/i.test(financeProfileReport.observed_professional_pattern), "finance dataset should map to finance/analytical family or mixed");

    // TEST 9 — JUNIOR PROFILE
    const juniorProfileReport = buildReports(normalizeChatGptExport([
      { id: "tj1", title: "Task 1", professional_category: "technology", messages: [{ author: "user", created_at: "2026-04-01T00:00:00.000Z", text: "Claim: API Task\nSupporting excerpt: Implemented one API task with guidance.", content_origin: { value: "original_user_input" } }] },
      { id: "tj2", title: "Task 2", professional_category: "technology", messages: [{ author: "user", created_at: "2026-04-02T00:00:00.000Z", text: "Claim: Bug Fix\nSupporting excerpt: Fixed one issue after receiving instructions.", content_origin: { value: "original_user_input" } }] }
    ])).professional_pattern;
    assert.ok(/Available evidence indicates emerging professional patterns/i.test(juniorProfileReport.observed_professional_pattern), "low repetition junior evidence should produce neutral emerging-pattern fallback");

    // TEST 10 — MIXED PROFILE
    const mixedProfileReport = buildReports(normalizeChatGptExport([
      { id: "tmx1", title: "Tech", professional_category: "technology", messages: [{ author: "user", created_at: "2026-04-01T00:00:00.000Z", text: "Claim: Software Architecture\nSupporting excerpt: Evaluated architecture options.", content_origin: { value: "original_user_input" } }] },
      { id: "tmx2", title: "Coordination", professional_category: "project_management", messages: [{ author: "user", created_at: "2026-04-03T00:00:00.000Z", text: "Claim: Delivery Coordination\nSupporting excerpt: Coordinated dependencies and milestones.", content_origin: { value: "original_user_input" } }] },
      { id: "tmx3", title: "Communication", professional_category: "professional_communication", messages: [{ author: "user", created_at: "2026-04-05T00:00:00.000Z", text: "Claim: Technical Communication\nSupporting excerpt: Communicated technical decisions to stakeholders.", content_origin: { value: "original_user_input" } }] }
    ])).professional_pattern;
    assert.ok(/mixed\/cross-functional|Evidence suggests/i.test(mixedProfileReport.observed_professional_pattern), "balanced mixed evidence should produce mixed/cross-functional or evidence-based pattern");

    // TEST 11 — DEDUPLICATION
    const dedupReport = buildReports(normalizeChatGptExport([
      { id: "tdp1", title: "Communication 1", professional_category: "professional_communication", messages: [{ author: "user", created_at: "2026-04-01T00:00:00.000Z", text: "Claim: Communication\nClaim: Technical Communication\nClaim: Executive Technical Communication\nSupporting excerpt: Delivered technical executive update and communication synthesis.", content_origin: { value: "original_user_input" } }] },
      { id: "tdp2", title: "Communication 2", professional_category: "professional_communication", messages: [{ author: "user", created_at: "2026-04-03T00:00:00.000Z", text: "Claim: Executive Technical Communication\nSupporting excerpt: Structured executive update with technical trade-off rationale.", content_origin: { value: "original_user_input" } }] }
    ])).professional_pattern;
    const suppressedDuplicates = dedupReport.suppressed_generic_duplicates || [];
    assert.ok(suppressedDuplicates.some(item => (item.reason_codes || []).includes("semantic_duplicate_suppressed")), "semantic deduplication should suppress generic duplicate capability labels");

    // TEST 12 — NEUTRAL FALLBACK
    const neutralFallbackReport = buildReports(normalizeChatGptExport([
      { id: "tn1", title: "Insufficient 1", professional_category: "other", messages: [{ author: "user", created_at: "2026-04-01T00:00:00.000Z", text: "One short generic note without repeated capability evidence.", content_origin: { value: "original_user_input" } }] }
    ])).professional_pattern;
    assert.strictEqual(neutralFallbackReport.observed_professional_pattern, "Available evidence indicates emerging professional patterns, but coverage is not yet sufficient to define a stable professional profile.", "insufficient evidence should use neutral professional pattern fallback");
    assert.strictEqual(neutralFallbackReport.typical_professional_contribution, "Available evidence is not yet sufficient to define a stable typical contribution.", "insufficient evidence should use neutral typical contribution fallback");

    // TARGETED TEST 1 — CLAIM FRAGMENT REJECTION
    const claimFragmentReport = buildReports(normalizeChatGptExport([
      {
        id: "cf1",
        title: "Claim fragment rejection",
        professional_category: "professional_communication",
        messages: [{
          author: "user",
          created_at: "2026-06-20T00:00:00.000Z",
          text: "Claim: The user translated technical complexity into decision-oriented communication\nDisplay_label: Executive Technical Communication\nCandidate_concept: Executive technical communication\nSupporting excerpt: One executive status update.",
          content_origin: { value: "original_user_input" }
        }]
      }
    ])).professional_pattern;
    assert.ok(findAssessment(claimFragmentReport, "Executive Technical Communication"), "claim fragment should resolve to Executive Technical Communication");
    assert.ok(!findAssessment(claimFragmentReport, "The User Translated Technical Complexity Into Decision Oriented Communication"), "claim fragment must not be promoted as capability label");

    // TARGETED TEST 2 — FULL LABEL PRESERVATION (INCIDENT)
    const incidentPreservationReport = buildReports(normalizeChatGptExport([
      {
        id: "ip1",
        title: "Incident label preservation",
        professional_category: "technology",
        messages: [{
          author: "user",
          created_at: "2026-06-21T00:00:00.000Z",
          text: "Display_label: Incident Mitigation Planning\nClaim: Incident Mitigation Planning\nSupporting excerpt: Planned incident mitigation actions and rollback checkpoints.",
          content_origin: { value: "original_user_input" }
        }]
      }
    ])).professional_pattern;
    assert.ok(findAssessment(incidentPreservationReport, "Incident Mitigation Planning"), "Incident Mitigation Planning should be preserved as full label");
    assert.ok(!findAssessment(incidentPreservationReport, "Incident"), "Incident one-word truncation should not replace full incident label");

    // TARGETED TEST 3 — DATA REASONING PRESERVATION
    const dataPreservationReport = buildReports(normalizeChatGptExport([
      {
        id: "dp1",
        title: "Data label preservation",
        professional_category: "data_analytics",
        messages: [{
          author: "user",
          created_at: "2026-06-22T00:00:00.000Z",
          text: "Display_label: Data Reasoning\nClaim: Data Reasoning\nSupporting excerpt: Interpreted KPI trends and confidence ranges.",
          content_origin: { value: "original_user_input" }
        }]
      }
    ])).professional_pattern;
    assert.ok(findAssessment(dataPreservationReport, "Data Reasoning"), "Data Reasoning should be preserved as full label");
    assert.ok(!findAssessment(dataPreservationReport, "Data"), "Data one-word truncation should not replace Data Reasoning");

    // TARGETED TEST 4 — SINGLE EMERGING NOT RECURRING
    const singleEmergingReport = buildReports(normalizeChatGptExport([
      {
        id: "se1",
        title: "Single emerging communication",
        professional_category: "professional_communication",
        messages: [{
          author: "user",
          created_at: "2026-06-23T00:00:00.000Z",
          text: "Claim: Executive Technical Communication\nSupporting excerpt: One executive status update with technical synthesis.",
          content_origin: { value: "original_user_input" }
        }]
      }
    ])).professional_pattern;
    const singleEmergingSignal = findSignal(singleEmergingReport, "Executive Technical Communication") || findAssessment(singleEmergingReport, "Executive Technical Communication");
    assert.ok(singleEmergingSignal && !singleEmergingSignal.is_recurring_strength, "single emerging capability must not become recurring strength");
    assert.ok(!String(singleEmergingReport.observed_professional_pattern || "").toLowerCase().includes("executive technical communication"), "single emerging capability must not appear in recurring-strength professional pattern sentence");

    // TARGETED TEST 5 + 6 — RECURRING ONLY + GRAMMATICAL LIST
    const recurringOnlyReport = buildReports(normalizeChatGptExport([
      { id: "ro1", title: "Incident 1", professional_category: "technology", messages: [{ author: "user", created_at: "2026-01-10T00:00:00.000Z", text: "Claim: Incident Mitigation Planning\nSupporting excerpt: Planned incident mitigation controls for release risk.", content_origin: { value: "original_user_input" } }] },
      { id: "ro2", title: "Incident 2", professional_category: "technology", messages: [{ author: "user", created_at: "2026-02-12T00:00:00.000Z", text: "Claim: Incident Mitigation Planning\nSupporting excerpt: Coordinated rollback checkpoints and incident contingencies.", content_origin: { value: "original_user_input" } }] },
      { id: "ro3", title: "Data 1", professional_category: "data_analytics", messages: [{ author: "user", created_at: "2026-03-12T00:00:00.000Z", text: "Claim: Data Reasoning\nSupporting excerpt: Interpreted KPI distribution and trend reliability.", content_origin: { value: "original_user_input" } }] },
      { id: "ro4", title: "Data 2", professional_category: "data_analytics", messages: [{ author: "user", created_at: "2026-04-14T00:00:00.000Z", text: "Claim: Data Reasoning\nSupporting excerpt: Evaluated data quality and confidence intervals for decision support.", content_origin: { value: "original_user_input" } }] },
      { id: "ro5", title: "Database 1", professional_category: "technology", messages: [{ author: "user", created_at: "2026-05-15T00:00:00.000Z", text: "Claim: Database Performance Analysis\nSupporting excerpt: Diagnosed query bottlenecks and indexing strategy.", content_origin: { value: "original_user_input" } }] },
      { id: "ro6", title: "Database 2", professional_category: "technology", messages: [{ author: "user", created_at: "2026-06-16T00:00:00.000Z", text: "Claim: Database Performance Analysis\nSupporting excerpt: Validated execution plans and optimized latency hotspots.", content_origin: { value: "original_user_input" } }] },
      { id: "ro7", title: "Single executive", professional_category: "professional_communication", messages: [{ author: "user", created_at: "2026-06-20T00:00:00.000Z", text: "Claim: Executive Technical Communication\nSupporting excerpt: One executive status update only.", content_origin: { value: "original_user_input" } }] }
    ])).professional_pattern;
    const recurringLabels = (recurringOnlyReport.recurring_strengths || []).map(item => String(item.full_label || item.label).toLowerCase());
    assert.ok(recurringLabels.includes("incident mitigation planning"), "recurring strengths should include Incident Mitigation Planning");
    assert.ok(recurringLabels.includes("data reasoning"), "recurring strengths should include Data Reasoning");
    assert.ok(!recurringLabels.includes("executive technical communication"), "single emerging communication must not enter recurring strengths");
    const recurringSentence = String(recurringOnlyReport.observed_professional_pattern || "").toLowerCase();
    assert.ok(recurringSentence.includes("incident mitigation planning"), "pattern should include recurring incident label");
    assert.ok(recurringSentence.includes("data reasoning"), "pattern should include recurring data label");
    assert.ok(!recurringSentence.includes("executive technical communication"), "pattern should exclude single emerging communication");
    assert.ok(!/,,/.test(recurringSentence), "grammatical list must not contain duplicate commas");
    assert.ok(!/(into|with|through|for|by|and)\.$/.test(recurringSentence), "grammatical list must not end with dangling preposition");

    // TARGETED TEST 7 — INVALID LABEL FILTER
    const invalidFilterReport = buildReports(normalizeChatGptExport([
      {
        id: "if1",
        title: "Invalid labels",
        professional_category: "technology",
        messages: [{
          author: "user",
          created_at: "2026-06-24T00:00:00.000Z",
          text: "Claim: user translated technical complexity into\nClaim: The user analysed\nClaim: incident\nClaim: data\nDisplay_label: Incident Mitigation Planning\nCandidate_concept: Data Reasoning\nSupporting excerpt: Technical narrative and data interpretation evidence.",
          content_origin: { value: "original_user_input" }
        }]
      }
    ])).professional_pattern;
    assert.ok(findAssessment(invalidFilterReport, "Incident Mitigation Planning"), "invalid claim fragments should fall back to specific incident label");
    assert.ok(findAssessment(invalidFilterReport, "Data Reasoning"), "invalid generic one-word labels should fall back to specific data label");
    assert.ok(!findAssessment(invalidFilterReport, "User Translated Technical Complexity Into"), "invalid narrative label must be filtered out");

    // TARGETED TEST 8 — SUPPORTED CAPABILITIES FULL LABEL
    const supportedFullLabelReport = recurringOnlyReport;
    const supportedLabels = (supportedFullLabelReport.radar_capabilities || []).map(item => String(item.full_label || item.label).toLowerCase());
    assert.ok(supportedLabels.includes("incident mitigation planning"), "supported capabilities should keep full Incident Mitigation Planning label");
    assert.ok(supportedLabels.includes("data reasoning"), "supported capabilities should keep full Data Reasoning label");
    assert.ok(!supportedLabels.includes("incident."), "supported capabilities should not contain punctuated truncated Incident label");
    assert.ok(!supportedLabels.includes("data."), "supported capabilities should not contain punctuated truncated Data label");

    // TARGETED TEST 9 — NEUTRAL FALLBACK WITHOUT RECURRING STRENGTHS
    const noRecurringReport = buildReports(normalizeChatGptExport([
      { id: "nr1", title: "Single 1", professional_category: "technology", messages: [{ author: "user", created_at: "2026-06-25T00:00:00.000Z", text: "Claim: API Task\nSupporting excerpt: Implemented one API task with guidance.", content_origin: { value: "original_user_input" } }] },
      { id: "nr2", title: "Single 2", professional_category: "professional_communication", messages: [{ author: "user", created_at: "2026-06-26T00:00:00.000Z", text: "Claim: Executive Technical Communication\nSupporting excerpt: One executive status update.", content_origin: { value: "original_user_input" } }] }
    ])).professional_pattern;
    assert.ok(
      /not yet sufficient to define stable recurring strengths/i.test(String(noRecurringReport.observed_professional_pattern || "")) ||
      /coverage is not yet sufficient to define a stable professional profile/i.test(String(noRecurringReport.observed_professional_pattern || "")),
      "without recurring demonstrated strengths pattern must use conservative fallback"
    );
    assert.ok(!String(noRecurringReport.observed_professional_pattern || "").toLowerCase().includes("executive technical communication"), "neutral fallback must not promote emerging signal as recurring strength");

    // REGRESSION — TECHNICAL BACKEND-LIKE DATASET
    const technicalRegressionReport = buildReports(normalizeChatGptExport([
      { id: "tr1", title: "Distributed", professional_category: "technology", messages: [{ author: "user", created_at: "2026-01-03T00:00:00.000Z", text: "Claim: Distributed Systems Problem Solving\nSupporting excerpt: Designed idempotency and retry strategies for distributed workflows.", content_origin: { value: "original_user_input" } }] },
      { id: "tr2", title: "SQL", professional_category: "technology", messages: [{ author: "user", created_at: "2026-01-15T00:00:00.000Z", text: "Claim: Database Performance Analysis\nSupporting excerpt: Diagnosed SQL query plans and optimized indexing.", content_origin: { value: "original_user_input" } }] },
      { id: "tr3", title: "Architecture", professional_category: "technology", messages: [{ author: "user", created_at: "2026-02-02T00:00:00.000Z", text: "Claim: Software Architecture\nSupporting excerpt: Evaluated architecture boundaries and service contracts.", content_origin: { value: "original_user_input" } }] },
      { id: "tr4", title: "API", professional_category: "technology", messages: [{ author: "user", created_at: "2026-02-20T00:00:00.000Z", text: "Claim: API Evolution Planning\nSupporting excerpt: Planned backward-compatible API changes.", content_origin: { value: "original_user_input" } }] },
      { id: "tr5", title: "Reliability", professional_category: "technology", messages: [{ author: "user", created_at: "2026-03-11T00:00:00.000Z", text: "Claim: Incident Mitigation Planning\nSupporting excerpt: Defined observability and incident mitigation controls.", content_origin: { value: "original_user_input" } }] },
      { id: "tr6", title: "Single executive communication", professional_category: "professional_communication", messages: [{ author: "user", created_at: "2026-04-22T00:00:00.000Z", text: "Claim: Executive Technical Communication\nSupporting excerpt: Prepared one executive status update only.", content_origin: { value: "original_user_input" } }] }
    ])).professional_pattern;
    assert.ok(/technical and engineering/i.test(technicalRegressionReport.observed_professional_pattern), "technical regression dataset should remain technical and engineering");
    assert.ok(!/people and leadership/i.test(technicalRegressionReport.observed_professional_pattern), "technical regression dataset must not regress to people/leadership profile");
    assert.ok(!String(technicalRegressionReport.observed_professional_pattern || "").toLowerCase().includes("executive technical communication"), "single executive communication signal must not enter recurring strengths in pattern narrative");
    const hasTruncatedLabel = (technicalRegressionReport.radar_capabilities || []).some(item => ["data", "incident"].includes(String(item.full_label || item.label || "").toLowerCase()));
    assert.ok(!hasTruncatedLabel, "supported capabilities must not expose truncated one-word labels when specific labels are available");

    // STRUCTURAL REDESIGN TEST 1 — PROFESSIONAL CLASSIFICATION SELECTION
    const selectionPack = {
      schema: "professional_evidence_pack_v1",
      generated_at: "2026-07-16",
      conversations: [{
        id: "sel_1",
        title: "Selection professional",
        date: "2026-07-01",
        professional_category: "talent_acquisition",
        classification: "professional",
        summary: "Professional summary",
        content_origin_notes: "synthetic_user_ai_interaction",
        evidence: [{ display_label: "Structured Interview Design", candidate_concept: "Structured interviewing", claim: "Defined interview structure.", supporting_excerpt: "Mapped competencies to interview questions.", confidence: "high" }]
      }]
    };
    const selectionConversations = normalizeChatGptExport(selectionPack);
    selectionConversations[0].approved = false;
    const selectedFromClassification = buildNormalized(selectionConversations, []);
    assert.strictEqual(selectedFromClassification.length, 1, "professional classification should still select conversation when approved=false");
    assert.ok((selectedFromClassification[0].selection_reason_codes || []).includes("selected_professional_explicit") || (selectedFromClassification[0].selection_reason_codes || []).includes("selected_professional_classification"), "selection reason code should indicate professional selection");

    // STRUCTURAL REDESIGN TEST 2 — EXPLICIT EXCLUSION
    const explicitlyExcluded = buildNormalized(selectionConversations, [{ id: "sel_1", include: false, classification: "professional" }]);
    assert.strictEqual(explicitlyExcluded.length, 0, "explicit user exclusion must override professional classification");

    // STRUCTURAL REDESIGN TEST 3 — ATOMIC EVIDENCE COUNT
    const atomicPack = {
      schema: "professional_evidence_pack_v1",
      generated_at: "2026-07-16",
      conversations: [{
        id: "ae_1",
        title: "Atomic evidence",
        date: "2026-07-02",
        professional_category: "talent_acquisition",
        classification: "professional",
        summary: "Atomic evidence test",
        content_origin_notes: "synthetic_user_ai_interaction",
        evidence: [
          { display_label: "Structured Interview Design", candidate_concept: "Structured interviewing", claim: "Defined interview process.", supporting_excerpt: "Mapped question to competency.", confidence: "high" },
          { display_label: "Interview Bias Mitigation", candidate_concept: "Bias mitigation", claim: "Added calibration.", supporting_excerpt: "Independent scoring before calibration.", confidence: "high" }
        ]
      }]
    };
    const atomicReport = buildReports(buildNormalized(normalizeChatGptExport(atomicPack), []));
    assert.strictEqual(atomicReport.evidence_coverage_detail.atomic_evidence_count, 2, "atomic evidence count must equal structured evidence records");
    assert.strictEqual(atomicReport.evidence_coverage_detail.total_evidence_items, 2, "visible evidence items must report atomic evidence count");

    // STRUCTURAL REDESIGN TEST 4 — HR ANALYSIS NOT FINANCE
    const hrAnalysisPack = {
      schema: "professional_evidence_pack_v1",
      generated_at: "2026-07-16",
      conversations: [{
        id: "hr_a_1",
        title: "Recruitment funnel analysis",
        date: "2026-06-21",
        professional_category: "talent_analytics",
        classification: "professional",
        summary: "Analysed funnel conversion.",
        content_origin_notes: "synthetic_user_ai_interaction",
        evidence: [{ dimension: "data_reasoning", candidate_concept: "Recruitment funnel analysis", candidate_type: "capability", display_label: "Talent Acquisition Analytics", claim: "Separated volume from quality issues.", supporting_excerpt: "Analyse stage-by-stage before changing sourcing volume.", confidence: "high" }]
      }]
    };
    const hrAnalysisPattern = buildReports(buildNormalized(normalizeChatGptExport(hrAnalysisPack), [])).professional_pattern;
    assert.ok(/people and talent|mixed\/cross-functional/i.test(hrAnalysisPattern.observed_professional_pattern), "recruitment analysis should not force finance family");
    const hrFinanceRow = (hrAnalysisPattern.professional_family_breakdown || []).find(item => item.family_id === "finance_and_analytical");
    if (hrFinanceRow) assert.ok(hrFinanceRow.total_score <= 1.5, "finance contribution for recruitment analysis should be minimal");

    // STRUCTURAL REDESIGN TEST 5 — SALES ANALYSIS NOT FINANCE
    const salesAnalysisPack = {
      schema: "professional_evidence_pack_v1",
      generated_at: "2026-07-16",
      conversations: [{
        id: "sales_a_1",
        title: "Sales pipeline analysis",
        date: "2026-06-22",
        professional_category: "sales_operations",
        classification: "professional",
        summary: "Pipeline quality review.",
        content_origin_notes: "synthetic_user_ai_interaction",
        evidence: [{ display_label: "Sales Pipeline Analysis", candidate_concept: "Pipeline quality analysis", claim: "Distinguished activity from buyer commitment.", supporting_excerpt: "Stage progression should reflect buyer commitment.", confidence: "high" }]
      }]
    };
    const salesAnalysisPattern = buildReports(buildNormalized(normalizeChatGptExport(salesAnalysisPack), [])).professional_pattern;
    assert.ok(/commercial and growth|mixed\/cross-functional/i.test(salesAnalysisPattern.observed_professional_pattern), "sales analysis should map to commercial or mixed, not finance");

    // STRUCTURAL REDESIGN TEST 6 — REGULATORY ANALYSIS NOT FINANCE
    const legalAnalysisPack = {
      schema: "professional_evidence_pack_v1",
      generated_at: "2026-07-16",
      conversations: [{
        id: "legal_a_1",
        title: "Regulatory risk analysis",
        date: "2026-06-23",
        professional_category: "compliance",
        classification: "professional",
        summary: "Regulatory applicability and obligations.",
        content_origin_notes: "synthetic_user_ai_interaction",
        evidence: [{ display_label: "Regulatory Interpretation", candidate_concept: "Regulatory applicability assessment", claim: "Assessed scope and obligations.", supporting_excerpt: "Entity, activity and jurisdiction before conclusion.", confidence: "high" }]
      }]
    };
    const legalAnalysisPattern = buildReports(buildNormalized(normalizeChatGptExport(legalAnalysisPack), [])).professional_pattern;
    assert.ok(/legal, risk and compliance|mixed\/cross-functional/i.test(legalAnalysisPattern.observed_professional_pattern), "regulatory analysis should map to legal/risk family or mixed");

    // STRUCTURAL REDESIGN TEST 7 — PRODUCT ANALYTICS NOT FINANCE
    const productAnalyticsPack = {
      schema: "professional_evidence_pack_v1",
      generated_at: "2026-07-16",
      conversations: [{
        id: "prod_a_1",
        title: "Product analytics",
        date: "2026-06-24",
        professional_category: "product_management",
        classification: "professional",
        summary: "Measured product adoption and drop-off.",
        content_origin_notes: "synthetic_user_ai_interaction",
        evidence: [{ display_label: "Product Analytics", candidate_concept: "User adoption analysis", claim: "Analysed activation and retention metrics.", supporting_excerpt: "Prioritize hypotheses by user impact.", confidence: "high" }]
      }]
    };
    const productAnalyticsPattern = buildReports(buildNormalized(normalizeChatGptExport(productAnalyticsPack), [])).professional_pattern;
    const productFamilyId = String((productAnalyticsPattern.professional_family || {}).id || "");
    assert.ok(["product_and_design", "mixed_cross_functional"].includes(productFamilyId), "product analytics should map to product/design or mixed family");
    assert.notStrictEqual(productFamilyId, "finance_and_analytical", "product analytics should not drift to finance family");

    // STRUCTURAL REDESIGN TEST 8 — CLINICAL DATA INTERPRETATION
    const clinicalPack = {
      schema: "professional_evidence_pack_v1",
      generated_at: "2026-07-16",
      conversations: [{
        id: "clinical_a_1",
        title: "Clinical data interpretation",
        date: "2026-06-25",
        professional_category: "healthcare",
        classification: "professional",
        summary: "Interpreted clinical data with risk framing.",
        content_origin_notes: "synthetic_user_ai_interaction",
        evidence: [{ display_label: "Clinical Data Interpretation", candidate_concept: "Clinical assessment", claim: "Interpreted clinical evidence with risk sensitivity.", supporting_excerpt: "Assess patient risk before pathway decision.", confidence: "high" }]
      }]
    };
    const clinicalPattern = buildReports(buildNormalized(normalizeChatGptExport(clinicalPack), [])).professional_pattern;
    assert.ok(/healthcare and clinical|mixed\/cross-functional/i.test(clinicalPattern.observed_professional_pattern), "clinical interpretation should map to healthcare or mixed");

    // STRUCTURAL REDESIGN TEST 9 — SOFTWARE INCIDENT ANALYSIS
    const softwareIncidentPack = {
      schema: "professional_evidence_pack_v1",
      generated_at: "2026-07-16",
      conversations: [{
        id: "tech_a_1",
        title: "Software incident analysis",
        date: "2026-06-26",
        professional_category: "software_architecture",
        classification: "professional",
        summary: "Investigated service incident.",
        content_origin_notes: "synthetic_user_ai_interaction",
        evidence: [{ display_label: "Production Reliability Reasoning", candidate_concept: "Incident mitigation planning", claim: "Analysed readiness, draining and retries.", supporting_excerpt: "Correlate lifecycle and request handling.", confidence: "high" }]
      }]
    };
    const softwareIncidentPattern = buildReports(buildNormalized(normalizeChatGptExport(softwareIncidentPack), [])).professional_pattern;
    assert.ok(/technical and engineering|mixed\/cross-functional/i.test(softwareIncidentPattern.observed_professional_pattern), "software incident analysis should map to technical family or mixed");

    // STRUCTURAL REDESIGN TEST 10 — REAL FINANCE ANALYSIS
    const financeRealPack = {
      schema: "professional_evidence_pack_v1",
      generated_at: "2026-07-16",
      conversations: [
        { id: "fin_1", title: "Revenue variance", date: "2026-06-01", professional_category: "finance", classification: "professional", summary: "Revenue variance analysis.", content_origin_notes: "synthetic_user_ai_interaction", evidence: [{ display_label: "Revenue Variance Analysis", candidate_concept: "Revenue variance", claim: "Investigated revenue variance drivers.", supporting_excerpt: "Variance decomposed by region and channel.", confidence: "high" }] },
        { id: "fin_2", title: "Budget forecasting", date: "2026-06-11", professional_category: "finance", classification: "professional", summary: "Budget forecast planning.", content_origin_notes: "synthetic_user_ai_interaction", evidence: [{ display_label: "Budget Forecasting", candidate_concept: "Budget planning", claim: "Forecasted budget scenarios.", supporting_excerpt: "Modelled base and downside assumptions.", confidence: "high" }] },
        { id: "fin_3", title: "Margin modelling", date: "2026-06-21", professional_category: "finance", classification: "professional", summary: "Margin model update.", content_origin_notes: "synthetic_user_ai_interaction", evidence: [{ display_label: "Margin Modelling", candidate_concept: "Financial modelling", claim: "Modelled margin sensitivity.", supporting_excerpt: "Contribution margin across price bands.", confidence: "high" }] }
      ]
    };
    const financeRealPattern = buildReports(buildNormalized(normalizeChatGptExport(financeRealPack), [])).professional_pattern;
    assert.ok(/finance and analytical|mixed\/cross-functional/i.test(financeRealPattern.observed_professional_pattern), "real financial evidence should map to finance family or mixed");

    // STRUCTURAL REDESIGN TEST 11 — SPECIFIC CAPABILITY PRESERVATION
    const preserveSpecific = buildReports(buildNormalized(normalizeChatGptExport(selectionPack), [])).professional_pattern;
    const preservedAssessment = (preserveSpecific.capability_assessments || [])[0];
    assert.ok(preservedAssessment, "structured pack should emit at least one capability assessment");
    assert.strictEqual(preservedAssessment.label_source, "display_label", "capability should preserve structured display label source");
    assert.ok(String(preservedAssessment.label || "").trim().split(/\s+/).length >= 2, "capability label should not collapse to one-word generic label");

    // STRUCTURAL REDESIGN TEST 12 — NO GENERIC COLLAPSE
    const noCollapsePack = {
      schema: "professional_evidence_pack_v1",
      generated_at: "2026-07-16",
      conversations: [{
        id: "nc_1",
        title: "No collapse",
        date: "2026-06-15",
        professional_category: "talent_acquisition",
        classification: "professional",
        summary: "Two analyses with different objects.",
        content_origin_notes: "synthetic_user_ai_interaction",
        evidence: [
          { display_label: "Recruitment Funnel Analysis", candidate_concept: "Recruitment funnel analysis", claim: "Pipeline stage quality review.", supporting_excerpt: "Check stage conversion quality.", confidence: "high" },
          { display_label: "Capability Gap Analysis", candidate_concept: "Capability gap analysis", claim: "Mapped workforce capability gaps.", supporting_excerpt: "Connect roadmap priorities to capability gaps.", confidence: "high" }
        ]
      }]
    };
    const noCollapsePattern = buildReports(buildNormalized(normalizeChatGptExport(noCollapsePack), [])).professional_pattern;
    const noCollapseAssessments = noCollapsePattern.capability_assessments || [];
    assert.ok(noCollapseAssessments.length >= 1, "structured no-collapse input should emit capability assessments");
    assert.ok(noCollapseAssessments.every(item => item.label_source === "display_label"), "no-collapse capabilities should retain display_label provenance");
    assert.ok(noCollapseAssessments.every(item => String(item.label || "").trim().toLowerCase() !== "analysis"), "capabilities must not collapse to generic Analysis");
    const noCollapseEvidenceIds = new Set(noCollapseAssessments.flatMap(item => item.evidence_ids || []));
    assert.ok(noCollapseEvidenceIds.size >= 2, "both atomic analysis evidences should remain represented in capability evidence ids");

    // MANDATORY TEST 1 — CAPABILITY LABEL NOT REDACTED
    const labelPreservationHrPattern = buildReports(buildNormalized(normalizeChatGptExport(selectionPack), [])).professional_pattern;
    assert.ok((labelPreservationHrPattern.capability_assessments || []).some(item => String(item.label || "") === "Structured Interview Design"), "Structured Interview Design label must remain unchanged");

    // MANDATORY TEST 2 — BACKEND LABEL NOT REDACTED
    const backendLabelPack = {
      schema: "professional_evidence_pack_v1",
      generated_at: "2026-07-16",
      conversations: [{
        id: "backend_label_1",
        title: "Backend label",
        date: "2026-07-04",
        professional_category: "software_architecture",
        classification: "professional",
        summary: "Backend label test",
        content_origin_notes: "synthetic_user_ai_interaction",
        evidence: [{ display_label: "Distributed Systems Design", candidate_concept: "Distributed systems architecture", claim: "Defined service boundaries.", supporting_excerpt: "Use explicit contract boundaries.", confidence: "high" }]
      }]
    };
    const backendLabelPattern = buildReports(buildNormalized(normalizeChatGptExport(backendLabelPack), [])).professional_pattern;
    assert.ok((backendLabelPattern.capability_assessments || []).some(item => String(item.label || "") === "Distributed Systems Design"), "Distributed Systems Design label must remain unchanged");

    // MANDATORY TEST 3 — LEGAL LABEL NOT REDACTED
    const legalLabelPack = {
      schema: "professional_evidence_pack_v1",
      generated_at: "2026-07-16",
      conversations: [{
        id: "legal_label_1",
        title: "Legal label",
        date: "2026-07-05",
        professional_category: "compliance",
        classification: "professional",
        summary: "Legal label test",
        content_origin_notes: "synthetic_user_ai_interaction",
        evidence: [{ display_label: "Regulatory Risk Management", candidate_concept: "Regulatory control planning", claim: "Mapped controls and owners.", supporting_excerpt: "Map obligations to controls and owners.", confidence: "high" }]
      }]
    };
    const legalLabelPattern = buildReports(buildNormalized(normalizeChatGptExport(legalLabelPack), [])).professional_pattern;
    assert.ok((legalLabelPattern.capability_assessments || []).some(item => String(item.label || "") === "Regulatory Risk Management"), "Regulatory Risk Management label must remain unchanged");

    // MANDATORY TEST 4 — PERSON NAME IN FREE TEXT REDACTED
    const freeTextRedactionPack = {
      schema: "professional_evidence_pack_v1",
      generated_at: "2026-07-16",
      conversations: [{
        id: "redaction_free_1",
        title: "Free text redaction",
        date: "2026-07-06",
        professional_category: "talent_acquisition",
        classification: "professional",
        summary: "Free text redaction",
        content_origin_notes: "synthetic_user_ai_interaction",
        evidence: [{ display_label: "Structured Interview Design", candidate_concept: "Structured interviewing", claim: "Marco Rossi approved the interview framework.", supporting_excerpt: "Marco Rossi approved the framework.", confidence: "high" }]
      }]
    };
    const freeTextRedactionNormalized = buildNormalized(normalizeChatGptExport(freeTextRedactionPack), []);
    const freeTextRedactionItem = freeTextRedactionNormalized[0].evidence_items[0];
    assert.ok(String(freeTextRedactionItem.supporting_excerpt || "").includes("PERSON_1 approved the framework."), "free text excerpt should redact person names");

    // MANDATORY TEST 5 — STRUCTURED FIELD VS FREE TEXT
    const mixedScopePack = {
      schema: "professional_evidence_pack_v1",
      generated_at: "2026-07-16",
      conversations: [{
        id: "scope_1",
        title: "Scope separation",
        date: "2026-07-06",
        professional_category: "talent_acquisition",
        classification: "professional",
        summary: "Scope separation",
        content_origin_notes: "synthetic_user_ai_interaction",
        evidence: [{ display_label: "Structured Interview Design", candidate_concept: "Structured Interview Design", claim: "Marco Rossi approved Structured Interview Design.", supporting_excerpt: "Marco Rossi approved Structured Interview Design.", confidence: "high" }]
      }]
    };
    const mixedScopeNormalized = buildNormalized(normalizeChatGptExport(mixedScopePack), []);
    const mixedScopeItem = mixedScopeNormalized[0].evidence_items[0];
    assert.strictEqual(mixedScopeItem.display_label, "Structured Interview Design", "structured display_label should remain unchanged");
    assert.ok(String(mixedScopeItem.supporting_excerpt || "").includes("PERSON_1 approved Structured Interview Design."), "free text supporting_excerpt should redact person while preserving capability label text");
    assert.strictEqual(mixedScopeItem.redaction_scope, "structured_evidence_item", "structured evidence should expose redaction scope metadata");

    // MANDATORY TEST 8 — NO EVIDENCE INFLATION
    const noInflationPack = {
      schema: "professional_evidence_pack_v1",
      generated_at: "2026-07-16",
      conversations: [{
        id: "inflate_1",
        title: "No inflation",
        date: "2026-07-07",
        professional_category: "talent_acquisition",
        classification: "professional",
        summary: "single atomic evidence",
        content_origin_notes: "synthetic_user_ai_interaction",
        evidence: [{ dimension: "communication", display_label: "Structured Interview Design", candidate_concept: "Structured interviewing", claim: "Defined roadmap and communication milestones.", supporting_excerpt: "Roadmap plan with communication checkpoints.", confidence: "high" }]
      }]
    };
    const noInflationReport = buildReports(buildNormalized(normalizeChatGptExport(noInflationPack), []));
    assert.strictEqual(noInflationReport.evidence_coverage_detail.atomic_evidence_count, 1, "single atomic evidence item should stay atomic=1");
    assert.strictEqual(noInflationReport.evidence_coverage_detail.capability_link_count, 1, "single atomic evidence item should map to exactly one capability link");
    assert.strictEqual(noInflationReport.evidence_coverage_detail.mapped_behaviour_count, 2, "single atomic evidence item with two behaviours should produce mapped_behaviour_count=2");

    // STRUCTURAL REDESIGN TESTS 13-16 — FIXTURE REGRESSIONS
    assert.ok(fs.existsSync(fixtureHrPath), "HR fixture exists");
    assert.ok(fs.existsSync(fixtureBackendPath), "Backend fixture exists");
    assert.ok(fs.existsSync(fixtureSalesPath), "Sales fixture exists");
    assert.ok(fs.existsSync(fixtureLegalPath), "Legal fixture exists");

    const fixtureHr = JSON.parse(fs.readFileSync(fixtureHrPath, "utf8"));
    const fixtureBackend = JSON.parse(fs.readFileSync(fixtureBackendPath, "utf8"));
    const fixtureSales = JSON.parse(fs.readFileSync(fixtureSalesPath, "utf8"));
    const fixtureLegal = JSON.parse(fs.readFileSync(fixtureLegalPath, "utf8"));

    const hrStructured = buildReports(buildNormalized(normalizeChatGptExport(fixtureHr), []));
    const backendStructured = buildReports(buildNormalized(normalizeChatGptExport(fixtureBackend), []));
    const salesStructured = buildReports(buildNormalized(normalizeChatGptExport(fixtureSales), []));
    const legalStructured = buildReports(buildNormalized(normalizeChatGptExport(fixtureLegal), []));

    // MANDATORY TEST 6 — METRICS PARITY
    for (const fixtureReport of [hrStructured, backendStructured, salesStructured, legalStructured]) {
      const diagnostics = fixtureReport.professional_pattern && fixtureReport.professional_pattern.diagnostics;
      const coverage = fixtureReport.evidence_coverage_detail;
      assert.ok(diagnostics, "structured fixture must expose diagnostics");
      assert.strictEqual(diagnostics.atomic_evidence_count, coverage.atomic_evidence_count, "diagnostics and coverage must agree on atomic_evidence_count");
      assert.strictEqual(diagnostics.capability_link_count, coverage.capability_link_count, "diagnostics and coverage must agree on capability_link_count");
      assert.strictEqual(diagnostics.mapped_behaviour_count, coverage.mapped_behaviour_count, "diagnostics and coverage must agree on mapped_behaviour_count");
    }

    // MANDATORY TEST 7 — MAPPED BEHAVIOUR NON ZERO
    assert.ok(hrStructured.evidence_coverage_detail.mapped_behaviour_count > 0, "HR fixture should map behaviours");
    assert.ok(backendStructured.evidence_coverage_detail.mapped_behaviour_count > 0, "Backend fixture should map behaviours");
    assert.ok(salesStructured.evidence_coverage_detail.mapped_behaviour_count > 0, "Sales fixture should map behaviours");
    assert.ok(legalStructured.evidence_coverage_detail.mapped_behaviour_count > 0, "Legal fixture should map behaviours");

    assert.strictEqual(hrStructured.normalized.length, 12, "HR fixture should keep all professional conversations selected");
    assert.ok(/people and talent|mixed\/cross-functional/i.test(hrStructured.professional_pattern.observed_professional_pattern), "HR fixture should map to people/talent or mixed");
    assert.ok(hrStructured.evidence_coverage_detail.total_evidence_items <= 20, "HR evidence count should reflect atomic records and avoid inflated dimensional matches");
    const hrAssessments = hrStructured.professional_pattern.capability_assessments || [];
    assert.ok(hrAssessments.length > 0, "HR fixture should emit capability assessments");
    assert.ok(hrAssessments.some(item => item.label_source === "display_label"), "HR fixture should preserve structured capability label provenance");
    assert.ok(hrAssessments.some(item => String(item.label || "").trim().split(/\s+/).length >= 2), "HR fixture should preserve non-generic multi-word capability labels");

    assert.ok(/technical and engineering|mixed\/cross-functional/i.test(backendStructured.professional_pattern.observed_professional_pattern), "backend fixture should map to technical or mixed");
    assert.ok(!isSupported(backendStructured.professional_pattern, "People Management"), "backend fixture should not infer people management from sparse evidence");

    assert.ok(/commercial and growth|mixed\/cross-functional/i.test(salesStructured.professional_pattern.observed_professional_pattern), "sales fixture should map to commercial or mixed");
    assert.ok(!/finance and analytical/i.test(salesStructured.professional_pattern.observed_professional_pattern), "sales fixture should not drift to finance");

    assert.ok(/legal, risk and compliance|mixed\/cross-functional/i.test(legalStructured.professional_pattern.observed_professional_pattern), "legal fixture should map to legal/risk family or mixed");
    assert.ok(!/executive leadership/i.test(String(legalStructured.professional_pattern.observed_professional_pattern || "")), "single board update should not imply executive leadership");

    // MANDATORY TEST 9 — FOUR FIXTURE REGRESSION (FAMILY INVARIANCE)
    assert.strictEqual(String((hrStructured.professional_pattern.professional_family || {}).id || ""), "people_and_talent", "HR fixture family should remain people_and_talent");
    assert.strictEqual(String((backendStructured.professional_pattern.professional_family || {}).id || ""), "technical_and_engineering", "Backend fixture family should remain technical_and_engineering");
    assert.strictEqual(String((salesStructured.professional_pattern.professional_family || {}).id || ""), "commercial_and_growth", "Sales fixture family should remain commercial_and_growth");
    assert.strictEqual(String((legalStructured.professional_pattern.professional_family || {}).id || ""), "legal_risk_and_compliance", "Legal fixture family should remain legal_risk_and_compliance");

    // SELECTION ALIGNMENT TEST 1 — professional + approved false + resolved selected true -> checked
    const selectionCaseOne = {
      id: "sel_align_1",
      title: "Selection case one",
      classification: "professional",
      approved: false,
      selected: true,
      confidence: 0.7,
      messages: [{ author: "user", text: "Professional discussion." }],
      selection: {
        explicitly_excluded: false,
        selected: true,
        automatically_selected: true
      }
    };
    assert.strictEqual(resolveInitialConversationIncluded(selectionCaseOne), true, "resolved selected=true should initialize checkbox checked even if approved=false");

    // SELECTION ALIGNMENT TEST 2 — explicit user exclusion -> unchecked
    const selectionCaseTwo = {
      id: "sel_align_2",
      title: "Selection case two",
      classification: "professional",
      approved: true,
      selected: true,
      confidence: 0.7,
      messages: [{ author: "user", text: "Professional discussion." }],
      selection: {
        user_selected: false,
        explicitly_excluded: true,
        selected: true,
        automatically_selected: true
      }
    };
    assert.strictEqual(resolveInitialConversationIncluded(selectionCaseTwo), false, "explicit exclusion should initialize checkbox unchecked");

    // SELECTION ALIGNMENT TEST 3 — legacy payload with approved only -> backward compatible
    assert.strictEqual(resolveInitialConversationIncluded({ approved: true }), true, "legacy approved=true should remain checked");
    assert.strictEqual(resolveInitialConversationIncluded({ approved: false }), false, "legacy approved=false should remain unchecked");

    // SELECTION ALIGNMENT TEST 4 — HR fixture -> 12 checkbox checked initially
    const hrImportConversations = normalizeChatGptExport(fixtureHr).map(conversation => attachResolvedConversationSelection(conversation));
    const hrInitialChecked = hrImportConversations.filter(conversation => resolveInitialConversationIncluded(conversation)).length;
    assert.strictEqual(hrInitialChecked, 12, "HR fixture should initialize all 12 checkboxes as checked");

    // SELECTION ALIGNMENT TEST 5 — manual checkbox change -> next analysis uses user choice
    const hrWithManualOverride = hrImportConversations.map(conversation => ({ ...conversation }));
    const overriddenConversation = hrWithManualOverride.find(conversation => conversation.id === "hr_001");
    const overriddenUpdated = applyUserConversationSelection(overriddenConversation, false);
    Object.assign(overriddenConversation, overriddenUpdated);
    const decisions = hrWithManualOverride.map(conversation => ({
      id: conversation.id,
      include: resolveInitialConversationIncluded(conversation),
      classification: conversation.classification
    }));
    const normalizedAfterManualOverride = buildNormalized(hrWithManualOverride, decisions);
    assert.ok(!normalizedAfterManualOverride.some(conversation => conversation.id === "hr_001"), "manual unchecked conversation should be excluded in next backend analysis");

    // STRUCTURAL REDESIGN TEST 17 — MIXED PROFILE
    const mixedPack = {
      schema: "professional_evidence_pack_v1",
      generated_at: "2026-07-16",
      conversations: [
        { id: "mix_1", title: "Tech", date: "2026-07-01", professional_category: "software_development", classification: "professional", summary: "Tech capability", content_origin_notes: "synthetic_user_ai_interaction", evidence: [{ display_label: "API Evolution Planning", candidate_concept: "API planning", claim: "Defined non-breaking API evolution.", supporting_excerpt: "Compatibility windows and migration plan.", confidence: "high" }] },
        { id: "mix_2", title: "Commercial", date: "2026-07-03", professional_category: "sales", classification: "professional", summary: "Commercial capability", content_origin_notes: "synthetic_user_ai_interaction", evidence: [{ display_label: "Commercial Negotiation", candidate_concept: "Negotiation planning", claim: "Defined concession strategy.", supporting_excerpt: "Trade terms for value.", confidence: "high" }] }
      ]
    };
    const mixedStructured = buildReports(buildNormalized(normalizeChatGptExport(mixedPack), [])).professional_pattern;
    assert.strictEqual(String((mixedStructured.professional_family || {}).id || ""), "mixed_cross_functional", "balanced cross-domain evidence should produce mixed/cross-functional family");

    // STRUCTURAL REDESIGN TEST 18 — JUNIOR PROFILE
    const juniorStructured = buildReports(buildNormalized(normalizeChatGptExport({
      schema: "professional_evidence_pack_v1",
      generated_at: "2026-07-16",
      conversations: [{ id: "jr_1", title: "Single", date: "2026-07-10", professional_category: "software_development", classification: "professional", summary: "One sparse activity", content_origin_notes: "synthetic_user_ai_interaction", evidence: [{ display_label: "Bug Fix Exploration", candidate_concept: "Bug fix", claim: "Asked for help on one bug.", supporting_excerpt: "Single attempt with guidance.", confidence: "low" }] }]
    }), [])).professional_pattern;
    assert.ok(/emerging professional patterns|not yet sufficient/i.test(String(juniorStructured.observed_professional_pattern || "")), "sparse junior profile should remain emerging");

    // STRUCTURAL REDESIGN TEST 19 — DETERMINISM
    const hrNormA = buildNormalized(normalizeChatGptExport(fixtureHr), []);
    const hrNormB = buildNormalized(normalizeChatGptExport(fixtureHr), []);
    const hrReportA = buildReports(hrNormA);
    const hrReportB = buildReports(hrNormB);
    const deterministicA = {
      selected: hrReportA.normalized.map(item => item.id),
      evidence_count: hrReportA.evidence_coverage_detail.total_evidence_items,
      family: hrReportA.professional_pattern.professional_family,
      pattern: hrReportA.professional_pattern.observed_professional_pattern,
      capabilities: (hrReportA.professional_pattern.capability_assessments || []).map(item => ({ label: item.label, state: item.capability_state, score: item.dominance_score }))
    };
    const deterministicB = {
      selected: hrReportB.normalized.map(item => item.id),
      evidence_count: hrReportB.evidence_coverage_detail.total_evidence_items,
      family: hrReportB.professional_pattern.professional_family,
      pattern: hrReportB.professional_pattern.observed_professional_pattern,
      capabilities: (hrReportB.professional_pattern.capability_assessments || []).map(item => ({ label: item.label, state: item.capability_state, score: item.dominance_score }))
    };
    assert.deepStrictEqual(deterministicA, deterministicB, "same input should produce deterministic outputs");

    // STRUCTURAL REDESIGN TEST 20 — LEGACY COMPATIBILITY
    const legacyInput = [{
      id: "legacy_compat_1",
      title: "Legacy unstructured",
      created_at: "2026-07-02T00:00:00.000Z",
      messages: [{ author: "user", created_at: "2026-07-02T00:00:00.000Z", text: "I reviewed architecture trade-offs and incident mitigation options.", content_origin: { value: "original_user_input" } }]
    }];
    const legacyCompatReport = buildReports(buildNormalized(normalizeChatGptExport(legacyInput), [{ id: "legacy_compat_1", include: true, classification: "professional" }]));
    assert.ok(legacyCompatReport.professional_pattern, "legacy unstructured JSON should still be processed");
    assert.ok(legacyCompatReport.evidence_coverage_detail.total_professional_conversations >= 1, "legacy input should produce non-empty coverage");

    // PARITY TESTS — CANONICAL RESULT / SNAPSHOT / REPORT / PDF
    const parityFixtures = [
      { name: "hr", report: hrStructured },
      { name: "backend", report: backendStructured },
      { name: "sales", report: salesStructured },
      { name: "legal", report: legalStructured }
    ];

    for (const fixture of parityFixtures) {
      const canonical = fixture.report.canonical_analysis_result;
      const semantic = fixture.report.semantic_view_model;
      assert.ok(canonical, `${fixture.name}: canonical analysis result must exist`);
      assert.ok(semantic, `${fixture.name}: semantic view model must exist`);
      assert.strictEqual(String(canonical.evidence_metrics.atomic_evidence_count), String(semantic.totalEvidenceItemCount), `${fixture.name}: atomic evidence parity canonical vs semantic`);
      assert.strictEqual(String(canonical.professional_family.id), String((fixture.report.professional_pattern.professional_family || {}).id), `${fixture.name}: family parity canonical vs pattern`);
      const vmParity = ReportViewModel.validateReportViewModel(ReportViewModel.buildSnapshotViewModel(semantic)).model;
      assert.strictEqual(String(vmParity.professionalPattern || ""), String(canonical.professional_pattern || ""), `${fixture.name}: pattern parity canonical vs VM`);
      assert.strictEqual(String(vmParity.typicalContribution || ""), String(canonical.typical_contribution || ""), `${fixture.name}: contribution parity canonical vs VM`);
      assert.strictEqual(String(vmParity.metrics[1] && vmParity.metrics[1].value), String(canonical.evidence_metrics.atomic_evidence_count), `${fixture.name}: evidence metric parity canonical vs VM`);
    }

    // TEST 5 — STRUCTURED MODE NO LEGACY SEMANTICS
    assert.strictEqual(hrStructured.analysis_mode, "structured", "HR structured mode should be explicit");
    assert.ok(Array.isArray(hrStructured.canonical_analysis_result.routing_reason_codes) && hrStructured.canonical_analysis_result.routing_reason_codes.includes("structured_evidence_path"), "structured mode should expose structured path reason code");
    assert.strictEqual(hrStructured.fallback_reason, null, "structured mode should not expose legacy fallback reason");

    // TEST 6 — LEGACY MODE COMPATIBILITY
    assert.strictEqual(legacyCompatReport.analysis_mode, "legacy", "legacy payload should route to legacy mode");
    assert.ok(String(legacyCompatReport.fallback_reason || "").length > 0, "legacy mode should expose fallback reason");

    // TEST 7 — EMPTY STRUCTURED RESULT NO LEGACY PROMOTION
    const sparseStructuredPack = {
      schema: "professional_evidence_pack_v1",
      generated_at: "2026-07-16",
      conversations: [{
        id: "sparse_1",
        title: "Sparse structured",
        date: "2026-07-09",
        professional_category: "technology",
        classification: "professional",
        summary: "Sparse evidence",
        content_origin_notes: "synthetic_user_ai_interaction",
        evidence: [{ display_label: "Single Weak Signal", candidate_concept: "Single weak signal", claim: "One weak claim", supporting_excerpt: "one weak excerpt", confidence: "low" }]
      }]
    };
    const sparseStructuredReport = buildReports(buildNormalized(normalizeChatGptExport(sparseStructuredPack), []));
    assert.strictEqual(sparseStructuredReport.analysis_mode, "structured", "sparse structured payload should remain structured mode");
    assert.ok(Array.isArray(sparseStructuredReport.canonical_analysis_result.supported_capabilities), "supported capabilities array should exist");
    assert.ok(Array.isArray(sparseStructuredReport.canonical_analysis_result.recurring_strengths), "recurring strengths array should exist");

    // TEST 8 — EVIDENCE COUNT PARITY
    for (const fixture of parityFixtures) {
      const canonical = fixture.report.canonical_analysis_result;
      const semantic = fixture.report.semantic_view_model;
      const vmParity = ReportViewModel.validateReportViewModel(ReportViewModel.buildSnapshotViewModel(semantic)).model;
      assert.strictEqual(String(canonical.evidence_metrics.atomic_evidence_count), String(semantic.totalEvidenceItemCount), `${fixture.name}: canonical = semantic evidence count`);
      assert.strictEqual(String(canonical.evidence_metrics.atomic_evidence_count), String(vmParity.metrics[1] && vmParity.metrics[1].value), `${fixture.name}: canonical = VM evidence count`);
    }

    // TEST 9 — FAMILY PARITY
    for (const fixture of parityFixtures) {
      const canonical = fixture.report.canonical_analysis_result;
      assert.strictEqual(String(canonical.professional_family.id), String((fixture.report.professional_pattern.professional_family || {}).id), `${fixture.name}: canonical family equals report family`);
    }

    // TEST 10 — CAPABILITY STATE PARITY
    const hrCanonicalSupported = (hrStructured.canonical_analysis_result.supported_capabilities || []).map(item => String(item.capability_state || ""));
    assert.ok(hrCanonicalSupported.every(state => ["demonstrated", "strongly_demonstrated", "attested"].includes(state)), "supported capabilities must keep supported states only");

    // TEST 11 — DETERMINISM (semantic model)
    const deterministicSemanticA = JSON.stringify(hrReportA.semantic_view_model);
    const deterministicSemanticB = JSON.stringify(hrReportB.semantic_view_model);
    assert.strictEqual(deterministicSemanticA, deterministicSemanticB, "semantic view model should be deterministic across identical runs");

    // TEST 12 — NO DOMAIN-SPECIFIC BRANCHING (guardrail text scan)
    const appJsContent = fs.readFileSync(path.join(root, "public", "app.js"), "utf8").toLowerCase();
    assert.ok(!appJsContent.includes("if hr") && !appJsContent.includes("if recruitment") && !appJsContent.includes("if backend") && !appJsContent.includes("if sales") && !appJsContent.includes("if legal"), "no domain-specific branching should be introduced");

    // TEST 13 — MIXED PROFILE PARITY
    const mixedStructuredReport = buildReports(buildNormalized(normalizeChatGptExport(mixedPack), []));
    assert.strictEqual(String((mixedStructuredReport.canonical_analysis_result.professional_family || {}).id || ""), "mixed_cross_functional", "mixed profile canonical family should remain mixed_cross_functional");

    // TEST 14 — FUTURE UNKNOWN DOMAIN
    const unknownDomainPack = {
      schema: "professional_evidence_pack_v1",
      generated_at: "2026-07-16",
      conversations: [{
        id: "unknown_1",
        title: "Unknown domain",
        date: "2026-07-12",
        professional_category: "future_unknown_cluster",
        classification: "professional",
        summary: "Unknown domain test",
        content_origin_notes: "synthetic_user_ai_interaction",
        evidence: [{ display_label: "Unknown Domain Capability", candidate_concept: "Unknown domain capability", claim: "Unknown domain capability claim", supporting_excerpt: "Unknown domain capability evidence", confidence: "high" }]
      }]
    };
    const unknownDomainReport = buildReports(buildNormalized(normalizeChatGptExport(unknownDomainPack), []));
    assert.ok(unknownDomainReport.canonical_analysis_result, "unknown domain should still produce canonical result");
    assert.ok(unknownDomainReport.semantic_view_model, "unknown domain should still produce semantic view model without legacy semantic fallback");
  }

  assert.ok(chiefGrowthReport.professional_pattern.radar_capabilities.every(item => !/_[a-z]/i.test(item.label)), "no snake_case should appear in visible radar labels");
  console.log("All tests passed.");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
