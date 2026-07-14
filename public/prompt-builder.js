(function(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PromptBuilder = factory();
  }
})(typeof self !== "undefined" ? self : this, function() {
  const MONTH_MIN = 1;
  const MONTH_MAX = 12;

  const PLATFORM_LABELS = {
    chatgpt: "ChatGPT",
    claude: "Claude",
    gemini: "Gemini",
    copilot: "Microsoft Copilot",
    perplexity: "Perplexity",
    coding_assistant: "GitHub Copilot / Coding Assistant",
    other: "Other"
  };

  const PLATFORM_ALIAS = {
    microsoft_copilot: "copilot",
    github_copilot: "coding_assistant"
  };

  function normalizePlatform(value) {
    const key = String(value || "").trim().toLowerCase().replace(/\s+/g, "_");
    return PLATFORM_ALIAS[key] || (PLATFORM_LABELS[key] ? key : "other");
  }

  function platformDisplayName(value) {
    const key = normalizePlatform(value);
    return PLATFORM_LABELS[key] || PLATFORM_LABELS.other;
  }

  function sanitizeProfileName(value) {
    return String(value || "").trim().replace(/\s+/g, " ").slice(0, 120);
  }

  function todayIso(nowValue) {
    const now = nowValue ? new Date(nowValue) : new Date();
    return Number.isNaN(now.getTime()) ? new Date().toISOString().slice(0, 10) : now.toISOString().slice(0, 10);
  }

  function subtractCalendarMonths(dateIso, months) {
    const parts = String(dateIso).split("-").map(Number);
    if (parts.length !== 3 || !Number.isInteger(months)) return null;
    const year = parts[0];
    const month = parts[1];
    const day = parts[2];
    if (!year || !month || !day) return null;
    const targetMonthIndex = month - 1 - months;
    const lastTargetDay = new Date(Date.UTC(year, targetMonthIndex + 1, 0)).getUTCDate();
    const clampedDay = Math.min(day, lastTargetDay);
    return new Date(Date.UTC(year, targetMonthIndex, clampedDay)).toISOString().slice(0, 10);
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

  function buildTrustedConfig(input) {
    const profileName = sanitizeProfileName(input && input.profile_name);
    const selectedMonths = Number(input && input.selected_months);
    const months = Number.isFinite(selectedMonths) ? Math.max(MONTH_MIN, Math.min(MONTH_MAX, selectedMonths)) : 6;
    const generatedAt = todayIso(input && input.now);
    const periodTo = generatedAt;
    const periodFrom = subtractCalendarMonths(periodTo, months);
    const sourcePlatform = normalizePlatform(input && input.source_platform);
    const exportMode = String(input && input.export_mode || "quick").toLowerCase() === "complete" ? "complete" : "quick";
    return {
      profile_name: profileName,
      generated_at: generatedAt,
      period_from: periodFrom,
      period_to: periodTo,
      selected_months: months,
      source_platform: sourcePlatform,
      export_mode: exportMode,
      sanitized_profile_name: sanitizedFilenameName(profileName)
    };
  }

  function validateEvidencePromptConfig(input) {
    const errors = [];
    const profileName = sanitizeProfileName(input && input.profile_name);
    const sourcePlatformRaw = String(input && input.source_platform || "").trim();
    const selectedMonths = Number(input && input.selected_months);

    if (!profileName) errors.push("Profile name is required.");
    if (!sourcePlatformRaw) errors.push("Select the AI source.");
    if (!Number.isInteger(selectedMonths) || selectedMonths < MONTH_MIN || selectedMonths > MONTH_MAX) {
      errors.push("Analysis period must be between 1 and 12 months.");
    }
    return errors;
  }

  function jsonQuoted(value) {
    return JSON.stringify(String(value == null ? "" : value));
  }

  function commonPrivacyRules(locale) {
    if (locale === "it") {
      return [
        "Regole privacy e sicurezza:",
        "- Seleziona solo contenuti professionali approvati.",
        "- Escludi contenuti personali, familiari, sanitari, religiosi, politici o sensibili.",
        "- Anonimizza credenziali, token, email, telefoni, nomi, aziende e identificativi.",
        "- Non inventare evidenze: se incerto, usa classificazione uncertain.",
        "- Non includere conversazioni complete se bastano estratti professionali sintetici.",
        "- Restituisci solo JSON valido, senza markdown e senza spiegazioni esterne."
      ].join("\n");
    }
    return [
      "Privacy and safety rules:",
      "- Select only approved professional content.",
      "- Exclude personal, family, health, religious, political, or sensitive content.",
      "- Anonymize credentials, tokens, emails, phones, names, companies, and identifiers.",
      "- Do not invent evidence: if uncertain, mark as uncertain.",
      "- Do not include full conversations when compact professional excerpts are sufficient.",
      "- Return valid JSON only, without markdown and without external explanations."
    ].join("\n");
  }

  function commonModeRules(mode, locale) {
    const isQuick = mode === "quick";
    if (locale === "it") {
      if (isQuick) {
        return [
          "Modalita Quick (raccomandata):",
          "- Massimo 40 evidenze professionali forti.",
          "- JSON compatto, descrizioni brevi e nessuna analisi narrativa lunga.",
          "- Nessun punteggio finale su capability o personalita'.",
          "- Non produrre il report finale: estrai, seleziona, anonimizza e struttura.",
          "- L'interpretazione delle competenze resta al motore interno di Workproof."
        ].join("\n");
      }
      return [
        "Modalita Complete:",
        "- Fino a 100 evidenze professionali con contesto sintetico.",
        "- Puoi includere segnali temporali, provenienza, confidence e contro-evidenze.",
        "- Non assegnare punteggi finali alle capability.",
        "- Non definire personalita' o profilo psicologico dell'utente."
      ].join("\n");
    }
    if (isQuick) {
      return [
        "Quick mode (recommended):",
        "- Maximum 40 strongest professional evidence items.",
        "- Compact JSON, concise descriptions, no long narrative analysis.",
        "- No final capability or personality scoring.",
        "- Do not produce the final report: only extract, select, anonymize, and structure.",
        "- Capability interpretation remains the responsibility of Workproof internal engine."
      ].join("\n");
    }
    return [
      "Complete mode:",
      "- Up to 100 professional evidence items with concise context.",
      "- You may include temporal signals, provenance, confidence, and counter-evidence.",
      "- Do not assign final capability scores.",
      "- Do not infer user personality or psychological profile."
    ].join("\n");
  }

  function buildCorePrompt(config, locale, options) {
    const compact = Boolean(options && options.compact);
    const generatedFor = "Workproof Profile - " + config.profile_name;
    const periodNote = locale === "it"
      ? "Considera solo il periodo trusted indicato qui sotto. Non modificarlo."
      : "Consider only the trusted period below. Do not modify it.";

    const schemaSnippet = [
      "{",
      "  \"schema\": \"professional_evidence_pack_v1\",",
      "  \"generated_for\": " + jsonQuoted(generatedFor) + ",",
      "  \"generated_at\": " + jsonQuoted(config.generated_at) + ",",
      "  \"period\": {",
      "    \"from\": " + jsonQuoted(config.period_from) + ",",
      "    \"to\": " + jsonQuoted(config.period_to),
      "  },",
      "  \"source\": {",
      "    \"platform\": " + jsonQuoted(config.source_platform) + ",",
      "    \"export_mode\": " + jsonQuoted(config.export_mode),
      "  },",
      "  \"conversations\": [",
      "    {",
      "      \"id\": \"pack_conv_001\",",
      "      \"title\": \"Short professional title\",",
      "      \"date\": \"YYYY-MM-DD\",",
      "      \"professional_category\": \"strategy|project_management|product_management|technology|programming|data_analytics|professional_communication|leadership|recruiting|negotiation|execution|learning|other\",",
      "      \"classification\": \"professional|mixed|uncertain\",",
      "      \"summary\": \"Brief neutral summary\",",
      "      \"content_origin_notes\": \"original_user_input|user_instruction|user_code|assistant_generated_code|pasted_third_party_code|pasted_email|pasted_job_description|pasted_external_document|ai_generated_text|mixed_content|uncertain\",",
      "      \"evidence\": [",
      "        {",
      "          \"dimension\": \"decision_making|problem_solving|communication|execution|leadership|collaboration|planning|learning|domain_knowledge|data_reasoning|risk_awareness|quality_improvement\",",
      "          \"candidate_concept\": \"Observed professional concept\",",
      "          \"candidate_type\": \"capability|behavior|responsibility|role|domain|specialization|activity|context|actor|provenance|frequency|metadata|unknown\",",
      "          \"display_label\": \"Use only for capability, behavior, or responsibility\",",
      "          \"claim\": \"Evidence-based neutral claim\",",
      "          \"supporting_excerpt\": \"Short anonymized excerpt\",",
      "          \"counter_evidence\": \"Short limitation or null\",",
      "          \"time_period\": \"YYYY-MM-DD\",",
      "          \"confidence\": \"low|medium|high\"",
      "        }",
      "      ]",
      "    }",
      "  ]",
      "}"
    ].join("\n");

    const heading = locale === "it"
      ? (compact ? "Genera JSON Professional Evidence Pack compatibile con Workproof." : "Genera un Professional Evidence Pack JSON importabile in Workproof.")
      : (compact ? "Generate Professional Evidence Pack JSON compatible with Workproof." : "Generate a Professional Evidence Pack JSON importable into Workproof.");

    const outputConstraint = compact
      ? "Return valid JSON only. No markdown."
      : "Return only valid JSON matching the schema with no markdown and no additional text.";

    return [
      heading,
      "",
      "Trusted values (do not modify):",
      "- profile_name: " + config.profile_name,
      "- generated_at: " + config.generated_at,
      "- period.from: " + config.period_from,
      "- period.to: " + config.period_to,
      "- selected_months: " + config.selected_months,
      "- source_platform: " + config.source_platform,
      "- export_mode: " + config.export_mode,
      "",
      periodNote,
      "",
      commonPrivacyRules(locale),
      "",
      commonModeRules(config.export_mode, locale),
      "",
      "Mandatory JSON schema:",
      schemaSnippet,
      "",
      "Output constraint:",
      outputConstraint
    ].join("\n");
  }

  const PROMPT_ADAPTERS = {
    chatgpt: {
      instructions: function(locale) {
        if (locale === "it") {
          return [
            "Esporta o seleziona le conversazioni.",
            "Carica il file conversations.json oppure i file da analizzare.",
            "Incolla il prompt generato.",
            "Scarica il file JSON prodotto.",
            "Importalo in Workproof."
          ];
        }
        return [
          "Export or select the conversations.",
          "Upload conversations.json or the files to analyze.",
          "Paste the generated prompt.",
          "Download the produced JSON file.",
          "Import it into Workproof."
        ];
      },
      compose: function(corePrompt, config, locale) {
        const fileInstruction = "Create and attach a downloadable JSON file when file creation is supported. Otherwise return only the valid JSON content.";
        const fileName = "professional_evidence_pack_" + config.sanitized_profile_name + "_" + config.generated_at + ".json";
        const extra = locale === "it"
          ? [
              "Istruzioni ChatGPT:",
              "- Usa il nome file: " + fileName,
              "- " + fileInstruction,
              "- Verifica che il file allegato sia JSON valido e completo.",
              "- Se il JSON risulta troncato, rigenera il file in modalita compatta.",
              "- Non inserire testo fuori dal JSON nel messaggio finale.",
              "- Mantieni inalterati i campi trusted e lo schema richiesto.",
              "- In modalita quick evita spiegazioni narrative e privilegia sintesi ad alta densita informativa."
            ]
          : [
              "ChatGPT instructions:",
              "- Use this file name: " + fileName,
              "- " + fileInstruction,
              "- Verify the attached file is valid and complete JSON.",
              "- If JSON is truncated, regenerate in compact mode.",
              "- Do not include any text outside JSON in the final response.",
              "- Keep all trusted fields and required schema unchanged.",
              "- In quick mode avoid narrative commentary and prefer high-density concise evidence."
            ];
        return extra.join("\n") + "\n\n" + corePrompt;
      }
    },
    claude: {
      instructions: function(locale) {
        if (locale === "it") {
          return [
            "Apri una nuova conversazione o un progetto dedicato.",
            "Carica l'export o i file che vuoi analizzare.",
            "Incolla il prompt generato.",
            "Chiedi la creazione del file JSON.",
            "Importa il file in Workproof."
          ];
        }
        return [
          "Open a new conversation or a dedicated project.",
          "Upload the export or files to analyze.",
          "Paste the generated prompt.",
          "Ask for JSON file creation.",
          "Import the file into Workproof."
        ];
      },
      compose: function(corePrompt, config, locale) {
        const ordered = locale === "it"
          ? [
              "Istruzioni Claude (procedurali):",
              "1. considera solo il periodo indicato;",
              "2. seleziona esclusivamente contenuti professionali;",
              "3. escludi dati personali e sensibili;",
              "4. anonimizza persone, aziende e identificativi;",
              "5. estrai le evidenze;",
              "6. genera solo JSON valido;",
              "7. non aggiungere markdown o spiegazioni."
            ]
          : [
              "Claude procedural instructions:",
              "1. consider only the specified period;",
              "2. select only professional content;",
              "3. exclude personal and sensitive data;",
              "4. anonymize people, companies, and identifiers;",
              "5. extract evidence;",
              "6. generate valid JSON only;",
              "7. do not add markdown or explanations."
            ];
        const quickOnly = config.export_mode === "quick"
          ? [
              locale === "it" ? "Modalita quick:" : "Quick mode:",
              locale === "it" ? "- massimo 40 evidence items;" : "- maximum 40 evidence items;",
              locale === "it" ? "- usa descrizioni concise;" : "- use concise descriptions;",
              locale === "it" ? "- non ripetere la stessa evidenza;" : "- do not repeat the same evidence;",
              locale === "it" ? "- non includere intere conversazioni;" : "- do not include full conversations;",
              locale === "it" ? "- non includere spiegazioni fuori dal JSON;" : "- do not include explanations outside JSON;",
              locale === "it" ? "- non effettuare una valutazione della personalita';" : "- do not perform personality assessment;",
              locale === "it" ? "- non produrre il report finale." : "- do not produce the final report."
            ].join("\n")
          : "";
        return ordered.join("\n") + (quickOnly ? "\n" + quickOnly : "") + "\n\n" + corePrompt;
      }
    },
    gemini: {
      instructions: function(locale) {
        return locale === "it"
          ? [
              "Apri una nuova chat Gemini.",
              "Carica i contenuti da analizzare.",
              "Incolla il prompt generato.",
              "Ottieni il JSON senza markdown.",
              "Importa il JSON in Workproof."
            ]
          : [
              "Open a new Gemini chat.",
              "Upload the content to analyze.",
              "Paste the generated prompt.",
              "Get JSON with no markdown.",
              "Import JSON into Workproof."
            ];
      },
      compose: function(corePrompt, config, locale) {
        const direct = locale === "it"
          ? [
              "Istruzioni Gemini:",
              "- Usa istruzioni dirette e output solo JSON.",
              "- Non usare blocchi markdown.",
              "- Mantieni descrizioni brevi.",
              "- Testi o documenti incollati da terzi non devono essere attribuiti automaticamente all'utente."
            ]
          : [
              "Gemini instructions:",
              "- Use direct instructions and JSON-only output.",
              "- Do not use markdown blocks.",
              "- Keep descriptions short.",
              "- Third-party pasted documents or chats must not be automatically attributed to the user."
            ];
        return direct.join("\n") + "\n\n" + corePrompt;
      }
    },
    copilot: {
      instructions: function(locale) {
        return locale === "it"
          ? [
              "Apri una nuova chat in Microsoft Copilot.",
              "Carica o incolla il contenuto professionale.",
              "Incolla il prompt generato.",
              "Richiedi solo JSON valido.",
              "Importa il JSON in Workproof."
            ]
          : [
              "Open a new chat in Microsoft Copilot.",
              "Upload or paste professional content.",
              "Paste the generated prompt.",
              "Request valid JSON only.",
              "Import JSON into Workproof."
            ];
      },
      compose: function(corePrompt) {
        return corePrompt;
      }
    },
    perplexity: {
      instructions: function(locale) {
        return locale === "it"
          ? [
              "Apri una nuova chat Perplexity.",
              "Incolla o carica i contenuti da analizzare.",
              "Incolla il prompt generato.",
              "Richiedi output JSON puro.",
              "Importa il JSON in Workproof."
            ]
          : [
              "Open a new Perplexity chat.",
              "Paste or upload content to analyze.",
              "Paste the generated prompt.",
              "Request pure JSON output.",
              "Import JSON into Workproof."
            ];
      },
      compose: function(corePrompt) {
        return corePrompt;
      }
    },
    coding_assistant: {
      instructions: function(locale) {
        return locale === "it"
          ? [
              "Apri una nuova sessione del coding assistant.",
              "Fornisci repository, chat o note tecniche da analizzare.",
              "Incolla il prompt generato.",
              "Richiedi JSON senza testo extra.",
              "Importa il JSON in Workproof."
            ]
          : [
              "Open a new coding assistant session.",
              "Provide repository, chats, or technical notes to analyze.",
              "Paste the generated prompt.",
              "Request JSON without extra text.",
              "Import JSON into Workproof."
            ];
      },
      compose: function(corePrompt, config, locale) {
        const specialized = locale === "it"
          ? [
              "Istruzioni Coding Assistant:",
              "- Considera anche codice scritto, debugging, analisi architetturale, decisioni tecniche, test, documentazione, review, uso terminale e gestione repository.",
              "- Non attribuire automaticamente all'utente codice generato interamente dall'assistente.",
              "- Distingui quando possibile: user_instruction, user_code, assistant_generated_code, pasted_third_party_code, uncertain.",
              "- Mantieni il limite massimo di evidenze previsto dalla modalita selezionata (" + (config.export_mode === "quick" ? "40" : "100") + ")."
            ]
          : [
              "Coding Assistant instructions:",
              "- Include written code, debugging, architecture analysis, technical decisions, tests, documentation, review, terminal usage, and repository management.",
              "- Do not automatically attribute code that was entirely generated by the assistant to the user.",
              "- Distinguish when possible: user_instruction, user_code, assistant_generated_code, pasted_third_party_code, uncertain.",
              "- Keep the evidence cap for the selected mode (" + (config.export_mode === "quick" ? "40" : "100") + ")."
            ];
        return specialized.join("\n") + "\n\n" + corePrompt;
      }
    },
    other: {
      instructions: function(locale) {
        return locale === "it"
          ? [
              "Apri una nuova conversazione nell'assistente AI scelto.",
              "Carica o incolla il contenuto professionale da analizzare.",
              "Incolla il prompt generato.",
              "Ottieni solo JSON valido.",
              "Importa il JSON in Workproof."
            ]
          : [
              "Open a new conversation in the selected AI assistant.",
              "Upload or paste professional content to analyze.",
              "Paste the generated prompt.",
              "Get valid JSON only.",
              "Import JSON into Workproof."
            ];
      },
      compose: function(corePrompt) {
        return corePrompt;
      }
    }
  };

  function getGeneratePromptButtonLabel(sourcePlatform, locale) {
    const key = normalizePlatform(sourcePlatform);
    const name = platformDisplayName(key);
    if (locale === "it") {
      return key === "other" ? "Genera prompt personalizzato" : "Genera prompt per " + name;
    }
    return key === "other" ? "Generate custom prompt" : "Generate prompt for " + name;
  }

  function getInstructionsTitle(sourcePlatform, locale) {
    const name = platformDisplayName(sourcePlatform);
    return locale === "it" ? "Come usarlo con " + name : "How to use it with " + name;
  }

  function getPromptDownloadFilename(config) {
    const trusted = buildTrustedConfig(config || {});
    return "evidence-pack-prompt-" + trusted.source_platform + "-" + trusted.export_mode + "-" + trusted.sanitized_profile_name + "-" + trusted.generated_at + ".txt";
  }

  function buildEvidencePrompt(input, locale) {
    const trusted = buildTrustedConfig(input || {});
    const normalizedLocale = locale === "it" ? "it" : "en";
    const adapterKey = normalizePlatform(trusted.source_platform);
    const adapter = PROMPT_ADAPTERS[adapterKey] || PROMPT_ADAPTERS.other;
    const corePrompt = buildCorePrompt(trusted, normalizedLocale, { compact: adapterKey === "claude" });
    const prompt = adapter.compose(corePrompt, trusted, normalizedLocale);
    return {
      prompt: prompt,
      trusted: trusted,
      adapter_key: adapterKey,
      platform_name: platformDisplayName(adapterKey),
      instructions_title: getInstructionsTitle(adapterKey, normalizedLocale),
      instructions: adapter.instructions(normalizedLocale)
    };
  }

  return {
    MONTH_MIN: MONTH_MIN,
    MONTH_MAX: MONTH_MAX,
    PROMPT_ADAPTERS: PROMPT_ADAPTERS,
    normalizePlatform: normalizePlatform,
    platformDisplayName: platformDisplayName,
    sanitizeProfileName: sanitizeProfileName,
    sanitizedFilenameName: sanitizedFilenameName,
    todayIso: todayIso,
    subtractCalendarMonths: subtractCalendarMonths,
    buildTrustedConfig: buildTrustedConfig,
    validateEvidencePromptConfig: validateEvidencePromptConfig,
    buildEvidencePrompt: buildEvidencePrompt,
    getGeneratePromptButtonLabel: getGeneratePromptButtonLabel,
    getInstructionsTitle: getInstructionsTitle,
    getPromptDownloadFilename: getPromptDownloadFilename
  };
});
