// Runs against the compiled package (`npm run build` first): the same
// CommonJS n8n loads, so nothing here can pass on source that does not ship.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
	catalog,
	throttleProperties,
	findOperation,
	collectionName,
} = require('../dist/nodes/Throttle/descriptions.js');
const { hasWrite, runOperation, readParameters } = require('../dist/nodes/Throttle/operations.js');
const { idempotencyKey } = require('../dist/nodes/Throttle/transport.js');
const {
	normalize,
	verifySignature,
	SHAPES,
	ThrottleTrigger,
} = require('../dist/nodes/ThrottleTrigger/ThrottleTrigger.node.js');
const { Throttle } = require('../dist/nodes/Throttle/Throttle.node.js');

// ------------------------------------------------------------------ fakes

/**
 * A minimal IExecuteFunctions. `responses` answers each request in order;
 * `calls` records what the node sent, which is what these tests assert on.
 */
function fakeContext({ params = {}, responses = [] } = {}) {
	const calls = [];
	const queue = [...responses];
	const node = { id: 'node-1', name: 'Throttle', type: 'throttle', typeVersion: 1, parameters: {} };
	const ctx = {
		calls,
		getNode: () => node,
		getExecutionId: () => 'exec-1',
		getInputData: () => [{ json: {} }],
		continueOnFail: () => false,
		getNodeParameter: (name, _i, fallback) => (name in params ? params[name] : fallback),
		helpers: {
			async httpRequestWithAuthentication(credential, options) {
				calls.push({ credential, ...options });
				const next = queue.shift() ?? { statusCode: 200, body: { data: {} } };
				return next;
			},
		},
	};
	return ctx;
}

const op = (resource, operation) => {
	const found = findOperation(resource, operation);
	assert.ok(found, `${resource}/${operation} exists`);
	return found;
};

// --------------------------------------------------------------- catalog

test('every write operation has a request implementation', () => {
	const missing = catalog.operations.filter((o) => o.kind === 'write' && !hasWrite(o.actionId));
	assert.deepEqual(
		missing.map((o) => o.actionId),
		[],
	);
});

test('every trigger event has a declared payload shape', () => {
	const missing = catalog.triggers.filter((t) => !SHAPES[t.eventType]);
	assert.deepEqual(
		missing.map((t) => t.eventType),
		[],
	);
});

test('no operation surfaces applicationId or a raw cursor', () => {
	for (const o of catalog.operations) {
		const names = o.fields.map((f) => f.name);
		assert.ok(!names.includes('applicationId'), `${o.actionId} exposes applicationId`);
		assert.ok(!names.includes('cursor'), `${o.actionId} exposes cursor`);
	}
});

test('operation values are unique within a resource', () => {
	const seen = new Set();
	for (const o of catalog.operations) {
		const key = `${o.resource}/${o.operation}`;
		assert.ok(!seen.has(key), `duplicate ${key}`);
		seen.add(key);
	}
});

test('a parameter name never means two types for the same operation', () => {
	// n8n resolves a parameter by name among those whose displayOptions match;
	// two visible definitions of one name would make the value ambiguous.
	for (const o of catalog.operations) {
		const visible = throttleProperties.filter((p) => {
			const show = p.displayOptions?.show;
			return (
				show &&
				show.resource?.includes(o.resource) &&
				(!show.operation || show.operation.includes(o.operation))
			);
		});
		const names = visible.filter((p) => !p.displayOptions.show.returnAll).map((p) => p.name);
		assert.equal(
			new Set(names).size,
			names.length,
			`${o.resource}/${o.operation}: ${names.join(', ')}`,
		);
	}
});

test('display names are Title Case', () => {
	const bad = [];
	const walk = (props) => {
		for (const p of props) {
			if (p.type !== 'notice' && !/^[A-Z0-9][^]*$/.test(p.displayName)) bad.push(p.displayName);
			if (p.type === 'notice') continue;
			for (const word of p.displayName.split(' ')) {
				if (/^[a-z]/.test(word) && !['a', 'an', 'the', 'of', 'to', 'at'].includes(word))
					bad.push(p.displayName);
			}
			if (p.type === 'collection') walk(p.options);
		}
	};
	walk(throttleProperties);
	assert.deepEqual([...new Set(bad)], []);
});

