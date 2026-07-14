# PDF Export Before/After Checklist

This checklist documents the visual/content differences introduced by the redesign.

## Snapshot

- Before: Radar chart labels could overlap or clip.
  After: Radar removed from main PDF and replaced by capability cards.
- Before: Truncated/incomplete phrases (e.g. endings like `and.` / `through.`).
  After: Sentence-aware sanitization with invalid-ending cleanup.
- Before: Technical/raw labels could appear.
  After: Enum/provenance mapping with readable labels.
- Before: KPI meaning could be mixed (weighted/direct attribution confusion).
  After: Single KPI policy in snapshot: `Direct evidence share`.
- Before: Inconsistent borders and crowded edge spacing.
  After: A4 landscape fixed grid with conservative margins and one-page fit.

## Appendix

- Before: Technical field names could be shown inline.
  After: Structured evidence cards with human labels only.
- Before: Supporting/counter/provenance blocks not clearly separated.
  After: Dedicated card sections for claim, support, counter-evidence, attribution, confidence.
- Before: Pagination had uneven whitespace and low readability.
  After: Card-height estimation + page-space guard to avoid clipped cards.

## Files generated for visual check

- professional-evidence-snapshot-demo-profile-2026-07-14.pdf
- detailed-evidence-appendix-demo-profile-2026-07-14.pdf
- professional-evidence-report-demo-profile-2026-07-14.pdf
