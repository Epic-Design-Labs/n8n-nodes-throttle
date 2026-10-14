import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import type { CatalogOperation } from './descriptions';
import { buildPath, idempotencyKey, throttleList, throttleRequest, unwrap } from './transport';

type Result = IDataObject | IDataObject[];
type Write = (
	this: IExecuteFunctions,
	op: CatalogOperation,
	p: IDataObject,
	i: number,
) => Promise<Result>;

/**
 * Query parameters whose wire name is not the catalog's field name.
 * `GET /api/v1/payments` only accepts these as snake_case — confirmed against
 * the route's querystring schema, and the reason a generic projection is wrong.
 */
const QUERY_NAMES: Record<string, Record<string, string>> = {
	search_payments: {
		orderId: 'order_id',
		dueFrom: 'due_from',
		dueTo: 'due_to',
		amountMin: 'amount_min',
		amountMax: 'amount_max',
	},
};

/** A JSON parameter arrives as a string from the UI and as a value from an expression. */
function parseJson(this: IExecuteFunctions, value: unknown, label: string, i: number): unknown {
	if (typeof value !== 'string') return value;
	if (value.trim() === '') return undefined;
	try {
		return JSON.parse(value);
	} catch {
		throw new NodeOperationError(this.getNode(), `${label} is not valid JSON`, { itemIndex: i });
	}
}

/** Keeps only defined values. `null` survives: clearing `externalId` is a real instruction. */
function defined(obj: IDataObject): IDataObject {
	const out: IDataObject = {};
	for (const [key, value] of Object.entries(obj)) {
		if (value === undefined || value === '') continue;
		out[key] = value;
	}
	return out;
}

function requireArray(
	this: IExecuteFunctions,
	value: unknown,
	label: string,
	i: number,
): IDataObject[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new NodeOperationError(
			this.getNode(),
			`${label} must be a JSON array with at least one item`,
			{
				itemIndex: i,
			},
		);
	}
	return value as IDataObject[];
}

/**
 * Write bodies are per-action, never a spread of the parameters: every write
 * body on the API is a `.strict()` schema, and several catalog inputs are
 * flatter than the wire shape (`netN` → `paymentTerms.netN`, `notes` →
 * `buyerNote`). A generic projection would 400 with `unrecognized_keys`.
 */
