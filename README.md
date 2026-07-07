# Professional Evidence Profile

Local MVP to import a ChatGPT export, classify work-related conversations, redact sensitive data, review the selection manually, and generate a private/public professional evidence profile.

## What this MVP does

- Accepts `conversations.json` or a ChatGPT export `.zip`.
- Extracts conversations and messages.
- Classifies conversations as `professional`, `personal`, `mixed`, `uncertain`, or `excluded_sensitive`.
- Detects pasted external content heuristically.
- Redacts names, emails, phones, API keys, credentials, addresses, and sensitive terms.
- Lets the user include, exclude, or reclassify conversations.
- Generates a normalized JSON, methodology KPIs, private report, public report, and up to 8 evidence-backed insights.
- Deletes all in-memory session data with one action.

## What it intentionally does not do

- No candidate ranking.
- No hiring decisions.
- No psychological diagnosis.
- No external API calls.
- No training on user data.
- No permanent storage of uploaded conversations.

## Run

Double click:

```text
run-local.cmd
```

Then open:

```text
http://localhost:4173
```

If port `4173` is busy, double click:

```text
run-local-4184.cmd
```

Then open:

```text
http://localhost:4184
```

From a terminal, you can also run:

```powershell
node server.js
```

## Test

```powershell
node tests/run-tests.js
```

## Sample data

Use `samples/synthetic-conversations.json` to try the flow without real data.

## Privacy model in this prototype

This prototype stores session data only in memory while the server process is running. Uploaded files are parsed from the request body and are not written to disk. The delete button removes the session from memory.

For production, add authentication, encryption at rest, persistent consent records, audit logs without conversation content, malware scanning, strict file limits, and a formal privacy/legal review.
