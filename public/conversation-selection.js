(function(globalScope) {
  function hasOwnBoolean(value) {
    return typeof value === "boolean";
  }

  function resolveInitialConversationIncluded(conversation) {
    const entry = conversation || {};
    const selection = entry.selection && typeof entry.selection === "object" ? entry.selection : {};

    if (hasOwnBoolean(entry.user_selected)) return entry.user_selected;
    if (hasOwnBoolean(selection.user_selected)) return selection.user_selected;

    if (entry.explicitly_excluded === true) return false;
    if (selection.explicitly_excluded === true) return false;

    if (hasOwnBoolean(entry.selected)) return entry.selected;
    if (hasOwnBoolean(selection.selected)) return selection.selected;

    if (hasOwnBoolean(entry.automatically_selected) && entry.automatically_selected) return true;
    if (hasOwnBoolean(selection.automatically_selected) && selection.automatically_selected) return true;

    const classification = String(entry.classification || "");
    if (classification === "personal" || classification === "excluded_sensitive") return false;
    if (classification === "professional") return true;

    if (hasOwnBoolean(entry.approved)) return entry.approved;

    return false;
  }

  function applyUserConversationSelection(conversation, include) {
    const entry = conversation || {};
    const selection = entry.selection && typeof entry.selection === "object" ? entry.selection : {};
    const checked = Boolean(include);
    return {
      ...entry,
      approved: checked,
      selected: checked,
      automatically_selected: false,
      user_selected: checked,
      exclusion_reason: checked ? null : "excluded_user_choice",
      selection_reason_codes: checked ? ["selected_user_choice"] : ["excluded_user_choice"],
      selection: {
        ...selection,
        user_selected: checked,
        explicitly_excluded: !checked,
        automatically_selected: false,
        selected: checked,
        exclusion_reason: checked ? null : "excluded_user_choice",
        reason_codes: checked ? ["selected_user_choice"] : ["excluded_user_choice"]
      }
    };
  }

  const api = {
    resolveInitialConversationIncluded,
    applyUserConversationSelection
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (globalScope && typeof globalScope === "object") {
    globalScope.ConversationSelection = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
