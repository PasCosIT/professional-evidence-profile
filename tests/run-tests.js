const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { PDFParse } = require("pdf-parse");
const {
  normalizeChatGptExport,
  buildNormalized,
  buildReports,
  renderSnapshotPdf,
  renderAppendixPdf,
  scanSummary,
  redactText
} = require("../server");

const root = path.join(__dirname, "..");
const serverPath = path.join(root, "server.js");
const samplePath = path.join(root, "public", "samples", "synthetic-conversations.json");
const evidencePackPath = path.join(root, "public", "samples", "sample-evidence-pack.json");

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
  console.log("All tests passed.");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
