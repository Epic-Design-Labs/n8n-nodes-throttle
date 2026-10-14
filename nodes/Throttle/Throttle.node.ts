import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { collectionName, findOperation, throttleProperties } from './descriptions';
import { readParameters, runOperation } from './operations';

/**
 * Programmatic rather than declarative: "Create Link" is three dependent
 * calls (cart → items → checkout session), list operations follow Throttle's
 * cursor pagination for "Return All", and every write carries an idempotency
 * key derived from the execution — none of which `routing` can express.
 *
 * The resources, operations and fields are generated from Throttle's action
 * catalog (`catalog.json`), the same definition that drives its MCP server.
 */
export class Throttle implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Throttle',
		name: 'throttle',
		icon: { light: 'file:../../icons/throttle.svg', dark: 'file:../../icons/throttle.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Read and act on orders, customers, subscriptions, quotes and payments in Throttle',
		defaults: { name: 'Throttle' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'throttleApi', required: true }],
		properties: throttleProperties,
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;
				const op = findOperation(resource, operation);
				if (!op) {
					throw new NodeOperationError(
						this.getNode(),
						`Unknown operation "${operation}" on resource "${resource}"`,
						{ itemIndex: i },
					);
				}

				const params = readParameters.call(this, op, collectionName(op), i);
				const result = await runOperation.call(this, op, params, i);
				const records = Array.isArray(result) ? result : [result];
				for (const record of records) {
					returnData.push({ json: record as IDataObject, pairedItem: { item: i } });
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				// Keeps the message and the remediation hint of a NodeApiError, and
				// adds the item it failed on.
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
