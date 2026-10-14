import { createHash } from 'node:crypto';
import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

export const API_BASE = 'https://api.usethrottle.dev';

type Context = IExecuteFunctions | IHookFunctions | ILoadOptionsFunctions;

export interface ThrottleRequest {
	method: IHttpRequestMethods;
	path: string;
	qs?: IDataObject;
	body?: IDataObject;
	idempotencyKey?: string;
	/** Statuses the caller handles itself instead of treating as errors (e.g. 404 on teardown). */
	allowStatus?: number[];
}

export interface ThrottleResponse {
	statusCode: number;
	body: IDataObject;
}

/** Drops keys the n8n UI leaves blank, so they never reach a `.strict()` API schema. */
export function compact(obj: IDataObject): IDataObject {
	const out: IDataObject = {};
	for (const [key, value] of Object.entries(obj)) {
		if (value === undefined || value === null || value === '') continue;
		out[key] = value;
	}
	return out;
}

/**
 * What the user should do about a Throttle error code.
 *
 * Throttle answers every failure with `{ error: { code, message } }`. n8n shows
 * a bare status ("403 - Forbidden") unless told more, which says nothing about
 * which permission the key is missing.
 */
function hintFor(code: string | undefined, scopes: readonly string[]): string | undefined {
	switch (code) {
		case 'insufficient_scopes':
			return scopes.length
				? `The secret key in this credential needs these scopes: ${scopes.join(', ')}. Edit the key in the Throttle dashboard, or create a new one.`
				: 'The secret key in this credential is missing a scope this operation needs.';
		case 'environment_mismatch':
			return 'The record belongs to a different environment than this key. Each key reaches one environment; use a credential with a key from the other environment.';
		case 'unauthorized':
			return 'Throttle did not accept the secret key. Check that it was copied in full and has not been revoked.';
		case 'idempotency_key_reused':
			return 'This step was retried with different input inside the same execution. Run the workflow again to send it as a new request.';
		default:
			return undefined;
	}
}

export async function throttleRequest(
	this: Context,
	request: ThrottleRequest,
	scopes: readonly string[] = [],
): Promise<ThrottleResponse> {
	const headers: IDataObject = { accept: 'application/json' };
	if (request.idempotencyKey) headers['idempotency-key'] = request.idempotencyKey;

	const options: IHttpRequestOptions = {
		method: request.method,
		baseURL: API_BASE,
		url: request.path,
		headers,
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	};
	if (request.qs) options.qs = compact(request.qs);
	if (request.body) options.body = request.body;

	const response = (await this.helpers.httpRequestWithAuthentication.call(
		this,
		'throttleApi',
		options,
	)) as { statusCode: number; body: IDataObject | string | undefined };

	const statusCode = response.statusCode;
	const body: IDataObject = response.body && typeof response.body === 'object' ? response.body : {};

	if (statusCode >= 400 && !(request.allowStatus ?? []).includes(statusCode)) {
		const error = (body.error ?? {}) as IDataObject;
		const code = typeof error.code === 'string' ? error.code : undefined;
		const message =
			typeof error.message === 'string' && error.message
				? error.message
				: `Throttle returned HTTP ${statusCode}`;
		throw new NodeApiError(this.getNode(), body as JsonObject, {
			httpCode: String(statusCode),
			message: code ? `${message} (${code})` : message,
			description: hintFor(code, scopes),
		});
	}
	return { statusCode, body };
}

/** `{ data }` → data; anything else passes through. */
export function unwrap(body: IDataObject): IDataObject | IDataObject[] {
	return Object.prototype.hasOwnProperty.call(body, 'data')
		? (body.data as IDataObject | IDataObject[])
		: body;
}

/** The largest page the list endpoints accept. */
const PAGE_SIZE = 100;

/**
 * Follows Throttle's cursor pagination (`meta.pagination.{cursor,hasMore}`)
 * until `limit` records are collected, or every page when `limit` is undefined.
 */
export async function throttleList(
	this: IExecuteFunctions,
	path: string,
	qs: IDataObject,
	limit: number | undefined,
	scopes: readonly string[],
): Promise<IDataObject[]> {
	const results: IDataObject[] = [];
	let cursor: string | undefined;
	do {
		const pageSize = limit === undefined ? PAGE_SIZE : Math.min(PAGE_SIZE, limit - results.length);
		const { body } = await throttleRequest.call(
			this,
			{ method: 'GET', path, qs: { ...qs, limit: pageSize, cursor } },
			scopes,
		);
		const data = Array.isArray(body.data) ? (body.data as IDataObject[]) : [];
		results.push(...data);
		const pagination = ((body.meta as IDataObject | undefined)?.pagination ?? {}) as IDataObject;
		cursor =
			pagination.hasMore === true && typeof pagination.cursor === 'string' && data.length > 0
				? pagination.cursor
				: undefined;
	} while (cursor && (limit === undefined || results.length < limit));
	return limit === undefined ? results : results.slice(0, limit);
}

/**
 * Idempotency key for one write step.
 *
 * Throttle replays the stored response for a repeated key (24h TTL), so a key
 * that is stable across n8n's "Retry On Fail" attempts collapses a retried
 * write onto the first result instead of creating a second customer, quote or
 * refund. It must also differ between executions — a workflow that runs again
 * tomorrow with the same input means it — so the execution id is part of it.
 * `step` separates the calls of a multi-request operation.
 */
export function idempotencyKey(
	this: IExecuteFunctions,
	actionId: string,
	itemIndex: number,
	step = '',
): string {
	const digest = createHash('sha256')
		.update(JSON.stringify([this.getExecutionId(), this.getNode().id, itemIndex, actionId, step]))
		.digest('hex')
		.slice(0, 40);
	return `n8n-${actionId}-${digest}`;
}

/** Substitutes `:param` path segments, URL-encoded. */
export function buildPath(template: string, params: IDataObject): string {
	return template.replace(/:([A-Za-z0-9_]+)/g, (_, name: string) => {
		const value = params[name];
		if (value === undefined || value === null || value === '') {
			throw new Error(`Missing path parameter "${name}"`);
		}
		return encodeURIComponent(String(value));
	});
}
