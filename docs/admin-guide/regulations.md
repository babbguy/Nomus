# Managing Regulations

Regulations change faster than releases. An administrator can add a new regulation as a **source**, edit or retire an existing one, and correct individual **rules** (obligations) without touching code or the database. Everything on this page needs a `platform_admin` login, or an API key with the `admin` scope. The matching endpoints are in the [API reference](../api-reference/regulations.md).

> Nomus is a regulatory applicability tool, not a compliance certification. Rules you write or edit are your own interpretation of a regulation. Have qualified counsel review them before you rely on them.

---

## Sources and rules

- A **source** is a regulation or standard that Nomus watches: a name, a jurisdiction code, a URL and parsing settings. The scheduler scrapes active sources and the pipeline extracts rules from them.
- A **rule** is one machine-readable obligation: conditions, an effect, a severity, a plain-language summary and a legal reference. Rules belong to a source. Rules are what the policy bundle, evaluation, scanning and attestations use.

In the dashboard: **Sources** lists sources, and **Rules** (or the checklist icon on a source card) manages rules.

---

## Built-in, customized and custom sources

Every source has an owner, shown as a badge on its card:

| Badge | `origin` | Meaning | Engine start |
|-------|----------|---------|--------------|
| Built-in | `registry` | Comes from the built-in registry (`engine/src/hunter/sources/registry.ts`) and has not been edited | URL, jurisdiction, parsing settings, tier, category and ingestion mode are refreshed from the registry |
| Customized | `customized` | A built-in source you edited | Never touched |
| Custom | `custom` | A source you added | Never touched |

### What the startup sync does

On every engine start the sync reconciles the database with the registry:

- A registry entry with no matching row is inserted, with the same activation default as before (automatically scrapeable sources start active).
- Built-in (`registry`) rows are updated to the registry values. This is how a new release can fix a moved URL.
- **Customized and custom rows are never modified.** The sync never changes any row's active flag, with one exception below.
- If a built-in source has been **removed from the registry** in a newer release, the sync deactivates it and retires its rules. Customized and custom sources are left alone even if they started life as that built-in.
- Rows from databases created before ownership was tracked are classified once: a row whose name matches a registry entry (or a renamed or removed one) becomes a built-in, anything else becomes a custom source and keeps its current active state.

Source names are unique (case-insensitive), and the API refuses a duplicate with `409`. If a later release adds a built-in whose name an admin-created source already uses, the built-in is skipped and a warning is logged.

> Earlier versions deactivated **every** source that was not in the registry on each restart, including ones you added. If you added a source before upgrading, check that it is still active; the upgrade will not reactivate it for you.

---

## Adding a regulation

**Sources** > **Add Source**, then fill in:

| Field | Notes |
|-------|-------|
| Name | Unique |
| Jurisdiction | Any code of 1 to 16 characters: `A-Z`, `0-9`, `-`. The dropdown suggests known codes (`EU`, `US-CA`, `UK`, ...) but you can type a new one, e.g. `BR-SP`. It is upper-cased |
| URL | `http` or `https`. URLs that point at private networks, loopback, link-local or cloud-metadata addresses are rejected |
| Parser | HTML or PDF |
| Ingestion mode | Auto (scraped from the URL) or Manual (you upload the document) |
| Category, tier | Free `lower_snake_case` category; tier 1 to 4 |
| Scrape frequency, headless | Operational settings |
| Content selector / page range, remove selectors | Parsing settings |

Then either run **Scrape** (the pipeline extracts rules with your LLM provider) or add rules by hand. For a regulation that is not on a scrapeable page, create a Manual source and upload the document, or skip the document entirely and write the rules yourself (see below).

---

## Editing and retiring a source

Click the pencil icon on a source card. You can change every field above. Saving a change to a built-in source's name, URL, jurisdiction, category, tier, parser, selectors, ingestion mode or headless flag turns it into **Customized**. Changing only the scrape frequency or the active flag does not.

**Restore built-in defaults** (the circular arrow on a Customized card) puts the registry values back, including the name, and hands the source back to the sync. It asks for confirmation because your edits to those fields are lost. It does not change whether the source is active.