const WRITES: Record<string, Write> = {
	async create_customer(op, p, i) {
		const { body } = await throttleRequest.call(
			this,
			{
				method: 'POST',
				path: '/api/v1/customers',
				body: defined({
					email: p.email,
					firstName: p.firstName,
					lastName: p.lastName,
					phone: p.phone,
					company: p.company,
					externalId: p.externalId,
					netN: p.netN,
					acceptsMarketing: p.acceptsMarketing,
				}),
				idempotencyKey: idempotencyKey.call(this, op.actionId, i),
			},
			op.scopes,
		);
		return unwrap(body);
	},

	async update_customer(op, p, i) {
		const { body } = await throttleRequest.call(
			this,
			{
				method: 'PATCH',
				path: buildPath('/api/v1/customers/:id', p),
				// `id` is the path parameter; the body schema is `.strict()`.
				body: defined({
					email: p.email,
					firstName: p.firstName,
					lastName: p.lastName,
					phone: p.phone,
					company: p.company,
					externalId: p.externalId,
					netN: p.netN,
					acceptsMarketing: p.acceptsMarketing,
				}),
				idempotencyKey: idempotencyKey.call(this, op.actionId, i),
			},
			op.scopes,
		);
		return unwrap(body);
	},

	/**
	 * Three calls: the API has no "checkout link" endpoint, and a checkout
	 * session needs a cart that already holds its items.
	 */
	async create_checkout_link(op, p, i) {
		const lineItems = requireArray.call(this, p.lineItems, 'Line Items', i);
		// Cart creation cross-checks applicationId against the key's own
		// application rather than inferring it — omitting it is a 400.
		const { body: who } = await throttleRequest.call(this, {
			method: 'GET',
			path: '/api/v1/whoami',
		});
		const application = ((who.data as IDataObject | undefined)?.application ?? {}) as IDataObject;
		const applicationId = application.id as string | undefined;
		if (!applicationId) {
			throw new NodeOperationError(this.getNode(), 'This key is not bound to an application', {
				itemIndex: i,
			});
		}

		const { body: cartBody } = await throttleRequest.call(
			this,
			{
				method: 'POST',
				path: '/api/v1/carts',
				body: defined({
					applicationId,
					customerId: p.customerId,
					customerEmail: p.customerEmail,
					netN: p.netN,
				}),
				idempotencyKey: idempotencyKey.call(this, op.actionId, i, 'cart'),
			},
			op.scopes,
		);
		const cart = unwrap(cartBody) as IDataObject;
		const cartId = String(cart.id);

		for (const [index, item] of lineItems.entries()) {
			await throttleRequest.call(
				this,
				{
					method: 'POST',
					path: `/api/v1/carts/${encodeURIComponent(cartId)}/items`,
					body: item,
					idempotencyKey: idempotencyKey.call(this, op.actionId, i, `item-${index}`),
				},
				op.scopes,
			);
		}

		const { body: sessionBody } = await throttleRequest.call(
			this,
			{
				method: 'POST',
				path: '/api/v1/checkout/sessions',
				body: defined({
					applicationId,
					cartId,
					returnUrl: p.returnUrl,
					cancelUrl: p.cancelUrl,
					customerEmail: p.customerEmail,
					discountCode: p.discountCode,
				}),
				idempotencyKey: idempotencyKey.call(this, op.actionId, i, 'session'),
			},
			op.scopes,
		);
		return { cartId, ...(unwrap(sessionBody) as IDataObject) };
	},

	async create_quote(op, p, i) {
		const items = requireArray.call(this, p.items, 'Items', i);
		if (p.netN !== undefined && items.some((item) => item && item.recurring)) {
			throw new NodeOperationError(
				this.getNode(),
				'Items with a recurring price need pay-in-full terms; remove Net Terms (Days)',
				{ itemIndex: i },
			);
		}
		const { body } = await throttleRequest.call(
			this,
			{
				method: 'POST',
				path: '/api/v1/quotes',
				body: defined({
					customerId: p.customerId,
					items,
					expiresAt: p.expiresAt,
					paymentTerms: p.netN !== undefined ? { mode: 'net_terms', netN: p.netN } : undefined,
					buyerNote: p.notes,
				}),
				idempotencyKey: idempotencyKey.call(this, op.actionId, i),
			},
			op.scopes,
		);
		return unwrap(body);
	},

	async send_quote(op, p, i) {
		const { body } = await throttleRequest.call(
			this,
			{
				method: 'POST',
				path: buildPath('/api/v1/quotes/:id/issue', p),
				body: {},
				idempotencyKey: idempotencyKey.call(this, op.actionId, i),
			},
			op.scopes,
		);
		return unwrap(body);
	},

	async refund_payment(op, p, i) {
		const amount = Number(p.amount);
		// The API treats an omitted amount as a FULL refund. A blank field must
		// never mean "refund everything".
		if (!Number.isInteger(amount) || amount < 1) {
			throw new NodeOperationError(
				this.getNode(),
				'Amount must be a whole number of minor units, at least 1 (2500 = $25.00)',
				{ itemIndex: i },
			);
		}
		const { body } = await throttleRequest.call(
			this,
			{
				method: 'POST',
				path: buildPath('/api/v1/payments/:id/refund', p),
				body: defined({ amount, reason: p.reason }),
				idempotencyKey: idempotencyKey.call(this, op.actionId, i),
			},
			op.scopes,
		);
		return unwrap(body);
	},

	async manage_subscription(op, p, i) {
		const action = op.fixed?.action;
		if (action !== 'pause' && action !== 'resume') {
			throw new NodeOperationError(this.getNode(), `Unknown subscription action "${action}"`, {
				itemIndex: i,
			});
		}
		const { body } = await throttleRequest.call(
			this,
			{
				method: 'POST',
				path: `${buildPath('/api/v1/subscriptions/:id', p)}/${action}`,
				idempotencyKey: idempotencyKey.call(this, op.actionId, i, action),
			},
			op.scopes,
		);
		return unwrap(body);
	},

	async set_subscription_payment_method(op, p, i) {
		const { body } = await throttleRequest.call(
			this,
			{
				method: 'PATCH',
				path: buildPath('/api/v1/subscriptions/:id/payment-method', p),
				body: { paymentMethodId: p.paymentMethodId },
				idempotencyKey: idempotencyKey.call(this, op.actionId, i),
			},
			op.scopes,
		);
		return unwrap(body);
	},

	async cancel_subscription(op, p, i) {
		const { body } = await throttleRequest.call(
			this,
			{
				method: 'POST',
				path: buildPath('/api/v1/subscriptions/:id/cancel', p),
				// `refund` is left to the API default (`none`): a cancellation from a
				// workflow never returns money as a side effect.
				body: defined({ atPeriodEnd: p.atPeriodEnd }),
				idempotencyKey: idempotencyKey.call(this, op.actionId, i),
			},
			op.scopes,
		);
		return unwrap(body);
	},

	async replay_webhook_delivery(op, p, i) {
		const { body } = await throttleRequest.call(
			this,
			{
				method: 'POST',
				path: buildPath('/api/v1/webhook-deliveries/:id/replay', p),
				idempotencyKey: idempotencyKey.call(this, op.actionId, i),
			},
			op.scopes,
		);
		return unwrap(body);
	},

	async send_test_webhook(op, p, i) {
		const { body } = await throttleRequest.call(
			this,
			{
				method: 'POST',
				path: buildPath('/api/v1/webhook-endpoints/:id/test', p),
				body: defined({ eventType: p.eventType }),
				idempotencyKey: idempotencyKey.call(this, op.actionId, i),
			},
			op.scopes,
		);
		return unwrap(body);
	},
};

