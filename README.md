# Shared Health Record (SHR)

Postgres-backed Shared Health Record with FHIR R4 referral / back-referral between three EMRs,
following the Project Workstreams flow: **EMR -> API Manager -> Orchestrator -> PhilSys / NHFR / NHWR / FHIR validation -> Shared Health Record**.

Needs only **Node 20+**. No database install: it runs an embedded Postgres (PGlite) and keeps data in the `data/` folder.

## Run it (Windows PowerShell, Mac or Linux)

```bash
cd shr            # the folder containing package.json
npm install       # installs the app dependencies
npm start         # http://localhost:3000
```

Open http://localhost:3000. Optional, in a second terminal: `npm test` (end-to-end checks) and `npm run reset` (wipe referrals / FHIR data, keep registries). To start completely fresh, stop the server and delete the `data/` folder.

### Using real Postgres instead
Set `DATABASE_URL`; the app uses a reusable `pg` connection pool (the same SQL runs on PGlite and real Postgres):
```bash
export DATABASE_URL=postgresql://postgres:PASSWORD@localhost:5432/shr   # PowerShell: $env:DATABASE_URL="..."
npm run migrate && npm start
```
For hosted Supabase, use the database connection string and pooler settings recommended for your deployment.

### Using Supabase
The schema is a standard Supabase migration (`supabase/migrations/`), so either:
- **Local Supabase:** `supabase start`, then `export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres` and `npm run migrate`.
- **Hosted Supabase:** `supabase db push`, then set `DATABASE_URL` to the project's Postgres connection string.

All tables have RLS enabled with no policies, so the Supabase public API (anon/authenticated) cannot read them.
Only this server (connecting as the table owner) can. Do not expose them through PostgREST without writing policies.

### FHIR requirements catalog
[`schema/shared_health_record_schema.csv`](schema/shared_health_record_schema.csv) is the source requirements catalog: 142 element-level requirements across 27 FHIR R4 resource types. The migration imports it into `shr_profile_requirements`, which is available in Supabase's Table Editor and Schema Visualizer. The catalog preserves each element path, cardinality, datatype, requirement level, guidance, reference targets, and source-file SHA-256. Row-level security is enabled with no public policies.

This catalog documents SHR requirements; it does not by itself make the runtime validator enforce every listed resource or certify full FHIR/profile conformance. The runtime validator remains limited to the resources and rules implemented by this demo.

## What's in the dashboard (`/`)
- **SHR Dashboard** - counts, a searchable **Patient records** directory with demographics, FHIR resources grouped by type and referral history, resources by type, referral threads, **raw `fhir_resources` rows** (click a row for the full JSON; filter by type, patient or text), and audit trail.
- **EMR 1 / EMR 2 / EMR 3** - each is a mini EMR: search the SHR for an existing patient by name or PhilSys ID and select the match to prefill demographics plus active conditions, latest observations, and active medications from the patient's shared FHIR record. The imported clinical details are editable; review their dates and relevance before sending. Each EMR can also see its **inbox**, mark a referral received, **Get Patient Record**, and send a **back-referral**. Every send shows the orchestrator step trail.

Demo EMRs: EMR 1 = Rural Health Unit, EMR 2 = District Hospital, EMR 3 = Provincial Hospital.

## Flow and FHIR mapping
| Step | What happens | FHIR |
|---|---|---|
| Referral | EMR POSTs `/api/referrals` | Transaction Bundle: Patient, Organization x2, Practitioner, Encounter, Condition, Observation, MedicationStatement, **ServiceRequest** (the referral), **Task** (workflow) |
| Validation | Orchestrator checks PhilSys (patient), NHFR (both facilities), NHWR (worker belongs to sending facility), then FHIR structure + reference integrity | - |
| Store | `shr_ingest()` writes every resource atomically as jsonb, keeps prior versions, writes the audit row | `meta.versionId` increments |
| Back-referral | Receiving EMR POSTs `/api/referrals/:id/back-referral` | New Encounter, Condition, Observation, MedicationRequest, **Communication**; the original ServiceRequest and Task become new **versions** with `status: completed` |
| Get Patient Record | `GET /api/patients/:philsys/record` | `searchset` Bundle of the patient's resources plus exactly referenced Organizations and Practitioners |

## API
EMR calls need header `x-api-key` (demo keys: `demo-key-emr1`, `demo-key-emr2`, `demo-key-emr3`).
The machine-readable OpenAPI 3.1 contract is served at `/openapi.json`. A reusable Node.js client for EMR backend integrations is available at `src/emr-client.js`:

