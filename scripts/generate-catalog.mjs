#!/usr/bin/env node
/**
 * Projects `@core/action-catalog` into plain JSON the Throttle node bundles.
 *
 * A verified n8n community node may have no runtime dependencies at all, so it
 * cannot import the catalog package. It is read here, at build time, from the
 * Throttle monorepo and written out as `nodes/Throttle/catalog.json` — the
 * single source of truth survives, the published package depends on nothing.
 *
 * Run from inside the monorepo (it reads `packages/action-catalog`):
 *
 *   node scripts/generate-catalog.mjs
 *
 * `OPERATIONS` decides how each catalog action appears in n8n's
 * Resource → Operation pickers. Every action the catalog projects to the
 * `n8n` channel must be listed here, and nothing else may be: the script
 * refuses to write a catalog that has drifted in either direction.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../nodes/Throttle/catalog.json');
const CATALOG_PKG = resolve(HERE, '../../../packages/action-catalog');

/** id → [resource, operation value, operation label]. */
const OPERATIONS = {
	whoami: ['workspace', 'getConnection', 'Get Connection'],
	get_workspace_settings: ['workspace', 'getSettings', 'Get Settings'],
	get_audit_log: ['workspace', 'getAuditLog', 'Get Audit Log'],
	list_applications: ['workspace', 'getApplications', 'Get Applications'],

	search_orders: ['order', 'getAll', 'Get Many'],

	search_customers: ['customer', 'getAll', 'Get Many'],
	create_customer: ['customer', 'create', 'Create'],
	update_customer: ['customer', 'update', 'Update'],

	list_subscriptions: ['subscription', 'getAll', 'Get Many'],
	get_subscription: ['subscription', 'get', 'Get'],
	cancel_subscription: ['subscription', 'cancel', 'Cancel'],
	set_subscription_payment_method: ['subscription', 'setPaymentMethod', 'Set Payment Method'],
	// `manage_subscription` is one catalog verb with an `action` enum; n8n's
	// convention is one operation per verb, so it is split in the node.
	manage_subscription: ['subscription', 'pause|resume', 'Pause|Resume'],

	search_quotes: ['quote', 'getAll', 'Get Many'],
	get_quote: ['quote', 'get', 'Get'],
	create_quote: ['quote', 'create', 'Create'],
	send_quote: ['quote', 'send', 'Send'],

	list_invoices: ['invoice', 'getAll', 'Get Many'],
	get_invoice: ['invoice', 'get', 'Get'],
	receivables_aging: ['invoice', 'getAging', 'Get Receivables Aging'],

	search_discounts: ['discount', 'getAll', 'Get Many'],
	get_discount: ['discount', 'get', 'Get'],

	search_payments: ['payment', 'getAll', 'Get Many'],
	refund_payment: ['payment', 'refund', 'Refund'],

	list_abandoned_carts: ['cart', 'getAbandoned', 'Get Many Abandoned'],
	create_checkout_link: ['checkout', 'createLink', 'Create Link'],

	search_events: ['event', 'getAll', 'Get Many'],

	list_webhook_deliveries: ['webhookDelivery', 'getAll', 'Get Many'],
	get_webhook_delivery: ['webhookDelivery', 'get', 'Get'],
	replay_webhook_delivery: ['webhookDelivery', 'replay', 'Replay'],
	send_test_webhook: ['webhookDelivery', 'sendTest', 'Send Test'],

	list_extension_installations: ['extension', 'getAll', 'Get Many Installations'],

	get_business_summary: ['analytics', 'getBusinessSummary', 'Get Business Summary'],
	get_attention_digest: ['analytics', 'getAttentionDigest', 'Get Attention Digest'],
	get_sales_timeseries: ['analytics', 'getSalesTimeseries', 'Get Sales Timeseries'],
	get_top_products: ['analytics', 'getTopProducts', 'Get Top Products'],
	get_customer_growth: ['analytics', 'getCustomerGrowth', 'Get Customer Growth'],
	get_revenue_breakdown: ['analytics', 'getRevenueBreakdown', 'Get Revenue Breakdown'],
	get_funnel_conversion: ['analytics', 'getFunnelConversion', 'Get Funnel Conversion'],
	get_subscription_movement: ['analytics', 'getSubscriptionMovement', 'Get Subscription Movement'],
	get_discount_performance: ['analytics', 'getDiscountPerformance', 'Get Discount Performance'],
};

const RESOURCES = [
	['analytics', 'Analytics'],
	['cart', 'Cart'],
	['checkout', 'Checkout'],
	['customer', 'Customer'],
	['discount', 'Discount'],
	['event', 'Event'],
	['extension', 'Extension'],
	['invoice', 'Invoice'],
	['order', 'Order'],
	['payment', 'Payment'],
	['quote', 'Quote'],
	['subscription', 'Subscription'],
	['webhookDelivery', 'Webhook Delivery'],
	['workspace', 'Workspace'],
];

const RESOURCE_NAMES = Object.fromEntries(RESOURCES);