test('both nodes describe themselves to n8n', () => {
	assert.equal(new Throttle().description.usableAsTool, true);
	const trigger = new ThrottleTrigger().description;
	assert.equal(trigger.usableAsTool, undefined);
	assert.ok(trigger.properties[0].options.length === catalog.triggers.length);
});

// -------------------------------------------------------------- requests

test('reads send X-API-Key auth via the credential and unwrap { data }', async () => {
	const ctx = fakeContext({
		params: { returnAll: false, limit: 5 },
		responses: [
			{
				statusCode: 200,
				body: { data: [{ id: 'a' }, { id: 'b' }], meta: { pagination: { hasMore: false } } },
			},
		],
	});
	const result = await runOperation.call(ctx, op('customer', 'getAll'), { q: 'ada' }, 0);
	assert.deepEqual(result, [{ id: 'a' }, { id: 'b' }]);
	assert.equal(ctx.calls[0].credential, 'throttleApi');
	assert.equal(ctx.calls[0].url, '/api/v1/customers');
	assert.deepEqual(ctx.calls[0].qs, { q: 'ada', limit: 5 });
});

test('Return All follows the cursor until hasMore is false', async () => {
	const ctx = fakeContext({
		params: { returnAll: true },
		responses: [
			{
				statusCode: 200,
				body: { data: [{ id: 1 }], meta: { pagination: { cursor: 'c1', hasMore: true } } },
			},
			{
				statusCode: 200,
				body: { data: [{ id: 2 }], meta: { pagination: { cursor: 'c2', hasMore: false } } },
			},
		],
	});
	const result = await runOperation.call(ctx, op('order', 'getAll'), {}, 0);
	assert.deepEqual(
		result.map((r) => r.id),
		[1, 2],
	);
	assert.equal(ctx.calls[1].qs.cursor, 'c1');
	assert.equal(ctx.calls[0].qs.limit, 100);
});

test('payment search sends the snake_case query names its route accepts', async () => {
	const ctx = fakeContext({
		params: { returnAll: false, limit: 10 },
		responses: [{ statusCode: 200, body: { data: [] } }],
	});
	await runOperation.call(
		ctx,
		op('payment', 'getAll'),
		{ orderId: 'o1', dueFrom: '2026-01-01', amountMin: 100 },
		0,
	);
	assert.deepEqual(ctx.calls[0].qs, {
		order_id: 'o1',
		due_from: '2026-01-01',
		amount_min: 100,
		limit: 10,
	});
});

test('an offset-paged list returns its rows, not the envelope', async () => {
	const ctx = fakeContext({
		responses: [
			{
				statusCode: 200,
				body: { data: { items: [{ id: 'd1' }], total: 1, limit: 50, offset: 0, hasMore: false } },
			},
		],
	});
	const result = await runOperation.call(ctx, op('webhookDelivery', 'getAll'), { limit: 50 }, 0);
	assert.deepEqual(result, [{ id: 'd1' }]);
});

test('a by-id read puts the id in the path, not the query', async () => {
	const ctx = fakeContext({ responses: [{ statusCode: 200, body: { data: { id: 'q 1' } } }] });
	await runOperation.call(ctx, op('quote', 'get'), { id: 'q 1' }, 0);
	assert.equal(ctx.calls[0].url, '/api/v1/quotes/q%201');
	assert.deepEqual(ctx.calls[0].qs, {});
});

test('create quote maps flat inputs onto the strict wire shape', async () => {
	const ctx = fakeContext();
	const items = [{ name: 'Widget', unitPrice: 2500, quantity: 2 }];
	await runOperation.call(
		ctx,
		op('quote', 'create'),
		{ customerId: 'c1', items, netN: 30, notes: 'Thanks' },
		0,
	);
	assert.deepEqual(ctx.calls[0].body, {
		customerId: 'c1',
		items,
		paymentTerms: { mode: 'net_terms', netN: 30 },
		buyerNote: 'Thanks',
	});
	assert.match(ctx.calls[0].headers['idempotency-key'], /^n8n-create_quote-[0-9a-f]{40}$/);
});