```js
const { createEmrClient } = require('./src/emr-client');

async function main() {
  const shr = createEmrClient({
    baseUrl: process.env.SHR_API_BASE_URL || 'http://127.0.0.1:3000',
    apiKey: process.env.SHR_API_KEY,
  });

  await shr.checkHealth();
  const matches = await shr.searchPatients('Maria Santos');
  const inbox = await shr.getInbox();
  // Use a selected patient's PhilSys ID:
  const record = await shr.getPatientRecord(matches[0].philsys_id);
}

main().catch((error) => {
  console.error('SHR integration failed:', error.message);
  process.exitCode = 1;
});
```

Configure browser-based EMR frontends with an explicit comma-separated origin allowlist, for example `CORS_ALLOWED_ORIGINS=https://emr-one.example,https://emr-two.example`. CORS is disabled for cross-origin callers by default and is limited to the authenticated EMR integration paths; dashboard/admin routes do not receive CORS permission. CORS is not authentication. Prefer calling from each EMR's backend and keep `x-api-key` in a server-side secret store. Do not put production API keys in browser code.

For actual remote EMRs, the server must be reachable at a trusted API URL. Keep the default loopback binding for development. Do not expose this demo directly to the public internet: the dashboard and demo credential endpoint are unauthenticated, demo keys are predictable, and patient access has no consent or care-relationship enforcement. Use a secured deployment with TLS, network restrictions, real per-EMR credentials, and reviewed access controls before connecting real systems or data.

- `POST /api/referrals`, `POST /api/referrals/:id/back-referral`, `POST /api/referrals/:id/receive`
- `GET /api/health` (checks database/API availability)
- `GET /api/inbox`, `GET /api/outbox`, `GET /api/patients/search?q=<name-or-id>`, `GET /api/patients/:philsys/record`
- FHIR read (no key, localhost): `GET /fhir/metadata`, `/fhir/{Type}?patient=<philsys>`, `/fhir/{Type}/{id}`, `/fhir/{Type}/{id}/_history`
- Dashboard (no key): `/api/shr/stats`, `/api/shr/patients`, `/api/shr/patients/:philsys`, `/api/shr/raw`, `/api/referrals`, `/api/audit`

Example referral payload:

```json
{
  "patientPhilsysId": "2345-6789-0123-4567",
  "toEmr": "EMR2",
  "practitionerNhwr": "NHWR-1001",
  "reason": "Needs specialist assessment",
  "service": "Specialist consult",
  "priority": "urgent"
}
```

## Optional FHIR conformance check
The server's built-in validator checks the demo's supported resource fields and references; it is not a full FHIR profile validator. For an additional check, `npm run validate:fhir` invokes the official HL7 FHIR Validator CLI against a saved FHIR JSON bundle. This is an opt-in developer tool and does not change server behavior or add runtime dependencies.

1. Download and pin the HL7 `validator_cli.jar` version used by your team from the [FHIR Validator project](https://github.com/hapifhir/org.hl7.fhir.core).
2. Set its path and run the validator. To check against a published implementation guide, pass that guide's exact package id and version with `--ig`.

```powershell
$env:FHIR_VALIDATOR_JAR = "C:\tools\validator_cli.jar"
npm run validate:fhir -- .\path\to\transaction-bundle.json --ig "package-id#version"
```

The [Philippines FHIR Connectathon repository](https://github.com/UPM-NTHC/June-2026-Philippines-FHIR-Connectathon) contains PH eReferral examples and materials. Its README marks the PH Core and eReferral guides as drafts; confirm the current package id/version and profile requirements before validating against them. A successful check against a draft guide is not production certification.

## Limitations (read before using real data)
- **Demo only.** Fictional patients; the server binds to `127.0.0.1`. The dashboard hands out the demo API keys at `/api/demo/config` and the read endpoints have no auth. Do not expose this to a network or use real patient data as is.
- PhilSys / NHFR / NHWR are **local tables**, not integrations with the real registries.
- Identifier system URLs in `src/fhir.js` are placeholders (`https://example.org/...`). Swap in the official systems and PH Core profiles.
- Runtime validation remains **structural** (required elements, code values, reference integrity); the optional CLI check validates saved bundles, not live requests.
- Any authenticated EMR can read any patient's record (every read is audited). There is no patient consent or care-relationship check.
- Embedded PGlite is single-user and meant for demos. For production use a real Postgres/Supabase with `DATABASE_URL`; real Postgres connections use the `pg` pool.