**Deactivate** (trash icon, or click the Active badge):

- The source stops being scraped, audited and health-checked.
- **Its rules stop applying.** They are retired in the same step, so they disappear from `/api/v1/policies`, the policy bundle and hash, evaluation, the integrity check, and the live event stream announces the retirement. Each retirement is recorded in the rule history with the reason `source_deactivated`.
- Nothing is deleted. Reactivating the source restores exactly the rules its deactivation retired. A rule you retired by hand before that stays retired.

Rules cannot be added to an inactive source, and a rule of an inactive source cannot be reactivated on its own. Reactivate the source first.

---

## Adding and editing rules

**Rules** > **New rule**, or the checklist icon on a source for that source's rules. Fields:

| Field | Notes |
|-------|-------|
| Source | Must exist and be active |
| Rule key | Unique across all rules. Lowercase letters, digits, `_` and `.`, 3 to 128 characters, starting with a letter, for example `acme.art5.transparency`. Cannot be changed later |
| Jurisdiction | Defaults to the source's. Evaluation matches this code **exactly** |
| Category | One of `data_governance`, `transparency`, `risk_assessment`, `human_oversight`, `accountability`, `fairness`, `privacy`, `safety`, `security`, `intellectual_property` |
| Effect | `deny`, `allow_with_audit`, `require_disclosure` or `flag` |
| Severity | `critical`, `high`, `medium` or `low` |
| Conditions | A JSON object. The rule matches an evaluated action when **every** key equals the same-named value in the action's context. Values must be non-empty strings. The editor shows parse errors as you type |
| Summary, legal reference | Plain-language obligation and the citation |
| Effective date, expiry | `YYYY-MM-DD`; expiry must be after the effective date |
| Industries, scope, notes | Industries are comma-separated (`all` applies to every industry) |

Example conditions: `{"action": "text_generation", "sector": "healthcare"}`.

Editing a rule saves a new **version**, re-signs it, and records the change in its history (the clock icon): who changed it, when, and which fields. A save that changes nothing does not create a version. Retiring a rule (power-off icon) removes it from every policy surface immediately; reactivating it brings it back. A rule's key, source and history are never deleted.

---

## Locked rules and re-extraction

When the pipeline (or the document-ingest "forge" worker) extracts a rule whose key already exists, it normally replaces that rule's content with a new version. That would silently undo a correction.

So every rule you create or edit is **locked** (padlock badge). A re-extraction that produces a locked rule's key is **skipped**: the rule keeps your content and version, the skip is logged, and the run is not failed. The pipeline reports the number skipped as `rulesSkippedLocked` in its logs.

To let the pipeline take over a rule again, use **hand back to pipeline** (open padlock). Its content is not changed, but the next extraction that produces the same key will overwrite it with a new version.

Retiring a rule is independent of the lock: a retired rule stays retired across re-extraction.

---

## Integrity and signing

Every rule carries an Ed25519 signature over its key, version, jurisdiction, category, conditions, effect, severity, summary and legal reference. Rules written through the dashboard or API are signed by the same code that the integrity check (**Integrity** page, `POST /api/v1/admin/verify-integrity`) uses to verify them, so a created or edited rule passes the check. The policy hash (`/api/v1/policies/hash`) changes whenever an active rule is added, edited, retired or reactivated, and so do the `policyStateHash` values on new attestations.

Editing is refused with `409` if the rule's **stored** signature does not currently verify. Re-signing it would hide a tampered or corrupted rule; investigate the integrity failure first.

Rules are not retroactively changed in existing attestations: an attestation records the policy state it was evaluated against.

---

## Seeded rules and renamed built-in sources

The bundled rule sets (EU AI Act, GDPR, HIPAA, NIST, ISO 27001 and others) are seeded once per rule key and are never re-seeded over an existing rule, so your edits to a seeded rule persist across restarts. Seeders attach new rules to a source by name and jurisdiction; if you rename a built-in source, a rule key added by a *future* release may attach to a different source in the same jurisdiction. Existing rules stay with the source they belong to.