test('create quote refuses net terms on a recurring line before calling the API', async () => {
	const ctx = fakeContext();
	await assert.rejects(
		runOperation.call(
			ctx,
			op('quote', 'create'),
			{ customerId: 'c1', items: [{ recurring: { interval: 'month' } }], netN: 30 },
			0,
		),
		/pay-in-full/,
	);
	assert.equal(ctx.calls.length, 0);
});

test('refund never sends a request without an explicit amount', async () => {
	const ctx = fakeContext();
	await assert.rejects(
		runOperation.call(ctx, op('payment', 'refund'), { id: 'p1', amount: 0 }, 0),
		/at least 1/,
	);
	await assert.rejects(
		runOperation.call(ctx, op('payment', 'refund'), { id: 'p1', amount: 12.5 }, 0),
		/whole number/,
	);
	assert.equal(ctx.calls.length, 0);

	await runOperation.call(
		ctx,
		op('payment', 'refund'),
		{ id: 'p1', amount: 500, reason: 'damaged' },
		0,
	);
	assert.equal(ctx.calls[0].url, '/api/v1/payments/p1/refund');
	assert.deepEqual(ctx.calls[0].body, { amount: 500, reason: 'damaged' });
});

test('pause and resume are separate operations on one endpoint family', async () => {
	const ctx = fakeContext();
	await runOperation.call(ctx, op('subscription', 'pause'), { id: 's1' }, 0);
	await runOperation.call(ctx, op('subscription', 'resume'), { id: 's1' }, 0);
	assert.deepEqual(
		ctx.calls.map((c) => c.url),
		['/api/v1/subscriptions/s1/pause', '/api/v1/subscriptions/s1/resume'],
	);
});

test('cancel never asks for a refund', async () => {
	const ctx = fakeContext();
	await runOperation.call(ctx, op('subscription', 'cancel'), { id: 's1', atPeriodEnd: true }, 0);
	assert.deepEqual(ctx.calls[0].body, { atPeriodEnd: true });
});

test('create checkout link: whoami, cart, each item, then the session', async () => {
	const ctx = fakeContext({
		responses: [
			{ statusCode: 200, body: { data: { application: { id: 'app-1' } } } },
			{ statusCode: 201, body: { data: { id: 'cart-1' } } },
			{ statusCode: 201, body: { data: {} } },
			{ statusCode: 201, body: { data: {} } },
			{ statusCode: 201, body: { data: { id: 'sess-1', checkoutUrl: 'https://pay.example/s' } } },
		],
	});
	const lineItems = [
		{ name: 'A', unitPrice: 100 },
		{ name: 'B', unitPrice: 200 },
	];
	const result = await runOperation.call(
		ctx,
		op('checkout', 'createLink'),
		{ lineItems, returnUrl: 'https://shop/ok', cancelUrl: 'https://shop/no' },
		0,
	);
	assert.deepEqual(
		ctx.calls.map((c) => `${c.method} ${c.url}`),
		[
			'GET /api/v1/whoami',
			'POST /api/v1/carts',
			'POST /api/v1/carts/cart-1/items',
			'POST /api/v1/carts/cart-1/items',
			'POST /api/v1/checkout/sessions',
		],
	);
	assert.deepEqual(ctx.calls[1].body, { applicationId: 'app-1' });
	assert.deepEqual(ctx.calls[4].body, {
		applicationId: 'app-1',
		cartId: 'cart-1',
		returnUrl: 'https://shop/ok',
		cancelUrl: 'https://shop/no',
	});
	// Each step its own key, so a retry replays the step it failed on.
	const keys = ctx.calls.slice(1).map((c) => c.headers['idempotency-key']);
	assert.equal(new Set(keys).size, 4);
	assert.deepEqual(result, {
		cartId: 'cart-1',
		id: 'sess-1',
		checkoutUrl: 'https://pay.example/s',
	});
});

