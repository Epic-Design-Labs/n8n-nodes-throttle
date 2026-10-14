import type { INodeProperties, INodePropertyOptions, NodeParameterValueType } from 'n8n-workflow';
import catalogJson from './catalog.json';

export interface CatalogField {
	name: string;
	displayName: string;
	type: 'string' | 'number' | 'boolean' | 'object' | 'array';
	required: boolean;
	description: string;
	enum?: string[];
	default?: string | number | boolean;
}

export interface CatalogOperation {
	actionId: string;
	resource: string;
	operation: string;
	name: string;
	description: string;
	kind: 'read' | 'write';
	destructive: boolean;
	guardrails: string[];
	scopes: string[];
	requests: Array<{ method: string; path: string }>;
	paginated: boolean;
	fixed?: Record<string, string>;
	fields: CatalogField[];
}

export interface CatalogTrigger {
	id: string;
	title: string;
	description: string;
	eventType: string;
	scope: string;
}

export interface Catalog {
	resources: Array<{ value: string; name: string }>;
	operations: CatalogOperation[];
	triggers: CatalogTrigger[];
}

export const catalog = catalogJson as unknown as Catalog;

export function findOperation(resource: string, operation: string): CatalogOperation | undefined {
	return catalog.operations.find((o) => o.resource === resource && o.operation === operation);
}

/** The first sentence: catalog descriptions are written for a model, n8n shows one line. */
function firstSentence(text: string): string {
	const match = text.match(/^(.+?[.!?])(\s|$)/);
	return match ? match[1] : text;
}

/**
 * Optional fields are grouped the way n8n's own nodes group them: "Filters" on
 * a list, "Update Fields" on an update, "Additional Fields" elsewhere.
 */
export function collectionName(op: CatalogOperation): string {
	if (op.operation === 'getAll' || op.paginated) return 'filters';
	if (op.operation === 'update') return 'updateFields';
	return 'additionalFields';
}

const COLLECTION_LABELS: Record<string, [string, string]> = {
	filters: ['Filters', 'Add Filter'],
	updateFields: ['Update Fields', 'Add Field'],
	additionalFields: ['Additional Fields', 'Add Field'],
};

function defaultFor(field: CatalogField): NodeParameterValueType {
	if (field.default !== undefined) return field.default;
	switch (field.type) {
		case 'number':
			return 0;
		case 'boolean':
			return false;
		case 'array':
			return '[]';
		case 'object':
			return '{}';
		default:
			return field.enum ? field.enum[0] : '';
	}
}

function toProperty(field: CatalogField, inCollection: boolean): INodeProperties {
	const base = {
		displayName: field.displayName,
		name: field.name,
		description: field.description,
		default: defaultFor(field),
		...(field.required && !inCollection ? { required: true } : {}),
	};
	if (field.enum) {
		return {
			...base,
			type: 'options',
			options: field.enum.map((value) => ({ name: value, value })),
		} as INodeProperties;
	}
	switch (field.type) {
		case 'number':
			return { ...base, type: 'number' } as INodeProperties;
		case 'boolean':
			return { ...base, type: 'boolean' } as INodeProperties;
		case 'array':
		case 'object':
			return { ...base, type: 'json' } as INodeProperties;
		default:
			return { ...base, type: 'string' } as INodeProperties;
	}
}

const sentenceCase = (text: string) => text.charAt(0) + text.slice(1).toLowerCase();

/** n8n's action-picker phrasing: "Create a customer", "Get many orders". */
function actionLabel(op: CatalogOperation, resourceName: string): string {
	const noun = resourceName.toLowerCase();
	// Analytics and workspace operations already name their subject.
	if (op.resource === 'analytics' || op.resource === 'workspace') return sentenceCase(op.name);
	if (op.name.startsWith('Get Many')) return `${sentenceCase(op.name)} ${noun}s`;
	return `${sentenceCase(op.name)} a ${noun}`;
}

function operationOption(op: CatalogOperation, resourceName: string): INodePropertyOptions {
	return {
		name: op.name,
		value: op.operation,
		description: firstSentence(op.description),
		action: actionLabel(op, resourceName),
	};
}

/**
 * Shown above operations with consequences outside the workflow. The catalog's
 * own guardrails are instructions to a model ("confirm with the user first");
 * a person building a workflow needs the consequence instead.
 */
const NOTICES: Record<string, string> = {
	refund_payment:
		'Returns money to the buyer and cannot be undone. Amount is in minor units (2500 = $25.00) and is required: Throttle treats a missing amount as a full refund.',
	send_quote: 'Emails the quote to the buyer.',
	cancel_subscription:
		'Ends billing for this subscription. Leave At Period End off to cancel now; turn it on to let the buyer keep the period they paid for.',
	create_checkout_link: 'The link is buyer-facing. With a production key it takes real payment.',
	create_quote:
		'Line items with a recurring price need pay-in-full terms; leave Net Terms empty for them.',
};

function buildProperties(): INodeProperties[] {
	const properties: INodeProperties[] = [
		{
			displayName: 'Resource',
			name: 'resource',
			type: 'options',
			noDataExpression: true,
			options: catalog.resources.map((r) => ({ name: r.name, value: r.value })),
			default: 'order',
		},
	];

	for (const resource of catalog.resources) {
		const ops = catalog.operations
			.filter((o) => o.resource === resource.value)
			.sort((a, b) => a.name.localeCompare(b.name));
		const defaultOperation = ops[0].operation;
		const operationProperty: INodeProperties = {
			displayName: 'Operation',
			name: 'operation',
			type: 'options',
			noDataExpression: true,
			displayOptions: { show: { resource: [resource.value] } },
			options: ops.map((op) => operationOption(op, resource.name)),
			default: defaultOperation,
		};
		properties.push(operationProperty);

		for (const op of ops) {
			const show = { resource: [resource.value], operation: [op.operation] };

			const notice = NOTICES[op.actionId];
			if (notice) {
				properties.push({
					displayName: notice,
					name: 'notice',
					type: 'notice',
					default: '',
					displayOptions: { show },
				});
			}

			for (const field of op.fields.filter((f) => f.required)) {
				properties.push({ ...toProperty(field, false), displayOptions: { show } });
			}

			if (op.paginated) {
				properties.push(
					{
						displayName: 'Return All',
						name: 'returnAll',
						type: 'boolean',
						default: false,
						description: 'Whether to return all results or only up to a given limit',
						displayOptions: { show },
					},
					{
						displayName: 'Limit',
						name: 'limit',
						type: 'number',
						typeOptions: { minValue: 1 },
						default: 50,
						description: 'Max number of results to return',
						displayOptions: { show: { ...show, returnAll: [false] } },
					},
				);
			}

			const optional = op.fields
				.filter((f) => !f.required)
				.sort((a, b) => a.displayName.localeCompare(b.displayName));
			if (optional.length > 0) {
				const name = collectionName(op);
				const [displayName, placeholder] = COLLECTION_LABELS[name];
				properties.push({
					displayName,
					name,
					type: 'collection',
					placeholder,
					default: {},
					displayOptions: { show },
					options: optional.map((f) => toProperty(f, true)),
				});
			}
		}
	}
	return properties;
}

export const throttleProperties = buildProperties();
