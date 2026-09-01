<h1 align="center">Medplum Provider</h1>
<p align="center">A starter application for building a health record system on Medplum.</p>
<p align="center">
<a href="https://github.com/medplum/medplum-hello-world/blob/main/LICENSE.txt">
    <img src="https://img.shields.io/badge/license-Apache-blue.svg" />
  </a>
</p>

This example app demonstrates the following:

- Using [Medplum React Components](https://storybook.medplum.com/?path=/docs/medplum-introduction--docs) to display a chart that provides visibility on a patient
  - More information on a [charting experience](https://www.medplum.com/docs/charting)
- Using [Medplum GraphQL](https://graphiql.medplum.com/) queries to fetch linked resources

### Workflows

The application will feature the following core workflows:

- Visit documentation
- Task creation and assignment
- Appointment scheduling
- Patient registration/onboarding
- Lab orders
- Ordering medications
- Claim creation and billing
- Patient/Provider Messaging

### Getting Started

If you haven't already done so, follow the instructions in [this tutorial](https://www.medplum.com/docs/tutorials/register) to register a Medplum project to store your data.

[Fork](https://github.com/medplum/medplum-provider/fork) and clone the repo. Alternatively, this app lives in the [Medplum monorepo](https://github.com/medplum/medplum) at `examples/medplum-provider` — if you are working from the monorepo, run `npm ci` and `npm run build` at the repo root first so the workspace packages are built.

Next, install the dependencies.

```bash
npm install
```

Then, run the app

```bash
npm run dev
```

This app should run on `http://localhost:3001/`

By default, the app connects to the hosted Medplum service at `https://api.medplum.com/`.

### Running against a local Medplum server

To run against a Medplum server on your own machine, follow the [Run the stack](https://www.medplum.com/docs/contributing/run-the-stack) guide to start the API server on port 8103, then edit `.env` in this directory:

```
MEDPLUM_BASE_URL=http://localhost:8103/
```

Restart `npm run dev` after changing `.env`.

### Metriport integration

The patient chart has a **Metriport** tab that embeds the
[Metriport patient view](https://docs.metriport.com/medical-api/getting-started/embedding) for the
open patient.

Everything that needs the Metriport API key runs in Medplum Bots in [`bots/`](./bots), never in the
browser. The tab and its route only appear in projects where the embed token bot is deployed.

| Bot                      | Role                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `metriport-embed-token`  | Creates the short-lived embed token for the open chart. Required for the tab.      |
| `metriport-link-patient` | Links the chart to a Metriport patient: match, else create. Optional but expected. |

The embed bot resolves which Metriport patient to open from the Medplum `Patient.identifier`, so the
caller cannot choose it. Both bots record an `AuditEvent` — token issuance as a record access, and
sending demographics to Metriport as a disclosure — with references and opaque IDs only, no PHI
values.

#### Deploying the bots

The Medplum CLI needs Node 22 or later. On Node 20 it fails with `ReferenceError: WebSocket is not defined`.

```bash
cd bots
nvm use 22
npm install
npx medplum login          # or put a ClientApplication id/secret in bots/.env, see bots/.env.example
npm run deploy             # build, find or create the bot by name, then deploy
```

Bot IDs differ per project, so none is committed: only `medplum.config.template.json` is tracked,
and `npm run deploy` locates each bot in the project you are logged in to, creates the missing ones,
stamps the identifier the app addresses it with, and writes the resolved IDs into the generated
`medplum.config.json`.

The app executes the bots by identifier — `https://medplum.com/integrations/metriport|<bot name>` —
the same way this app already calls its DoseSpot, ScriptSure, Health Gorilla, and Candid bots. No Bot
ID appears in the app or in tracked config.

#### Project secrets

Set these in [Project Admin → Secrets](https://app.medplum.com/admin/secrets). The bots read them at
run time.

| Secret                               | Required | Notes                                             |
| ------------------------------------ | -------- | ------------------------------------------------- |
| `METRIPORT_API_KEY`                  | yes      | Must match the environment below                  |
| `METRIPORT_ENV`                      | no       | `sandbox` (default) or `production`               |
| `METRIPORT_TOKEN_EXPIRATION_SECONDS` | no       | Default 900, max 36000                            |
| `METRIPORT_FACILITY_ID`              | no       | Needed to create patients; see the fallback below |

Sandbox tokens only work with sandbox embed URLs and production tokens only with production URLs.
The bots pair them for you.

Without `METRIPORT_FACILITY_ID`, the link patient bot falls back to the
`https://metriport.com/fhir/identifiers/organization-id` identifier on the patient's managing
`Organization`, and refuses to create a patient when neither is available.

Give the bots an `AccessPolicy` that allows only `Patient` read and write plus `AuditEvent` write,
and restrict which project members may execute them — see the security note below.

#### Linking a patient to Metriport

The tab shows "This patient is not linked to Metriport" until the Medplum Patient carries the
Metriport patient ID as an identifier:

```json
{ "system": "https://metriport.com/fhir/identifiers/patient-id", "value": "<metriport patient uuid>" }
```

With `metriport-link-patient` deployed, this happens by itself the first time someone opens the
Metriport tab for an unlinked patient:

1. The patient's demographics go to Metriport's
   [match](https://docs.metriport.com/medical-api/api-reference/patient/match-patient) endpoint. A
   hit stores the ID on the Patient and the record loads.
2. No match, and the patient is
   [created](https://docs.metriport.com/medical-api/api-reference/patient/create-patient) under the
   configured facility with `externalId` set to the Medplum Patient ID, then linked.

**Opening the tab therefore discloses the patient's demographics to Metriport**, without a separate
confirmation step. Each attempt is recorded as a disclosure `AuditEvent`. Restrict who may execute
the bot if that is wider than you want.

Metriport validates the demographics and names the field it rejects, for example
`Zip must be a string consisting of 5 numbers, on [address,0,zip]`. The tab shows that reason as-is,
rather than repeating Metriport's rules in this codebase where they would drift. Metriport needs at
least first and last name, date of birth, gender, and a US address.

The bot is idempotent: an already-linked patient returns its existing ID without contacting
Metriport.

To test in sandbox, copy the demographics of one of the personas in
[Sandbox Mode](https://docs.metriport.com/medical-api/getting-started/sandbox) onto a Medplum
Patient. Those personas already exist in the sandbox and carry example clinical data, so the match
resolves on the first view. Copy the whole record from that page, not just the name — the match runs
on name, date of birth, gender, and address together.

To link by hand instead, write the identifier in the Medplum app under
**Patient → Edit → Identifier → Add**, or with the CLI, appending to any identifiers the patient
already has:

```bash
npx medplum patch Patient/MEDPLUM_PATIENT_ID \
  '[{"op":"add","path":"/identifier/-","value":{"system":"https://metriport.com/fhir/identifiers/patient-id","value":"METRIPORT_PATIENT_ID"}}]'
```

If the patient has no identifiers yet, patch `"path": "/identifier"` with an array value instead —
appending to a missing array fails.

#### Security note

A Metriport embed token authorizes the embedded app for the whole Metriport account; only the URL
path selects the patient. The bot decides which patient the app opens, but the token it returns to
the browser could still be pointed at another Metriport patient by anyone who knows that patient ID.
Metriport does not offer a patient-scoped token today. Reduce the exposure with a short token
lifetime, an `AccessPolicy` that limits who may execute the bot, and the `AuditEvent` trail the bot
writes.

### A note on value sets

Some fields in this app (diagnoses, medications, race/ethnicity, and others) autocomplete against clinical terminologies such as ICD-10, RxNorm, and US Core / VSAC value sets. On hosted Medplum, these are provided by shared projects [linked](https://www.medplum.com/docs/access/projects#project-linking) into your project. A fresh self-hosted or local server includes only the base FHIR R4 terminology, so these fields will show a "ValueSet not found" message inline and you will need to enter codes manually. To enable them, upload the value sets and import their code systems into a shared project (see [`CodeSystem/$import`](https://www.medplum.com/docs/api/fhir/operations/codesystem-import)) and link that project, or contact Medplum for access to the hosted terminology.

### About Medplum

[Medplum](https://www.medplum.com/) is an open-source, API-first EHR. Medplum makes it easy to build healthcare apps quickly with less code.

Medplum supports self-hosting and provides a [hosted service](https://app.medplum.com/). Medplum Hello World uses the hosted service as a backend.

- Read our [documentation](https://www.medplum.com/docs)
- Browse our [react component library](https://storybook.medplum.com/)
- Join our [Discord](https://discord.gg/medplum)