/**
 * Inputs the node does not surface, per action.
 *
 * - `applicationId` everywhere: the node authenticates with an `sk_` key,
 *   which is already pinned to one application, and the API answers a key
 *   plus an application header with 400 `header_scope_conflict`.
 * - `cursor` everywhere: the node pages for the user ("Return All").
 * - `sinceDays` on abandoned carts: it only shapes the summary call, which the
 *   node does not make — n8n wants the carts themselves as items.
 */
const ALWAYS_OMIT = new Set(['applicationId', 'cursor']);
const OMIT = { list_abandoned_carts: ['sinceDays'] };

const ACRONYMS = { id: 'ID', url: 'URL', n: 'N' };

/** Labels the camelCase split gets wrong or leaves ambiguous. */
const LABELS = { q: 'Search Query', netN: 'Net Terms (Days)' };
/** Per-action overrides, where one field name means a different record. */
const ACTION_LABELS = { send_test_webhook: { id: 'Webhook Endpoint ID' } };
const toLabel = (name) =>
	name
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.split(' ')
		.map((word, i) => {
			const lower = word.toLowerCase();
			if (ACRONYMS[lower]) return ACRONYMS[lower];
			return i === 0
				? word.charAt(0).toUpperCase() + word.slice(1)
				: word.charAt(0).toUpperCase() + word.slice(1);
		})
		.join(' ');

if (!existsSync(CATALOG_PKG)) {
	console.error(
		`Cannot find ${CATALOG_PKG}. This script runs inside the Throttle monorepo; ` +
			'the published package ships the generated catalog.json and does not need it.',
	);
	process.exit(1);
}

// The reader has to live INSIDE the catalog package: Node resolves
// `@core/scopes` from the importing file's directory, not from cwd.
const reader = `
import { ACTIONS, TRIGGERS } from './src/index.ts';
console.log(JSON.stringify({
  actions: ACTIONS.filter((a) => a.channels.includes('n8n')),
  triggers: TRIGGERS.filter((t) => t.channels.includes('n8n')),
}));
`;
const tmp = resolve(CATALOG_PKG, '.read-catalog-n8n.mts');
writeFileSync(tmp, reader);
let raw;
try {
	raw = execFileSync('npx', ['tsx', tmp], {
		cwd: CATALOG_PKG,
		encoding: 'utf8',
		maxBuffer: 16 * 1024 * 1024,
	});
} finally {
	execFileSync('rm', ['-f', tmp]);
}
const { actions, triggers } = JSON.parse(raw);

const ids = new Set(actions.map((a) => a.id));
const unmapped = [...ids].filter((id) => !OPERATIONS[id]);
const stale = Object.keys(OPERATIONS).filter((id) => !ids.has(id));
if (unmapped.length || stale.length) {
	console.error(
		[
			unmapped.length && `n8n-channel actions with no operation mapping: ${unmapped.join(', ')}`,
			stale.length && `mapped ids that are not n8n-channel actions: ${stale.join(', ')}`,
		]
			.filter(Boolean)
			.join('\n'),
	);
	process.exit(1);
}

const operations = [];
for (const action of actions) {
	const [resource, opValue, opLabel] = OPERATIONS[action.id];
	const omit = new Set([...ALWAYS_OMIT, ...(OMIT[action.id] ?? [])]);
	const paginated = action.input.some((f) => f.name === 'cursor');
	const fields = action.input
		.filter((f) => !omit.has(f.name))
		// A paginated list gets n8n's own Return All + Limit pair instead.
		.filter((f) => !(paginated && f.name === 'limit'))
		.map((f) => ({
			...f,
			displayName:
				ACTION_LABELS[action.id]?.[f.name] ??
				// A bare "ID" says nothing in a node with fourteen resources.
				(f.name === 'id' ? `${RESOURCE_NAMES[resource]} ID` : undefined) ??
				LABELS[f.name] ??
				toLabel(f.name),
		}));

	const values = opValue.split('|');
	const labels = opLabel.split('|');
	values.forEach((value, i) => {
		operations.push({
			actionId: action.id,
			resource,
			operation: value,
			name: labels[i],
			description: action.description,
			kind: action.kind,
			destructive: !!action.destructive,
			guardrails: action.guardrails ?? [],
			scopes: action.scopes,
			requests: action.requests,
			paginated,
			// `manage_subscription`'s `action` becomes the operation itself.
			fixed: values.length > 1 ? { action: value } : undefined,
			fields: values.length > 1 ? fields.filter((f) => f.name !== 'action') : fields,
		});
	});
}

const catalog = {
	generatedFrom: '@core/action-catalog',
	resources: RESOURCES.map(([value, name]) => ({ value, name })),
	operations,
	triggers: triggers.map((t) => ({
		id: t.id,
		title: t.title,
		description: t.description,
		eventType: t.eventType,
		scope: t.scope,
	})),
};

const used = new Set(operations.map((o) => o.resource));
const unusedResources = RESOURCES.filter(([v]) => !used.has(v)).map(([v]) => v);
if (unusedResources.length) {
	console.error(`Resources with no operations: ${unusedResources.join(', ')}`);
	process.exit(1);
}

writeFileSync(OUT, JSON.stringify(catalog, null, '\t') + '\n');
console.log(
	`Wrote ${OUT}\n  ${operations.length} operations across ${RESOURCES.length} resources, ${catalog.triggers.length} triggers`,
);
