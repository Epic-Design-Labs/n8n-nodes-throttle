import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { catalog } from '../Throttle/descriptions';
import { throttleRequest } from '../Throttle/transport';

/**
 * How each event type carries its subject.
 *
 * Throttle's event payloads are not uniformly shaped and the delivered envelope
 * has no `entityId`, so which field identifies the record is stated per type —
 * verified against `@usethrottle/webhook-types`, the published outbound
 * contract. A flat spread would hand every workflow a blank record id.
 */
export const SHAPES: Record<string, { entity: string | null; idKeys: string[] }> = {
	'order.created': { entity: 'order', idKeys: ['id'] },
	'payment.captured': { entity: null, idKeys: ['paymentId'] },
	'payment.failed': { entity: 'order', idKeys: ['paymentId'] },
	'subscription.created': { entity: 'subscription', idKeys: ['id'] },
	'subscription.cancelled': { entity: 'subscription', idKeys: ['id'] },
	'quote.accepted': { entity: 'quote', idKeys: ['id'] },
	'cart.abandoned': { entity: null, idKeys: ['cartId'] },
	'invoice.past_due': { entity: null, idKeys: ['paymentId'] },
};

const isPlainObject = (value: unknown): value is IDataObject =>
	value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Lifts the event's subject to the top level and names it.
 *
 * `resourceId` is the record the event is about; `eventId` is stable across
 * Throttle's delivery retries (it is also the `X-Throttle-Event-Id` header), so
 * a workflow can deduplicate on it.
 */
export function normalize(envelope: IDataObject): IDataObject {
	const type = String(envelope.type ?? '');
	const shape = SHAPES[type] ?? { entity: null, idKeys: ['id'] };
	const data = isPlainObject(envelope.data) ? envelope.data : {};

	let flat: IDataObject = data;
	if (shape.entity && isPlainObject(data[shape.entity])) {
		const { [shape.entity]: entity, ...siblings } = data;
		flat = { ...siblings, ...(entity as IDataObject) };
	}

	let resourceId: unknown;
	for (const key of shape.idKeys) {
		if (flat[key] !== undefined && flat[key] !== null) {
			resourceId = flat[key];
			break;
		}
	}

	return {
		...flat,
		resourceId: resourceId as IDataObject[string],
		eventId: envelope.id,
		eventType: envelope.type,
		eventCreatedAt: envelope.createdAt,
		environmentId: envelope.environmentId,
	};
}

/**
 * Verifies `X-Throttle-Signature: t=<unix>,v1=<hex>[,v1=<hex>]` — an HMAC-SHA256
 * of `${t}.${rawBody}`. A rotation window carries two `v1` digests; either may
 * match. Deliveries older than five minutes are refused, so a captured request
 * cannot be replayed into the workflow later.
 */
export function verifySignature(
	rawBody: string,
	header: string | undefined,
	secret: string,
	nowSeconds: number,
	toleranceSeconds = 300,
): boolean {
	if (!header) return false;
	let timestamp = NaN;
	const digests: string[] = [];
	for (const part of header.split(',')) {
		const index = part.indexOf('=');
		if (index <= 0) continue;
		const key = part.slice(0, index).trim();
		const value = part.slice(index + 1).trim();
		if (key === 't') timestamp = Number.parseInt(value, 10);
		else if (key === 'v1' && /^[0-9a-f]+$/i.test(value) && digests.length < 4) digests.push(value);
	}
	if (!Number.isFinite(timestamp) || digests.length === 0) return false;
	if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;

	const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
	return digests.some((digest) => {
		const given = Buffer.from(digest, 'hex');
		return given.length === expected.length && timingSafeEqual(given, expected);
	});
}

