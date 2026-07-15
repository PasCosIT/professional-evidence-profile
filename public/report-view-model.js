(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ReportViewModel = factory();
  }
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var INVALID_SENTENCE_ENDINGS = new Set([
    "and", "or", "with", "through", "by", "for", "in", "around",
    "and.", "or.", "with.", "through.", "by.", "for.", "in.", "around."
  ]);

  var CONTEXT_LABELS = {
    cross_functional_coordination: "Cross-functional coordination",
    technology_integrations: "Technology and integrations",
    stakeholder_communication: "Stakeholder communication",
    continuous_improvement: "Continuous improvement",
    product_commercial_planning: "Product and commercial planning",
    program_management: "Program management",
    operations: "Operations",
    product_management: "Product management",
    data_analytics: "Data and analytics"
  };

  var CAPABILITY_LABELS = {
    collaboration: "Stakeholder Alignment",
    communication: "Stakeholder Communication",
    data_reasoning: "Data Reasoning",
    risk_awareness: "Risk Governance",
    leadership: "Team Leadership",
    execution: "Execution",
    hiring_support: "Hiring Support",
    planning: "Planning and Prioritization"
  };

  function normalizeKey(value) {
    return String(value || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  function cleanText(value) {
    return String(value || "")
      .replace(/\b(undefined|null|nan)\b/gi, " ")
      .replace(/[_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function sentenceFallback(kind) {
    if (kind === "headline") {
      return "The analyzed evidence shows recurring professional signals across multiple work contexts.";
    }
    if (kind === "contribution") {
      return "No recurring contribution pattern could be identified with sufficient confidence.";
    }
    return "The evidence suggests a professional profile with recurring cross-functional coordination and execution signals.";
  }

  function validateGeneratedSentence(text) {
    var candidate = cleanText(text);
    if (!candidate) return false;
    var lower = candidate.toLowerCase();
    var finalWord = lower.replace(/[.!?]+$/g, "").split(/\s+/).pop();
    for (var ending of INVALID_SENTENCE_ENDINGS) {
      if (lower.endsWith(ending)) return false;
    }
    if (!finalWord || finalWord.length <= 3 || ["the", "and", "or", "for", "with", "through", "of", "to", "a", "an"].includes(finalWord)) {
      return false;
    }
    if (!/[.!?]$/.test(candidate)) return false;
    return true;
  }

  function ensureSentence(text, maxChars, fallbackKind) {
    var candidate = cleanText(text);
    if (!candidate) return sentenceFallback(fallbackKind);
    if (candidate.length > maxChars) {
      var clipped = candidate.slice(0, maxChars);
      var splitAt = clipped.lastIndexOf(" ");
      candidate = (splitAt > 20 ? clipped.slice(0, splitAt) : clipped).trim();
    }
    if (!/[.!?]$/.test(candidate)) candidate += ".";
    if (candidate.length < Math.max(40, Math.floor(maxChars * 0.45))) return sentenceFallback(fallbackKind);
    if (!validateGeneratedSentence(candidate)) return sentenceFallback(fallbackKind);
    return candidate;
  }

  function formatHumanDate(isoLike) {
    var date = new Date(isoLike);
    if (Number.isNaN(date.getTime())) return String(isoLike || "-");
    return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" }).format(date);
  }

  function calculateAttributionSummary(evidenceItemsOrSource) {
    var direct = 0;
    var mixed = 0;
    var contextual = 0;

    if (Array.isArray(evidenceItemsOrSource)) {
      evidenceItemsOrSource.forEach(function (item) {
        var tone = normalizeKey(item && (item.attribution || item.origin || item.source || item.provenance));
        if (tone.indexOf("direct") >= 0 || tone === "original_user_input") direct += 1;
        else if (tone.indexOf("mixed") >= 0) mixed += 1;
        else contextual += 1;
      });
    } else {
      var segments = (evidenceItemsOrSource && evidenceItemsOrSource.segments) || [];
      segments.forEach(function (segment) {
        var tone = normalizeKey(segment && segment.tone);
        var value = Number(segment && segment.value || 0);
        if (tone === "direct") direct += value;
        else if (tone === "mixed") mixed += value;
        else contextual += value;
      });
    }

    var total = direct + mixed + contextual;
    if (!total) {
      return {
        directCount: 0,
        mixedCount: 0,
        contextualCount: 0,
        totalCount: 0,
        directPercent: 0,
        mixedPercent: 0,
        contextualPercent: 0
      };
    }

    var directPercent = Math.round((direct / total) * 100);
    var mixedPercent = Math.round((mixed / total) * 100);
    var contextualPercent = Math.round((contextual / total) * 100);
    var delta = 100 - (directPercent + mixedPercent + contextualPercent);
    if (delta !== 0) contextualPercent += delta;

    return {
      directCount: direct,
      mixedCount: mixed,
      contextualCount: contextual,
      totalCount: total,
      directPercent: directPercent,
      mixedPercent: mixedPercent,
      contextualPercent: contextualPercent
    };
  }

  function strengthLabel(level) {
    var key = normalizeKey(level);
    if (key === "strongly_supported") return "Strongly supported";
    if (key === "recurring" || key === "observed") return "Supported";
    return "Emerging";
  }

  function coverageLabel(coverage) {
    var value = Number(coverage || 0);
    if (value >= 75) return "High coverage";
    if (value >= 45) return "Moderate coverage";
    return "Limited coverage";
  }

  function dominantAttribution(sourceBreakdown, reportAttribution) {
    var source = sourceBreakdown || {};
    var direct = Number(source.original_user_input || source.user_provided || source.direct || 0);
    var mixed = Number(source.mixed_content || source.mixed || 0);
    var contextual = Number(source.external_content || source.ai_generated_text || source.unknown || source.contextual || 0);

    if (direct === 0 && mixed === 0 && contextual === 0) return reportAttribution.directCount === 0 ? "Mixed" : "Contextual";
    if (reportAttribution.directCount === 0) return mixed >= contextual ? "Mixed" : "Contextual";
    if (direct >= mixed && direct >= contextual) return "Direct";
    if (mixed >= direct && mixed >= contextual) return "Mixed";
    return "Contextual";
  }

  function contextDisplayLabel(raw) {
    var cleaned = cleanText(raw);
    if (!cleaned) return "Professional context";
    var key = normalizeKey(cleaned);
    if (CONTEXT_LABELS[key]) return CONTEXT_LABELS[key];
    return cleaned
      .split(" ")
      .map(function (word) { return word.charAt(0).toUpperCase() + word.slice(1); })
      .join(" ");
  }

  function capabilityDisplayLabel(raw) {
    var cleaned = cleanText(raw);
    if (!cleaned) return "Capability";
    var key = normalizeKey(cleaned);
    if (CAPABILITY_LABELS[key]) return CAPABILITY_LABELS[key];
    return cleaned
       .split(" ")
       .map(function (word) { return word.charAt(0).toUpperCase() + word.slice(1); })
       .join(" ");
   }
 
   function buildReportViewModel(input) {
     var source = input || {};
     var attribution = calculateAttributionSummary(source.evidenceMix || []);
 
     var capabilities = (source.axes || [])
       .map(function (axis) {
        var evidenceItemCount = Number(axis && (axis.positive_count != null ? axis.positive_count : axis.evidenceItemCount));
        var conversationCount = Number(axis && (axis.unique_conversation_count != null ? axis.unique_conversation_count : axis.conversationCount));
        var coverage = Number(axis && (axis.coverage != null ? axis.coverage : axis.evidence_coverage));
        var assessed = axis && axis.assessed !== false && (axis.strength != null || coverage > 0);
        var hasEvidenceContext = assessed || coverage >= 35 || (!Number.isNaN(evidenceItemCount) && evidenceItemCount > 0) || (!Number.isNaN(conversationCount) && conversationCount > 0);
        if (!hasEvidenceContext) return null;
         return {
           label: capabilityDisplayLabel(axis.label || axis.canonical_dimension || axis.dimension),
           evidenceStrength: strengthLabel(axis.level),
          evidenceCoverage: coverageLabel(coverage),
           attribution: dominantAttribution(axis.source_breakdown || {}, attribution),
          evidenceItemCount: !Number.isNaN(evidenceItemCount) && evidenceItemCount > 0 ? evidenceItemCount : null,
          conversationCount: !Number.isNaN(conversationCount) && conversationCount > 0 ? conversationCount : null,
          assessed: assessed,
           confidence: cleanText(axis.confidence || "Medium") || "Medium"
         };
       })
       .filter(Boolean)
       .slice(0, 5);
 
     var notAssessed = (source.notAssessed || [])
       .map(function (item) { return capabilityDisplayLabel(item); })
       .filter(Boolean)
       .filter(function (item, index, arr) { return arr.indexOf(item) === index; });
 
     var contexts = (source.observedDomains || [])
       .map(contextDisplayLabel)
       .filter(Boolean)
       .filter(function (item, index, arr) { return arr.indexOf(item) === index; })
       .slice(0, 4);
 
     var kpiPrimary;
     if (attribution.directPercent >= 10) {
       kpiPrimary = {
         key: "direct_evidence_share",
         value: attribution.directPercent + "%",
         label: "Direct evidence share",
         helper: "Directly attributable evidence"
       };
     } else if (attribution.mixedPercent > 0) {
       kpiPrimary = {
         key: "mixed_attribution",
         value: attribution.mixedPercent + "%",
         label: "Mixed attribution",
         helper: "Combination of user and contextual content"
       };
     } else {
       kpiPrimary = {
         key: "evidence_coverage",
          value: Number(source.totalEvidenceItemCount || 0) > 0 ? String(source.totalEvidenceItemCount || 0) : "Insufficient evidence",
         label: "Evidence coverage",
          helper: "Supported by evidence available in this period"
       };
     }

     var conversationCount = Number(source.analyzedConversationCount || 0);
     var evidenceCount = Number(source.totalEvidenceItemCount || 0);
 
     var model = {
       profile: cleanText(source.personName) || "Professional profile",
       reportDate: formatHumanDate(source.extractedDate),
       period: {
         label: cleanText(source.observationPeriod) || "6 months",
         range: cleanText(source.dataRange) || "-",
         generated: formatHumanDate(source.extractedDate)
       },
       headline: ensureSentence(source.summary || source.professionalSignature, 180, "headline"),
       professionalPattern: ensureSentence(source.professionalSignature, 260, "pattern"),
       contexts: contexts,
       typicalContribution: ensureSentence(source.typicalContribution, 220, "contribution"),
       metrics: [
         {
           key: "professional_conversations",
           value: conversationCount > 0 ? String(conversationCount) : "Insufficient evidence",
           label: "Professional conversations",
           helper: "Included in this explainable analysis"
         },
         {
           key: "evidence_items",
           value: evidenceCount > 0 ? String(evidenceCount) : "Insufficient evidence",
           label: "Evidence items",
           helper: "Supported by evidence and source attribution"
         },
         {
           key: "supported_capabilities",
           value: capabilities.length > 0 ? String(capabilities.length) : "Insufficient evidence",
           label: "Demonstrated capabilities",
           helper: "Capability signals supported by evidence"
         },
         kpiPrimary
       ],
       capabilities: capabilities,
       notAssessed: {
         items: notAssessed.slice(0, 3),
         additional: Math.max(0, notAssessed.length - 3)
       },
       attribution: attribution,
       verification: "Explainable analysis based on user-controlled professional evidence from AI-assisted work. The evidence has not been independently verified. Evidence coverage represents availability and recurrence, not professional performance.",
       methodologyVersion: "snapshot-v11"
     };
 
     return model;
   }
 
   function validateReportViewModel(model) {
     var warnings = [];
     var safeModel = JSON.parse(JSON.stringify(model || {}));
 
     if (!Array.isArray(safeModel.capabilities)) safeModel.capabilities = [];
     safeModel.capabilities = safeModel.capabilities
       .filter(function (item) {
         if (!item || !cleanText(item.label)) {
           warnings.push("Capability without valid label omitted.");
           return false;
         }
         if (item.evidenceItemCount === 0) {
           warnings.push("Capability with zero evidence omitted.");
           return false;
         }
         return true;
       })
       .filter(function (item, index, arr) {
         return arr.findIndex(function (x) { return x.label === item.label; }) === index;
       });
 
     var capCount = safeModel.capabilities.length;
     safeModel.metrics = (safeModel.metrics || []).map(function (metric) {
       if (!metric) return null;
       if (metric.key === "supported_capabilities") {
         return {
           key: metric.key,
           value: capCount > 0 ? String(capCount) : "Insufficient evidence",
           label: "Demonstrated capabilities",
           helper: metric.helper || "Capability signals supported by evidence"
         };
       }
       return metric;
     }).filter(Boolean);
 
     if (safeModel.attribution && safeModel.attribution.directCount === 0) {
       safeModel.capabilities = safeModel.capabilities.map(function (cap) {
         if (cap.attribution === "Direct") {
           warnings.push("Direct attribution downgraded because report direct evidence is zero.");
           cap.attribution = "Mixed";
         }
         return cap;
       });
     }
 
     safeModel.headline = ensureSentence(safeModel.headline, 180, "headline");
     safeModel.professionalPattern = ensureSentence(safeModel.professionalPattern, 260, "pattern");
     safeModel.typicalContribution = ensureSentence(safeModel.typicalContribution, 220, "contribution");
 
     var sumPercent = Number((safeModel.attribution && safeModel.attribution.directPercent) || 0)
       + Number((safeModel.attribution && safeModel.attribution.mixedPercent) || 0)
       + Number((safeModel.attribution && safeModel.attribution.contextualPercent) || 0);
     if (Math.abs(sumPercent - 100) > 1 && Number((safeModel.attribution && safeModel.attribution.totalCount) || 0) > 0) {
       warnings.push("Attribution percentages adjusted for rounding.");
       safeModel.attribution.contextualPercent += (100 - sumPercent);
     }
 
     if (!safeModel.methodologyVersion) safeModel.methodologyVersion = "snapshot-v11";
 
     return {
       valid: true,
       warnings: warnings,
       model: safeModel
     };
   }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;");
  }

  function renderSnapshotHtml(viewModel) {
    var vm = viewModel || {};
    var notAssessedText = vm.notAssessed && vm.notAssessed.items && vm.notAssessed.items.length
      ? vm.notAssessed.items.join(" · ") + (vm.notAssessed.additional ? " · +" + vm.notAssessed.additional + " additional dimensions" : "")
      : "All eligible dimensions had sufficient evidence for assessment.";

    return "" +
      '<article class="snapshot-page snapshot-page-vm">' +
      '  <header class="snapshot-header-vm">' +
      '    <div><p class="vm-title">EviLayer Snapshot</p><h1>' + escapeHtml(vm.profile) + '</h1><p class="vm-headline">' + escapeHtml(vm.headline) + '</p></div>' +
      '    <dl>' +
      '      <div><dt>Observation period</dt><dd>' + escapeHtml(vm.period && vm.period.label) + '</dd></div>' +
      '      <div><dt>Period analyzed</dt><dd>' + escapeHtml(vm.period && vm.period.range) + '</dd></div>' +
      '      <div><dt>Generated</dt><dd>' + escapeHtml(vm.period && vm.period.generated) + '</dd></div>' +
      '    </dl>' +
      '  </header>' +
      '  <section class="vm-grid vm-grid-top">' +
      '    <article class="vm-card"><h3>Professional Pattern</h3><p>' + escapeHtml(vm.professionalPattern) + '</p></article>' +
      '    <article class="vm-card"><h3>Professional Contexts</h3><div class="vm-contexts">' + (vm.contexts || []).map(function (c) { return '<span>' + escapeHtml(c) + '</span>'; }).join("") + '</div></article>' +
      '    <article class="vm-card"><h3>Typical Contribution</h3><p>' + escapeHtml(vm.typicalContribution) + '</p></article>' +
      '  </section>' +
      '  <section class="vm-card"><h3>Evidence Overview</h3><div class="vm-kpis">' +
      (vm.metrics || []).map(function (m) {
        return '<article><strong>' + escapeHtml(m.value) + '</strong><span>' + escapeHtml(m.label) + '</span><p>' + escapeHtml(m.helper || "") + '</p></article>';
      }).join("") +
      '  </div></section>' +
      '  <section class="vm-grid vm-grid-bottom">' +
      '    <article class="vm-card"><h3>Supported Capabilities</h3><div class="vm-caps">' +
      (vm.capabilities || []).map(function (c) {
        var countLine = (c.evidenceItemCount && c.conversationCount)
          ? (c.evidenceItemCount + ' evidence items across ' + c.conversationCount + ' conversations')
          : "";
        return '<div class="vm-cap"><strong>' + escapeHtml(c.label) + '</strong><span>' + escapeHtml(c.evidenceStrength + ' · ' + c.evidenceCoverage + ' · ' + c.attribution + ' attribution') + '</span>' + (countLine ? '<p>' + escapeHtml(countLine) + '</p>' : '') + '</div>';
      }).join("") +
      '    </div></article>' +
      '    <article class="vm-card"><h3>Not Assessed</h3><p>' + escapeHtml(notAssessedText) + '</p><h4>Methodology and verification</h4><p>' + escapeHtml(vm.verification) + '</p><p>Direct evidence: ' + escapeHtml(vm.attribution && vm.attribution.directPercent) + '% · Mixed attribution: ' + escapeHtml(vm.attribution && vm.attribution.mixedPercent) + '% · External or AI context: ' + escapeHtml(vm.attribution && vm.attribution.contextualPercent) + '%</p><p>Methodology version: ' + escapeHtml(vm.methodologyVersion) + '</p></article>' +
      '  </section>' +
      '</article>';
  }

  return {
    CONTEXT_LABELS: CONTEXT_LABELS,
    CAPABILITY_LABELS: CAPABILITY_LABELS,
    validateGeneratedSentence: validateGeneratedSentence,
    calculateAttributionSummary: calculateAttributionSummary,
    buildReportViewModel: buildReportViewModel,
    validateReportViewModel: validateReportViewModel,
    renderSnapshotHtml: renderSnapshotHtml,
    formatHumanDate: formatHumanDate
  };
}));
