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

This project runs on Node 22 or later, which is pinned in `.nvmrc`.

```bash
nvm use
```

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

[Metriport](https://docs.metriport.com/medical-api) is a third-party health data API. This app calls
its public Medical API with an account key, and adds a **Metriport** tab to the patient chart. That
tab has two views: the
[Metriport patient view](https://docs.metriport.com/medical-api/getting-started/embedding) in an
`iframe` — a page Metriport hosts, which this app only frames, called "the embedded patient view"
below — and an import view of this app's own.

You need a Metriport account and an API key. Set up the three bots and the project secrets below, and
the tab appears. Everything that needs the API key runs in Medplum Bots in [`bots/`](./bots), never
in the browser, and the tab and its route only appear where the embed token bot is deployed.

| Bot                      | Role                                                                          |
| ------------------------ | ----------------------------------------------------------------------------- |
| `metriport-embed-token`  | Creates the short-lived embed token for the open chart. Required for the tab. |
| `metriport-link-patient` | Connects the chart: match or create the patient, then start a network query.  |
| `metriport-consolidated` | Reads the patient's records back out of Metriport, for review and import.     |

The embed bot resolves which Metriport patient to open from the Medplum `Patient.identifier`, so the
caller cannot choose it. Both bots record an `AuditEvent` — token issuance as a record access, and
sending demographics to Metriport as a disclosure — with references and opaque IDs only, no PHI
values.

#### Deploying the bots

```bash
cd bots
nvm use
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

| Secret                               | Required | Notes                                                    |
| ------------------------------------ | -------- | -------------------------------------------------------- |
| `METRIPORT_API_KEY`                  | yes      | Must match the environment below                         |
| `METRIPORT_ENV`                      | no       | `sandbox` (default) or `production`                      |
| `METRIPORT_TOKEN_EXPIRATION_SECONDS` | no       | Default 900, max 36000                                   |
| `METRIPORT_FACILITY_ID`              | no       | Needed to create patients; see the fallback below        |
| `METRIPORT_NETWORK_QUERY_SOURCES`    | no       | Comma separated: `hie`, `pharmacy`, `lab`. Default `hie` |

Sandbox tokens only work with sandbox embed URLs and production tokens only with production URLs.
The bots pair them for you.

Without `METRIPORT_FACILITY_ID`, the link patient bot falls back to the
`https://metriport.com/fhir/identifiers/organization-id` identifier on the patient's managing
`Organization`, and refuses to create a patient when neither is available.

Give the bots an `AccessPolicy` that allows only `Patient` read and write plus `AuditEvent` write,
and restrict which project members may execute them — see the security note below. The consolidated
bot needs nothing more: it reads from Metriport and returns the records to the browser, and the
provider's own session writes them into the chart.

#### Linking a patient to Metriport

The tab shows "This patient is not connected to Metriport" until the Medplum Patient carries the
Metriport patient ID as an identifier. That identifier is also how the tab knows, so an unconnected
patient costs no bot execution at all:

```json
{ "system": "https://metriport.com/fhir/identifiers/patient-id", "value": "<metriport patient uuid>" }
```

With `metriport-link-patient` deployed, the tab shows a **Connect to Metriport** button for a patient with no Metriport ID. Pressing it:

1. Sends the patient's demographics to Metriport's
   [match](https://docs.metriport.com/medical-api/api-reference/patient/match-patient) endpoint. A
   hit stores the ID on the Patient.
2. On no match,
   [creates](https://docs.metriport.com/medical-api/api-reference/patient/create-patient) the patient
   under the configured facility with `externalId` set to the Medplum Patient ID, then links it.
3. Starts a [network query](https://docs.metriport.com/medical-api/api-reference/network/start-network-query),
   because registering a patient does not search the networks on its own. Results take minutes to
   arrive, and reach Metriport's record, not Medplum's — see the plan for ingesting them.

**Nothing reaches Metriport until a provider presses that button.** Opening the chart discloses
nothing. Each attempt is recorded as a disclosure `AuditEvent`. Pressing it again for an already
connected patient does nothing: the bot returns the stored ID without contacting Metriport.

Metriport needs at least a first and last name, a date of birth, a gender and a US address. It
validates them and names the field it rejects, for example
`Zip must be a string consisting of 5 numbers, on [address,0,zip]`, and the tab shows that reason
as-is.

**A connected patient cannot be re-queried from this app yet.** The button only appears while the
patient has no Metriport ID, so the network query runs once. Records reaching the networks later are
not picked up — re-query from the Metriport dashboard.

To test in sandbox, copy the demographics of one of the personas in
[Sandbox Mode](https://docs.metriport.com/medical-api/getting-started/sandbox) onto a Medplum
Patient. Copy the whole record, not just the name: the match runs on name, date of birth, gender and
address together.

To link a patient by hand, add the identifier in the Medplum app under
**Patient → Edit → Identifier → Add**, or with the CLI:

```bash
npx medplum patch Patient/MEDPLUM_PATIENT_ID \
  '[{"op":"add","path":"/identifier/-","value":{"system":"https://metriport.com/fhir/identifiers/patient-id","value":"METRIPORT_PATIENT_ID"}}]'
```

If the patient has no identifiers yet, patch `"path": "/identifier"` with an array value instead —
appending to a missing array fails.

#### Importing records from Metriport

The Metriport tab has two views. **Patient record** is the embedded patient view, which is read only.
**Import records** lists what Metriport holds for the patient and writes the ones a provider ticks
into the chart. Both views are addressed by the URL (`?view=import&category=problems`), so a refresh
or a shared link lands in the same place.

Four categories can be imported — problems, allergies, medications and immunizations — because each
has a section in the Medplum patient summary to land in. The embedded patient view shows more than
that, and the import view says so on screen, so the difference reads as a known gap.

The counts in the import view will not always match the numbers in the embedded patient view. The
import view counts FHIR records; the embedded view groups them, so one problem recorded at four
visits is four records in one list and often one line in the other.

Each view pays only for itself. The embed token is created when the patient record view is shown,
not when the tab opens, so a link straight to `?view=import` mints no Metriport credential and its
own read starts on the first render. What Metriport answers is then kept for as long as the view is
open, so going back to the category list and opening a category again, or returning to a date range
already read, costs nothing; the refresh button and the retry both drop it and ask again. The chart
is read again every time, because an import changes what it says.

Two things to know when setting this up:

- **The first read after a network query is slow and will fail.** Metriport prepares the data on
  demand, and that takes longer than a bot may run. The view says so and offers a retry, which
  succeeds. Medplum allows a bot 10 seconds by default, so the template sets `"timeout": 60` on
  `metriport-consolidated` and `npm run deploy` patches it onto the `Bot`. A project whose maximum is
  lower will refuse that value.
- **Records already in the chart are marked and cannot be imported twice.** Every entry is written as
  a conditional create, so a repeated import writes nothing.

The import is a FHIR transaction sent with the provider's own credentials, so your project
`AccessPolicy` decides what may enter the chart, and Medplum audits the writes. The bot itself needs
no write access for this.

Resource types are allowlisted in the bot rather than chosen by the browser: `AllergyIntolerance`,
`Condition`, `Immunization`, `MedicationAdministration`, `MedicationDispense`, `MedicationRequest`
and `MedicationStatement`. Widening the import view means widening that list too.

#### Security note

A Metriport embed token authorizes the embedded app for the whole Metriport account; only the URL
path selects the patient. The bot decides which patient the app opens, but the token it returns to
the browser could still be pointed at another Metriport patient by anyone who knows that patient ID.
Metriport does not offer a patient-scoped token today. Reduce the exposure with a short token
lifetime, an `AccessPolicy` that limits who may execute the bot, and the `AuditEvent` trail the bot
writes. The app asks for a token only when the view that frames Metriport is on screen, so fewer
are issued than there are visits to the tab.

### A note on value sets

Some fields in this app (diagnoses, medications, race/ethnicity, and others) autocomplete against clinical terminologies such as ICD-10, RxNorm, and US Core / VSAC value sets. On hosted Medplum, these are provided by shared projects [linked](https://www.medplum.com/docs/access/projects#project-linking) into your project. A fresh self-hosted or local server includes only the base FHIR R4 terminology, so these fields will show a "ValueSet not found" message inline and you will need to enter codes manually. To enable them, upload the value sets and import their code systems into a shared project (see [`CodeSystem/$import`](https://www.medplum.com/docs/api/fhir/operations/codesystem-import)) and link that project, or contact Medplum for access to the hosted terminology.

### About Medplum

[Medplum](https://www.medplum.com/) is an open-source, API-first EHR. Medplum makes it easy to build healthcare apps quickly with less code.

Medplum supports self-hosting and provides a [hosted service](https://app.medplum.com/). Medplum Hello World uses the hosted service as a backend.

- Read our [documentation](https://www.medplum.com/docs)
- Browse our [react component library](https://storybook.medplum.com/)
- Join our [Discord](https://discord.gg/medplum)