test('idempotency keys repeat within an execution and differ across executions', () => {
	const a = fakeContext();
	const b = { ...fakeContext(), getExecutionId: () => 'exec-2' };
	assert.equal(
		idempotencyKey.call(a, 'create_customer', 0),
		idempotencyKey.call(a, 'create_customer', 0),
	);
	assert.notEqual(
		idempotencyKey.call(a, 'create_customer', 0),
		idempotencyKey.call(a, 'create_customer', 1),
	);
	assert.notEqual(
		idempotencyKey.call(a, 'create_customer', 0),
		idempotencyKey.call(b, 'create_customer', 0),
	);
});

test('API errors carry the code and a scope hint', async () => {
	const ctx = fakeContext({
		responses: [
			{
				statusCode: 403,
				body: { error: { code: 'insufficient_scopes', message: 'Missing scope' } },
			},
		],
	});
	await assert.rejects(
		runOperation.call(ctx, op('payment', 'refund'), { id: 'p1', amount: 1 }, 0),
		(error) => {
			assert.match(error.message, /Missing scope \(insufficient_scopes\)/);
			assert.match(error.description, /payment_refunds:write/);
			return true;
		},
	);
});

test('JSON parameters are parsed, and bad JSON names the field', () => {
	const createQuote = op('quote', 'create');
	const ctx = fakeContext({
		params: { customerId: 'c1', items: '[{"name":"A","unitPrice":1}]', additionalFields: {} },
	});
	assert.deepEqual(readParameters.call(ctx, createQuote, collectionName(createQuote), 0).items, [
		{ name: 'A', unitPrice: 1 },
	]);
	const bad = fakeContext({ params: { customerId: 'c1', items: '[{', additionalFields: {} } });
	assert.throws(
		() => readParameters.call(bad, createQuote, collectionName(createQuote), 0),
		/Items is not valid JSON/,
	);
});

// -------------------------------------------------------------- trigger

