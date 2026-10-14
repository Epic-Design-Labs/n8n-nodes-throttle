# Changelog

## 0.1.0

- **Throttle** node: 42 operations across 14 resources (analytics, carts, checkout, customers, discounts, events, extensions, invoices, orders, payments, quotes, subscriptions, webhook deliveries, workspace), generated from Throttle's action catalog. Usable as an AI Agent tool.
- **Throttle Trigger**: webhook trigger for eight Throttle events, with `X-Throttle-Signature` verification and per-event payload flattening.
- **Throttle API** credential: secret key (`sk_...`) sent as `X-API-Key`, tested against `GET /api/v1/whoami`.
