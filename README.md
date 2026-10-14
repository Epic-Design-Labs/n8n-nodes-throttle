# @usethrottle/n8n-nodes-throttle

n8n community nodes for [Throttle](https://usethrottle.dev), the managed commerce API.

- **Throttle** reads and acts on orders, customers, subscriptions, quotes, invoices, payments, discounts and analytics. It also works as a tool for n8n's AI Agent.
- **Throttle Trigger** starts a workflow when an order, payment, subscription, quote, cart or invoice event happens.

[Installation](#installation) · [Credentials](#credentials) · [Operations](#operations) · [Trigger](#trigger) · [Compatibility](#compatibility) · [Resources](#resources)

## Installation

Follow n8n's [community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/). On a self-hosted instance: **Settings → Community Nodes → Install**, package name `@usethrottle/n8n-nodes-throttle`.

## Credentials

Create a **Throttle API** credential with a secret key (`sk_...`) from the API keys page of your application in the Throttle dashboard. The key is sent as an `X-API-Key` header, and n8n checks it against `GET /api/v1/whoami` when you save.

A key is pinned to one workspace, application and environment, and its scopes decide which operations it can run. Build with a key from a non-production environment and add a second credential for production. When the key is missing a scope, the error names the scopes the operation needs. Publishable keys (`pk_...`) don't work here.

## Operations

| Resource | Operations |
| --- | --- |
| Analytics | Business summary, attention digest, sales timeseries, top products, customer growth, revenue breakdown, funnel conversion, subscription movement, discount performance |
| Cart | Get many abandoned |
| Checkout | Create link |
| Customer | Create, update, get many |
| Discount | Get, get many |
| Event | Get many |
| Extension | Get many installations |
| Invoice | Get, get many, receivables aging |
| Order | Get many |
| Payment | Get many, refund |
| Quote | Create, send, get, get many |
| Subscription | Get, get many, pause, resume, cancel, set payment method |
| Webhook Delivery | Get, get many, replay, send test |
| Workspace | Connection, settings, audit log, applications |

List operations have **Return All** / **Limit** and return one item per record. Amounts are integers in minor units (`2500` = $25.00).

Every write sends an idempotency key built from the execution, node and item. A step that n8n retries with *Retry On Fail* lands on the record the first attempt created. The next execution of the workflow sends a new request.

- **Refund** requires an explicit amount. The API treats a missing amount as a full refund, so the node refuses to send a request without one.
- **Cancel** never refunds.
- **Send** (quote) emails the buyer.

## Trigger

Select one or more events: Order Created, Payment Captured, Payment Failed, Subscription Created, Subscription Cancelled, Quote Accepted, Cart Abandoned, Invoice Past Due.

- **Endpoint lifecycle.** Activating the workflow creates a webhook endpoint in the key's environment, subscribed to exactly those events. Deactivating it deletes the endpoint.
- **Requirements.** The key needs `webhooks:write` plus each event's read scope, for example `orders:read`. Throttle only delivers to `https://` URLs, so n8n must be reachable on a public HTTPS address.
- **Signature verification.** Every delivery's `X-Throttle-Signature` (HMAC-SHA256) is checked before the workflow runs. Unsigned, tampered or older-than-five-minutes deliveries get a 401.
- **Output.** Each event is flattened: the record's fields sit at the top level, alongside `resourceId`, `eventId`, `eventType`, `eventCreatedAt` and `environmentId`.
- **Retries.** Throttle retries failed deliveries. `eventId` is the same on every attempt, so deduplicate on it.

## Compatibility

Requires n8n 1.x with `n8nNodesApiVersion` 1, and Node.js 22 or later.

## Resources

- [Throttle n8n documentation](https://usethrottle.dev/docs/developers/n8n)
- [Throttle API reference](https://usethrottle.dev/docs/developers/api-reference)
- [Webhook signatures](https://usethrottle.dev/docs/developers/webhooks)
- [n8n community nodes](https://docs.n8n.io/integrations/#community-nodes)

## Development

The operations are generated from Throttle's action catalog (`@core/action-catalog`), the same source as Throttle's MCP server and Zapier app. The generated catalog is in `nodes/Throttle/catalog.json`. To regenerate it inside the Throttle monorepo:

```bash
npm run generate   # reads packages/action-catalog, fails on any unmapped n8n-channel action
npm run build && npm test && npm run lint
```

`npm run dev` starts a local n8n with the nodes loaded.

## License

[MIT](LICENSE.md)
