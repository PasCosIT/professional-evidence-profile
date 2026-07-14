# Workproof PDF Export Checklist

This checklist documents the visual and content rules used in Workproof exports.

## Snapshot

- Before: Radar chart labels could overlap or clip.
  After: Radar removed from the main PDF and replaced by capability cards.
- Before: Truncated or incomplete phrases (for example endings like and. or through.).
  After: Sentence-aware sanitization with invalid-ending cleanup.
- Before: Technical or raw labels could appear.
  After: Enum and source attribution mapping with readable labels.
- Before: KPI meaning could be mixed.
  After: Evidence-based KPI policy with non-contradictory fallback labels.
- Before: Inconsistent borders and crowded spacing.
  After: A4 landscape fixed grid with conservative margins and one-page fit.

## Appendix

- Before: Technical field names could be shown inline.
  After: Structured evidence cards with user-facing labels only.
- Before: Supporting, counter, and source attribution blocks were not clearly separated.
  After: Dedicated card sections for claim, support, counter-evidence, attribution, and confidence level.
- Before: Pagination had uneven whitespace and lower readability.
  After: Card-height estimation and page-space guard to avoid clipped cards.

## Files generated for visual check

- workproof-snapshot-demo-profile-2026-07-14.pdf
- workproof-evidence-appendix-demo-profile-2026-07-14.pdf
- workproof-evidence-report-demo-profile-2026-07-14.pdf