export function hasWrite(actionId: string): boolean {
	return Object.prototype.hasOwnProperty.call(WRITES, actionId);
}

/** Collects one operation's parameters for item `i`, JSON fields parsed. */
export function readParameters(
	this: IExecuteFunctions,
	op: CatalogOperation,
	collection: string,
	i: number,
): IDataObject {
	const params: IDataObject = {};
	const optional = this.getNodeParameter(collection, i, {}) as IDataObject;
	for (const field of op.fields) {
		const raw = field.required ? this.getNodeParameter(field.name, i) : optional[field.name];
		if (raw === undefined) continue;
		params[field.name] = (
			field.type === 'array' || field.type === 'object'
				? parseJson.call(this, raw, field.displayName, i)
				: raw
		) as IDataObject[string];
	}
	return params;
}

export async function runOperation(
	this: IExecuteFunctions,
	op: CatalogOperation,
	params: IDataObject,
	i: number,
): Promise<Result> {
	if (op.kind === 'write') {
		const write = WRITES[op.actionId];
		if (!write) {
			throw new NodeOperationError(this.getNode(), `Operation "${op.name}" is not implemented`, {
				itemIndex: i,
			});
		}
		return write.call(this, op, params, i);
	}

	// Reads are one GET each: path parameters from the fields, the rest as query.
	const template = op.requests[0].path;
	const pathParams = new Set([...template.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]));
	const path = buildPath(template, params);
	const rename = QUERY_NAMES[op.actionId] ?? {};
	const qs: IDataObject = {};
	for (const [key, value] of Object.entries(params)) {
		if (!pathParams.has(key)) qs[rename[key] ?? key] = value;
	}

	if (op.paginated) {
		const returnAll = this.getNodeParameter('returnAll', i, false) as boolean;
		const limit = returnAll ? undefined : (this.getNodeParameter('limit', i, 50) as number);
		return throttleList.call(this, path, qs, limit, op.scopes);
	}
	const { body } = await throttleRequest.call(this, { method: 'GET', path, qs }, op.scopes);
	const result = unwrap(body);
	// Some list routes page by offset and wrap their rows as
	// `{ items, total, limit, offset, hasMore }` (webhook deliveries). n8n wants
	// the rows themselves as items.
	if (op.operation === 'getAll' && !Array.isArray(result) && Array.isArray(result.items)) {
		return result.items as IDataObject[];
	}
	return result;
}