export class ThrottleTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Throttle Trigger',
		name: 'throttleTrigger',
		icon: { light: 'file:../../icons/throttle.svg', dark: 'file:../../icons/throttle.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description:
			'Starts the workflow when orders, payments, subscriptions, quotes or carts change in Throttle',
		defaults: { name: 'Throttle Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'throttleApi', required: true }],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				default: [],
				description:
					'The events that start this workflow. The secret key needs the read scope for each one, e.g. orders:read for Order Created.',
				options: catalog.triggers
					.map((t) => ({ name: t.title, value: t.eventType, description: t.description }))
					.sort((a, b) => a.name.localeCompare(b.name)),
			},
		],
	};

	webhookMethods = {
		default: {
			/**
			 * True only when the endpoint this workflow created still exists, still
			 * points here, and still subscribes to exactly the selected events —
			 * otherwise n8n deletes and recreates it.
			 */
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const staticData = this.getWorkflowStaticData('node');
				const endpointId = staticData.endpointId as string | undefined;
				if (!endpointId) return false;

				const { body } = await throttleRequest.call(this, {
					method: 'GET',
					path: '/api/v1/webhook-endpoints',
				});
				const endpoints = Array.isArray(body.data) ? (body.data as IDataObject[]) : [];
				const endpoint = endpoints.find((e) => e.id === endpointId);
				if (!endpoint) {
					delete staticData.endpointId;
					delete staticData.signingSecret;
					return false;
				}

				const wanted = [...(this.getNodeParameter('events') as string[])].sort();
				const current = [...((endpoint.enabledEvents as string[] | undefined) ?? [])].sort();
				return (
					endpoint.url === this.getNodeWebhookUrl('default') &&
					endpoint.isActive !== false &&
					wanted.length === current.length &&
					wanted.every((event, index) => event === current[index])
				);
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const events = this.getNodeParameter('events') as string[];
				if (events.length === 0) {
					throw new NodeOperationError(this.getNode(), 'Select at least one event');
				}
				// A stale endpoint from an earlier activation would keep firing at
				// this URL with a secret this node no longer holds.
				await deleteEndpoint.call(this);

				const { body } = await throttleRequest.call(this, {
					method: 'POST',
					path: '/api/v1/webhook-endpoints',
					body: { url: this.getNodeWebhookUrl('default'), enabledEvents: events },
				});
				const endpoint = (body.data ?? {}) as IDataObject;
				if (typeof endpoint.id !== 'string' || typeof endpoint.signingSecret !== 'string') {
					throw new NodeOperationError(
						this.getNode(),
						'Throttle did not return a webhook endpoint id and signing secret',
					);
				}
				const staticData = this.getWorkflowStaticData('node');
				staticData.endpointId = endpoint.id;
				// Revealed once, at creation. Kept in the workflow's static data so
				// every delivery can be verified.
				staticData.signingSecret = endpoint.signingSecret;
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				await deleteEndpoint.call(this);
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const staticData = this.getWorkflowStaticData('node');
		const secret = staticData.signingSecret as string | undefined;
		const request = this.getRequestObject() as unknown as { rawBody?: Buffer | string };
		const rawBody =
			request.rawBody === undefined
				? JSON.stringify(this.getBodyData())
				: Buffer.isBuffer(request.rawBody)
					? request.rawBody.toString('utf8')
					: String(request.rawBody);
		const header = this.getHeaderData()['x-throttle-signature'] as string | undefined;

		if (!secret || !verifySignature(rawBody, header, secret, Math.floor(Date.now() / 1000))) {
			const response = this.getResponseObject();
			response.status(401).json({ error: 'invalid_signature' });
			return { noWebhookResponse: true };
		}

		const envelope = this.getBodyData();
		const selected = this.getNodeParameter('events') as string[];
		if (!selected.includes(String(envelope.type))) {
			// Acknowledge, so Throttle does not retry an event this workflow
			// no longer wants, but do not start a run for it.
			return { webhookResponse: { received: true } };
		}
		return { workflowData: [this.helpers.returnJsonArray([normalize(envelope)])] };
	}
}

/** Deletes the endpoint this node created, if any. A 404 means it is already gone. */
async function deleteEndpoint(this: IHookFunctions): Promise<void> {
	const staticData = this.getWorkflowStaticData('node');
	const endpointId = staticData.endpointId as string | undefined;
	if (endpointId) {
		await throttleRequest.call(this, {
			method: 'DELETE',
			path: `/api/v1/webhook-endpoints/${encodeURIComponent(endpointId)}`,
			allowStatus: [404],
		});
	}
	delete staticData.endpointId;
	delete staticData.signingSecret;
}
