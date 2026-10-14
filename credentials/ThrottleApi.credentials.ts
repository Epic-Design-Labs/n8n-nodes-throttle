import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class ThrottleApi implements ICredentialType {
	name = 'throttleApi';

	displayName = 'Throttle API';

	icon: Icon = { light: 'file:../icons/throttle.svg', dark: 'file:../icons/throttle.dark.svg' };

	documentationUrl = 'https://usethrottle.dev/docs/developers/n8n';

	properties: INodeProperties[] = [
		{
			displayName: 'Secret Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			placeholder: 'sk_live_...',
			description:
				'A secret key (sk_...) from the API keys page of your application in the Throttle dashboard. The key decides the workspace, application and environment this credential reaches, and which operations it can run.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				'X-API-Key': '={{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://api.usethrottle.dev',
			url: '/api/v1/whoami',
		},
	};
}
