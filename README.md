# alerts

[![CI](https://github.com/openasy/alerts/actions/workflows/ci.yml/badge.svg)](https://github.com/openasy/alerts/actions/workflows/ci.yml)
[![Node.js 26 LTS](https://img.shields.io/badge/node-26%20LTS-339933?logo=nodedotjs&logoColor=white)](./.nvmrc)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)

The [OpenAsy](https://github.com/openasy) Alerts product: **the right person told about the right problem, once, at
any hour** (ADR 0059). Prometheus, products and scripts send alerts; Alerts groups those of one problem, routes them
to the team that owns them, holds back what a silence covers, and tells whoever is on call by Slack, Teams or any
webhook, again until someone acknowledges and to someone else when nobody does.

```
Prometheus, vmalert ──POST /api/v2/alerts──┐
products, scripts ────POST /api/v1/alerts──┼──▶  alerts  ──▶ route ──▶ group ──▶ Slack, Teams, webhook
an Alertmanager webhook ───────────────────┘        └── silences          └── on call: Ayşe
```

## Alerts in

An alert is a set of labels, annotations people read (`summary`, `description`), a start and an end, as Prometheus
sends them to an Alertmanager. The same labels are the same alert: send it again while it holds. It resolves at its
`endsAt`, or after the resolve timeout (five minutes) when it is not sent again.

Your alerting rules stay where they are. Prometheus and vmalert take Alerts as their Alertmanager:

```yaml
alerting:
  alertmanagers:
    - scheme: https
      authorization: { credentials: <ALERTS_INGEST_TOKEN> }
      static_configs: [{ targets: [alerts.example.com] }]
```

A product or script posts the same shape to `/api/v1/alerts`, and an Alertmanager you keep can post its webhook
there, with the status of each alert.

```bash
curl -sf -X POST -H "Authorization: Bearer $ALERTS_INGEST_TOKEN" -H 'content-type: application/json' \
  --data '[{"labels":{"alertname":"BackupFailed","team":"db"},"annotations":{"summary":"Nightly backup of db-1 failed"}}]' \
  https://alerts.example.com/api/v1/alerts
```

## Routes, groups and notifications

- **Routes** are tried in order; the first whose label matchers (`=`, `!=`, `=~`, `!~`, anchored as in Alertmanager)
  all match takes the alert. A route with no matchers takes everything left; an alert no route takes is shown as
  unrouted and nobody is told.
- A route **groups** its alerts by the values of some labels, `alertname` unless set: one group is one problem, and
  one notification.
- A group is told of **30 seconds** after its first alert, so alerts of the same problem go out together; of a change
  at most every **five minutes**; **again** every repeat interval (four hours unless set) until someone
  **acknowledges** it; to the **escalation** contact once when nobody has after the route's escalation time; and when
  it **resolves**. A new alert in the group needs a new acknowledgement.
- **Silences** match labels for a time, at most 30 days, with a reason. They stop notifications, never the alerts,
  which stay on the screens as silenced.
- A **schedule** names who is on call: members take turns of a shift each. A route's schedule puts the person on call
  in each notification; a Slack user id mentions them.
- **Contact points** are a Slack incoming webhook, a Teams workflow that posts the Adaptive Card it is sent, or any
  webhook, which gets the whole group as JSON: the way to a phone or SMS provider. Their addresses hold a secret, so
  they are sealed with `openasy-kek` and never shown again in full. A test message shows a wrong one now rather than
  at 02:00. Every notification is kept with whether it got through.

## Run

```bash
openssl rand -hex 32 > openasy-kek
export ALERTS_INGEST_TOKEN=$(openssl rand -hex 32)
docker compose up -d
docker compose logs alerts | grep 'no owner yet'
```

Open the link from the log once to create the owner account; there is no default password (ADR 0013). The UI and API
are on http://localhost:8080, the API reference at http://localhost:8080/api/docs/.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `ALERTS_PUBLIC_URL` | `http://localhost:8080` | The address people open, with `https://` behind your TLS proxy; notifications link to it |
| `ALERTS_INGEST_TOKEN` | | Lets Prometheus, products and scripts send alerts and nothing else. An API token with the editor role works too |
| `ALERTS_GROUP_WAIT_SECONDS` | `30` | Wait after a group's first alert before telling of it |
| `ALERTS_GROUP_INTERVAL_SECONDS` | `300` | Tell of a change to a group at most this often |
| `ALERTS_RESOLVE_TIMEOUT_SECONDS` | `300` | An alert without an end resolves this long after it was last sent |
| `OPENASY_PRODUCTS` | | The install's other OpenAsy products, for the product switcher |
| `ALERTS_SECRETS_KEY_FILE` | `/run/secrets/openasy-kek` | 32-byte key-encryption key |
| `ALERTS_DB` | `/data/alerts.db` | SQLite file (WAL), on the `/data` volume |
| `ALERTS_RETENTION_DAYS` | `90` | Notifications and ended silences older than this are deleted |
| `ALERTS_METRICS_PORT` | | Serve `/metrics` on this port only (ADR 0026) |
| `ALERTS_HEADLESS` | `false` | `true` serves only the API |
| `ALERTS_PASSWORD_SIGN_IN`, `OPENASY_OIDC_*` | | Sign-in, as in every OpenAsy product ([@openasy/auth](https://github.com/openasy/auth)) |

`/metrics` has `openasy_alerts_firing`, `openasy_alerts_groups_unacknowledged`, `openasy_alerts_silenced` and
`openasy_alerts_notifications_failed`. Watch the last one from a system other than Alerts: a broken contact point is
the one problem Alerts cannot tell you about.

The container runs as non-root with a read-only root filesystem, no capabilities and `no-new-privileges`.

## Roles

Viewers see everything; editors also acknowledge, silence, keep schedules and test contact points; admins also add
contact points and change routes, and manage members and API tokens (ADR 0003).

## Not yet

Email, phone calls and SMS are not sent directly: use a webhook to your provider. Alerting rules are evaluated by
Prometheus or vmalert, not by Alerts. Opening an incident in Incidents for a severe group, overrides of a schedule and
approving from Slack are planned.

## Develop

```bash
npm install
npm test        # matchers, grouping, waits, repeats, escalation, silences, schedules, and every API response against openapi.json
npm run dev     # the UI, with the API on :8080
```

## Licence

AGPL-3.0 (ADR 0008).
