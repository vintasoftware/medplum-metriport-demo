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
open patient. The tab and its route only appear in projects where the bot below is deployed.

Embedding needs a short-lived embed token, and creating one requires the Metriport API key. The key
must never reach the browser, so the token is created by the `metriport-embed-token` Medplum Bot in
[`bots/`](./bots). The bot resolves which Metriport patient to open from the Medplum
`Patient.identifier`, so the caller cannot choose it, and records every issued token as an
`AuditEvent` (references only, no PHI values).

#### Deploying the bot

The Medplum CLI needs Node 22 or later. On Node 20 it fails with `ReferenceError: WebSocket is not defined`.

```bash
cd bots
nvm use 22
npm install
npx medplum login          # or put a ClientApplication id/secret in bots/.env, see bots/.env.example
npm run deploy             # build, find or create the bot by name, then deploy
```

Bot IDs differ per project, so none is committed: only `medplum.config.template.json` is tracked,
and `npm run deploy` finds the bot named `metriport-embed-token` in the project you are logged in
to, creates it when missing, and writes the resolved ID into the generated `medplum.config.json`.
The app finds the same bot by name.

#### Project secrets

Set these in [Project Admin → Secrets](https://app.medplum.com/admin/secrets). The bot reads them at
run time.

| Secret                               | Required | Notes                               |
| ------------------------------------ | -------- | ----------------------------------- |
| `METRIPORT_API_KEY`                  | yes      | Must match the environment below    |
| `METRIPORT_ENV`                      | no       | `sandbox` (default) or `production` |
| `METRIPORT_TOKEN_EXPIRATION_SECONDS` | no       | Default 900, max 36000              |

Sandbox tokens only work with sandbox embed URLs and production tokens only with production URLs.
The bot pairs them for you.

Give the bot an `AccessPolicy` that allows only `Patient` read and `AuditEvent` write, and restrict
which project members may execute it — see the security note below.

#### Linking a patient to Metriport

The tab shows "This patient is not linked to Metriport" until the Medplum Patient carries the
Metriport patient ID as an identifier:

```json
{ "system": "https://metriport.com/fhir/identifiers/patient-id", "value": "<metriport patient uuid>" }
```

Get that ID from the Metriport dashboard, or from the
[match](https://docs.metriport.com/medical-api/api-reference/patient/match-patient) or
[create](https://docs.metriport.com/medical-api/api-reference/patient/create-patient) patient
endpoints. To create the link automatically instead of by hand, deploy `metriport-patient-bot` from
[medplum-demo-bots](https://github.com/medplum/medplum/tree/main/examples/medplum-demo-bots/src/metriport-bots).
In sandbox, create the Metriport patient with first name `Jane`, `Chris`, or `Kyla` to get example
clinical data — see [Sandbox Mode](https://docs.metriport.com/medical-api/getting-started/sandbox).

Write the identifier in the Medplum app under **Patient → Edit → Identifier → Add**, or with the CLI,
appending to any identifiers the patient already has:

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