const SECRET = 'whsec_test';
const sign = (body, t, secret = SECRET) =>
	`t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

test('signature: valid, tampered, stale, and rotation window', () => {
	const body = '{"id":"evt_1"}';
	const now = 1_800_000_000;
	assert.equal(verifySignature(body, sign(body, now), SECRET, now), true);
	assert.equal(verifySignature(body + ' ', sign(body, now), SECRET, now), false);
	assert.equal(verifySignature(body, sign(body, now - 301), SECRET, now), false);
	assert.equal(verifySignature(body, sign(body, now, 'other'), SECRET, now), false);
	assert.equal(verifySignature(body, undefined, SECRET, now), false);
	const rotating = `${sign(body, now, 'old')},v1=${sign(body, now).split('v1=')[1]}`;
	assert.equal(verifySignature(body, rotating, SECRET, now), true);
});

test('normalize lifts each event subject and names the record', () => {
	const cases = [
		['order.created', { order: { id: 'o1', total: 5 } }, 'o1'],
		['payment.captured', { paymentId: 'p1', orderId: 'o1' }, 'p1'],
		['payment.failed', { order: { id: 'o1' }, paymentId: 'p2' }, 'p2'],
		['subscription.cancelled', { subscription: { id: 's1' }, reason: 'x' }, 's1'],
		['quote.accepted', { quote: { id: 'q1' }, revision: { id: 'r1' } }, 'q1'],
		['cart.abandoned', { cartId: 'c1', recoveryUrl: 'https://r' }, 'c1'],
		['invoice.past_due', { paymentId: 'p3', daysPastDue: 4 }, 'p3'],
	];
	for (const [type, data, resourceId] of cases) {
		const out = normalize({ id: 'evt', type, createdAt: 't', environmentId: 'env', data });
		assert.equal(out.resourceId, resourceId, type);
		assert.equal(out.eventId, 'evt');
		assert.equal(out.eventType, type);
	}
	const quote = normalize({
		id: 'e',
		type: 'quote.accepted',
		data: { quote: { id: 'q1' }, revision: { id: 'r1' } },
	});
	assert.deepEqual(quote.revision, { id: 'r1' });
});

function webhookContext({ body, header, secret = SECRET, events = ['order.created'] }) {
	let status;
	const ctx = {
		getWorkflowStaticData: () => ({ endpointId: 'we_1', signingSecret: secret }),
		getRequestObject: () => ({ rawBody: Buffer.from(body) }),
		getBodyData: () => JSON.parse(body),
		getHeaderData: () => ({ 'x-throttle-signature': header }),
		getNodeParameter: () => events,
		getResponseObject: () => ({ status: (s) => ((status = s), { json: () => {} }) }),
		helpers: { returnJsonArray: (items) => items.map((json) => ({ json })) },
		status: () => status,
	};
	return ctx;
}

test('webhook: signed delivery starts the workflow, unsigned one is refused', async () => {
	const trigger = new ThrottleTrigger();
	const body = JSON.stringify({
		id: 'evt_1',
		type: 'order.created',
		data: { order: { id: 'o1' } },
	});
	const t = Math.floor(Date.now() / 1000);

	const ok = await trigger.webhook.call(webhookContext({ body, header: sign(body, t) }));
	assert.equal(ok.workflowData[0][0].json.resourceId, 'o1');

	const badCtx = webhookContext({ body, header: sign(body, t, 'wrong') });
	const bad = await trigger.webhook.call(badCtx);
	assert.equal(bad.noWebhookResponse, true);
	assert.equal(badCtx.status(), 401);
});

test('webhook: an event the node no longer selects is acknowledged, not run', async () => {
	const trigger = new ThrottleTrigger();
	const body = JSON.stringify({ id: 'evt_2', type: 'payment.captured', data: { paymentId: 'p1' } });
	const t = Math.floor(Date.now() / 1000);
	const result = await trigger.webhook.call(webhookContext({ body, header: sign(body, t) }));
	assert.equal(result.workflowData, undefined);
	assert.deepEqual(result.webhookResponse, { received: true });
});

function hookContext({ staticData = {}, events = ['order.created'], responses = [] }) {
	const calls = [];
	const queue = [...responses];
	return {
		calls,
		staticData,
		getNode: () => ({ id: 'n', name: 'Throttle Trigger' }),
		getWorkflowStaticData: () => staticData,
		getNodeParameter: () => events,
		getNodeWebhookUrl: () => 'https://n8n.example/webhook/abc',
		helpers: {
			async httpRequestWithAuthentication(credential, options) {
				calls.push(options);
				return queue.shift() ?? { statusCode: 200, body: {} };
			},
		},
	};
}

test('webhook lifecycle: create stores the secret, delete tolerates 404, checkExists compares events', async () => {
	const methods = new ThrottleTrigger().webhookMethods.default;

	const created = hookContext({
		responses: [{ statusCode: 201, body: { data: { id: 'we_1', signingSecret: 'whsec_x' } } }],
	});
	await methods.create.call(created);
	assert.deepEqual(created.calls[0].body, {
		url: 'https://n8n.example/webhook/abc',
		enabledEvents: ['order.created'],
	});
	assert.equal(created.staticData.signingSecret, 'whsec_x');

	const gone = hookContext({
		staticData: { endpointId: 'we_1', signingSecret: 's' },
		responses: [{ statusCode: 404, body: {} }],
	});
	await methods.delete.call(gone);
	assert.equal(gone.calls[0].method, 'DELETE');
	assert.equal(gone.staticData.endpointId, undefined);

	const listing = (enabledEvents) => ({
		statusCode: 200,
		body: {
			data: [{ id: 'we_1', url: 'https://n8n.example/webhook/abc', enabledEvents, isActive: true }],
		},
	});
	const same = hookContext({
		staticData: { endpointId: 'we_1' },
		responses: [listing(['order.created'])],
	});
	assert.equal(await methods.checkExists.call(same), true);
	const changed = hookContext({
		staticData: { endpointId: 'we_1' },
		events: ['order.created', 'quote.accepted'],
		responses: [listing(['order.created'])],
	});
	assert.equal(await methods.checkExists.call(changed), false);

	const failing = hookContext({
		staticData: { endpointId: 'we_1' },
		responses: [{ statusCode: 500, body: { error: { message: 'boom' } } }],
	});
	await assert.rejects(methods.delete.call(failing), /boom/);
});
