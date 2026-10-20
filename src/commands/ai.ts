/**
 * `snoutdata ai` — a project's own AI gateway, from a terminal.
 *
 * The gateway (snout-psyche) runs inside the project's pod, and everything it serves is rows in
 * the project's own database: the providers and their keys, the models and their prices, the keys
 * apps call it with, the budgets, the request log. This command holds none of it and decides
 * nothing. Switching it on and off is `cloud-project-ai`; everything else is one call to the
 * gateway's own admin API, relayed by that same function with the project's server key (the CLI
 * never holds it), through the admin client the dashboard and Studio use. So a rule (a key is
 * proven against its provider before it is kept, a model nothing prices is refused to signed-in
 * users) is the gateway's, and its sentence is the one printed here.
 *
 * A provider key is read from stdin, never from argv, for the reason `secrets set --stdin` gives:
 * argv is in the shell history and in `ps`.
 */

import * as api from '../api.js';
import { UsageError } from '../args.js';
import { CliFailure, codeForStatus } from '../failure.js';
import { bold, dim, emit, say, table, warn } from '../output.js';
import { readStdin } from './secrets.js';
import {
	MODEL_SOURCES,
	PsycheAdmin,
	connectBodies,
	dollars,
	modelBody,
	sourceMatches,
	suggestModelName,
	type Budget,
	type CredentialInput,
	type Key,
	type Model,
	type ModelSource,
	type Price,
	type Provider,
	type ProviderInput,
	type Transport,
	type UsageBy,
	type UsageRow,
	type Whom
} from '../shared/psyche-admin/index.ts';

export interface AiState {
	ref: string;
	ai: { enabled: boolean; endpoint: string; restartsDatabase: string };
}

async function readState(ref: string, enable?: boolean): Promise<AiState> {
	return api.call<AiState>('cloud-project-ai', enable === undefined ? { ref } : { ref, enable });
}

/**
 * A refusal in the gateway's own words. The relay passes the gateway's `{ error: { message, code } }`
 * through unchanged, which `api.call` cannot read a sentence from (it looks for a string), so
 * without this a refused key would print as "400 Bad Request".
 */
export function inGatewayWords(error: unknown): unknown {
	if (error instanceof api.ApiError) {
		const said = (error.body as { error?: { message?: unknown; code?: unknown } } | undefined)?.error;
		if (said && typeof said === 'object' && typeof said.message === 'string') {
			return new api.ApiError(error.status, said.message, typeof said.code === 'string' ? said.code : null, error.body);
		}
	}
	return error;
}

function relay(ref: string): Transport {
	return async (method, path, body) => {
		try {
			return await api.call<unknown>('cloud-project-ai', { ref, admin: { method, path, ...(body === undefined ? {} : { body }) } });
		} catch (error) {
			throw inGatewayWords(error);
		}
	};
}

function gateway(ref: string): PsycheAdmin {
	return new PsycheAdmin(relay(ref));
}

/** Switched on a moment ago, so the gateway is not answering yet. */
function starting(error: unknown): boolean {
	return error instanceof api.ApiError && (error.status === 502 || (error.status === 404 && error.serverCode !== 'ai-off'));
}

// --- words ------------------------------------------------------------------------------------

/** A rate as people read one: whole dollars bare, cents to two places, finer rates as given. */
export function rate(n: number): string {
	if (Number.isInteger(n)) {
		return `$${n}`;
	}
	if (Math.abs(n * 100 - Math.round(n * 100)) < 1e-9) {
		return `$${n.toFixed(2)}`;
	}
	return `$${n}`;
}

export function priceText(price: Price | null): string {
	return price ? `${rate(price.input)} in, ${rate(price.output)} out` : 'no price';
}

/** Whom a budget is for, in words. */
export function scopeText(whom: Required<Whom>): string {
	if (whom.every_user) {
		return 'every user';
	}
	if (whom.user_id) {
		return `user ${whom.user_id}`;
	}
	if (whom.key_id) {
		return `key ${whom.key_id}`;
	}
	if (whom.group_id) {
		return `group ${whom.group_id}`;
	}
	return 'the project';
}

function budgetText(budget: Budget): string {
	const per =
		budget.period === 'rolling'
			? `per ${budget.days ?? '?'} days`
			: budget.period === 'since'
				? `since ${budget.starts_on ?? '?'}`
				: `a ${budget.period}`;
	const amount = dollars(budget.amount);
	return `${amount === null ? `$${budget.amount}` : rate(amount)} ${per}, ${budget.hard ? 'hard' : 'soft'}`;
}

function money(text: string | null): string {
	const value = dollars(text);
	return value === null ? '-' : `$${value.toFixed(value !== 0 && value < 0.01 ? 4 : 2)}`;
}

function when(seconds: number | null): string {
	return seconds === null ? 'never' : new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

/** The first day of the last `days` days, UTC. */
export function fromDay(days: number, now = Date.now()): string {
	return new Date(now - (days - 1) * 86_400_000).toISOString().slice(0, 10);
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// --- on, off, and what it is doing ---------------------------------------------------------------

export async function status(ref: string): Promise<void> {
	const state = await readState(ref);
	if (!state.ai.enabled) {
		emit({ ref, enabled: false, endpoint: state.ai.endpoint }, () => {
			say(`AI is off for ${ref}.`);
			say(dim(`  snoutdata ai enable --ref ${ref}    ${state.ai.restartsDatabase}`));
		});
		return;
	}
	const psyche = gateway(ref);
	const [models, budgets, usage] = await Promise.allSettled([psyche.models(), psyche.budgets(), psyche.usage({ by: 'day', from: fromDay(30) })]);
	const failed = [models, budgets, usage].find((one) => one.status === 'rejected') as PromiseRejectedResult | undefined;
	if (failed && starting(failed.reason)) {
		emit({ ref, enabled: true, endpoint: state.ai.endpoint, serving: false }, () => {
			say(`AI is on for ${ref}, and its gateway is still starting. Try again in a minute.`);
		});
		return;
	}
	if (failed) {
		throw failed.reason;
	}
	const modelList = (models as PromiseFulfilledResult<Model[]>).value;
	const budgetList = (budgets as PromiseFulfilledResult<Budget[]>).value;
	const days = (usage as PromiseFulfilledResult<{ data: UsageRow[] }>).value.data;
	const spent = days.reduce((sum, row) => sum + (dollars(row.cost) ?? 0), 0);
	const requests = days.reduce((sum, row) => sum + row.requests, 0);
	emit({ ref, enabled: true, endpoint: state.ai.endpoint, serving: true, models: modelList, budgets: budgetList, last30Days: { requests, cost: spent } }, () => {
		say(`${bold(`AI for ${ref}`)}: on, at ${state.ai.endpoint}`);
		say('');
		if (modelList.length === 0) {
			say('No models yet. Add one:');
			say(dim(`  snoutdata ai models add --source openai --model gpt-4o-mini --stdin < key.txt`));
		} else {
			say(modelTable(modelList));
		}
		say('');
		say(budgetList.length === 0 ? 'No budgets.' : budgetList.map((b) => `Budget: ${scopeText(b)}, ${budgetText(b)}`).join('\n'));
		say(`Last 30 days: ${plural(requests, 'request')}, $${spent.toFixed(2)}.`);
	});
}

export async function setEnabled(ref: string, on: boolean): Promise<void> {
	const state = await readState(ref, on);
	emit(state, () => {
		if (on) {
			say(`AI is on for ${ref}. ${state.ai.restartsDatabase} The gateway answers at ${state.ai.endpoint} within a minute or two.`);
			say(dim('  next: snoutdata ai models add --source openai --model gpt-4o-mini --stdin < key.txt'));
		} else {
			say(`AI is off for ${ref}. Its providers, models, keys and log stay in the project's database, for when it is switched on again.`);
		}
	});
}

// --- models and providers --------------------------------------------------------------------

function modelTable(models: readonly Model[]): string {
	return table([
		['MODEL', 'PROVIDER', 'UPSTREAM', 'PRICE PER M TOKENS', 'SERVED'],
		...models.map((m) => [
			m.name,
			m.provider,
			m.upstream,
			priceText(m.price) + (m.price_from === 'catalogue' ? ' (catalogue)' : ''),
			m.served ? 'yes' : `no: ${m.problem ?? (m.enabled ? 'not served' : 'disabled')}`
		])
	]);
}

export async function listModels(ref: string): Promise<void> {
	const models = await gateway(ref).models();
	emit(models, () => {
		say(models.length === 0 ? `No models on ${ref}'s gateway yet.` : modelTable(models));
	});
}

export async function listProviders(ref: string): Promise<void> {
	const providers = await gateway(ref).providers();
	emit(providers, () => {
		if (providers.length === 0) {
			say(`No providers on ${ref}'s gateway yet. \`snoutdata ai models add\` makes one with its first model.`);
			return;
		}
		say(
			table([
				['PROVIDER', 'KIND', 'WHERE', 'KEY', 'MODELS'],
				...providers.map((p) => [
					p.name,
					p.kind,
					p.kind === 'bedrock' ? (p.region ?? '') : p.base_url,
					keyWords(p),
					p.models.join(', ') || '-'
				])
			])
		);
		for (const p of providers.filter((one) => one.problem)) {
			warn(`${p.name}: ${p.problem}`);
		}
	});
}

function keyWords(provider: Provider): string {
	if (provider.key === 'environment') {
		return 'from the environment';
	}
	if (provider.key === 'none' || provider.credential === null) {
		return 'none';
	}
	return provider.credential_stored ? 'stored' : 'missing';
}

export async function removeProvider(ref: string, name: string | undefined): Promise<void> {
	if (!name) {
		throw new UsageError('ai providers remove needs the provider\'s name (see `snoutdata ai providers`)');
	}
	await gateway(ref).deleteProvider(name);
	emit({ ref, removed: name }, () => say(`Removed the provider ${name}.`));
}

export interface AddModelOptions {
	source?: string;
	upstream?: string;
	provider?: string;
	baseUrl?: string;
	region?: string;
	priceIn?: string;
	priceOut?: string;
	accessKeyId?: string;
	authHeader?: string;
	stdin: boolean;
}

export function findSource(id: string | undefined): ModelSource {
	const ids = MODEL_SOURCES.map((s) => s.id).join('|');
	if (!id) {
		throw new UsageError(`ai models add needs --source ${ids}: where the model runs`);
	}
	const source = MODEL_SOURCES.find((s) => s.id === id);
	if (!source) {
		throw new UsageError(`--source is one of ${ids}, not "${id}"`);
	}
	return source;
}

/** The place's own steps, as the dashboard's guide shows them: for a person who has not got the key or the model's id yet. */
function printGuide(source: ModelSource): void {
	say(bold(`Adding a model from ${source.name}`));
	const sections: Array<[string, { steps: string[]; link?: { label: string; href: string }; console?: { label: string; href: string } }]> = [
		['The key', source.connect],
		['The model\'s id', source.model],
		['Its price', source.price]
	];
	for (const [title, section] of sections) {
		say('');
		say(bold(title));
		for (const step of section.steps) {
			say(`  - ${step}`);
		}
		const link = section.console ?? section.link;
		if (link) {
			say(dim(`  ${link.label}: ${link.href}`));
		}
	}
	say('');
}

/** Which provider a new model goes on: the one named, else the one of this source already there, else a new one. */
export function chooseProvider(source: ModelSource, providers: readonly Provider[], named: string | undefined): { name: string; existing: Provider | null } {
	if (named) {
		return { name: named, existing: providers.find((p) => p.name === named) ?? null };
	}
	const mine = providers.filter((p) => sourceMatches(source, p));
	if (mine.length === 1) {
		return { name: mine[0]!.name, existing: mine[0]! };
	}
	if (mine.length > 1) {
		throw new UsageError(`${source.name} is connected more than once (${mine.map((p) => p.name).join(', ')}): say which with --provider`);
	}
	return { name: source.suggestedName, existing: providers.find((p) => p.name === source.suggestedName) ?? null };
}

export async function addModel(ref: string, given: string | undefined, options: AddModelOptions): Promise<void> {
	const source = findSource(options.source);
	const upstream = options.upstream?.trim();
	if (!upstream) {
		printGuide(source);
		throw new UsageError(`Give the model's id as ${source.name} names it, with --model (for example ${source.model.example})`);
	}
	const name = given?.trim() || suggestModelName(upstream);
	const psyche = gateway(ref);
	const [providers, models] = await Promise.all([psyche.providers(), psyche.models()]);
	if (models.some((m) => m.name === name)) {
		throw new UsageError(`${ref} already has a model called ${name}. Name this one differently, or remove that one first.`);
	}
	const { name: providerName, existing } = chooseProvider(source, providers, options.provider);
	if (existing && existing.kind !== source.kind) {
		throw new UsageError(`The provider ${providerName} speaks ${existing.kind}, not ${source.name}: choose another --provider name`);
	}
	if (existing?.origin === 'file' && options.stdin) {
		throw new UsageError(`The provider ${providerName} comes from the gateway's providers file, so its key is set there, not here`);
	}

	const secret = options.stdin ? await readStdin() : undefined;
	const aws = source.auth === 'bedrock' && options.accessKeyId !== undefined;
	let pending: { provider: ProviderInput; credential: CredentialInput | null } | null = null;
	if (!existing) {
		if (source.auth !== 'optional' && !secret) {
			throw new UsageError(
				aws
					? 'Pipe the AWS secret access key in with --stdin; --access-key-id is its id'
					: `${source.name} needs a key: pipe it in with --stdin (snoutdata ai models add ... --stdin < key.txt), so it is in neither the shell history nor ps`
			);
		}
		const body = connectBodies(source, providerName, {
			baseUrl: options.baseUrl ?? source.baseUrl,
			region: options.region,
			apiKey: aws ? undefined : secret,
			aws,
			accessKeyId: options.accessKeyId,
			secretAccessKey: aws ? secret : undefined,
			authHeader: options.authHeader
		});
		if ('problem' in body) {
			throw new UsageError(source.kind === 'bedrock' && !options.region ? 'Give the region the model runs in, with --region' : options.baseUrl === undefined && source.kind !== 'bedrock' ? 'Give the provider\'s address, with --base-url' : body.problem);
		}
		pending = body;
	}

	const built = modelBody({ provider: providerName, upstream, input: options.priceIn, output: options.priceOut, caching: source.caching, enabled: true, access: 'everyone' });
	if ('problem' in built) {
		throw new UsageError(built.problem.replace('input and the output rate', '--price-in and --price-out'));
	}

	// The dashboard's order, for the dashboard's reason: the gateway proves a key by calling one of
	// the provider's models, so the provider and the model go first and the key last. Refused part
	// way (most often the key, by the provider), what this made is taken back, so trying again
	// starts clean.
	let madeProvider = false;
	let madeModel = false;
	let model: Model;
	try {
		if (pending) {
			await psyche.putProvider(providerName, pending.provider);
			madeProvider = true;
		}
		model = await psyche.putModel(name, built.model);
		madeModel = true;
		if (pending?.credential) {
			await psyche.putCredential(providerName, pending.credential);
		} else if (existing && secret) {
			if (!existing.credential) {
				throw new UsageError(`The provider ${providerName} takes no key`);
			}
			await psyche.putCredential(existing.credential, aws ? { access_key_id: options.accessKeyId!, secret_access_key: secret } : { api_key: secret });
		}
	} catch (error) {
		if (madeModel) {
			await psyche.deleteModel(name).catch(() => {});
		}
		if (madeProvider) {
			await psyche.deleteProvider(providerName).catch(() => {});
		}
		throw error;
	}
	// Read back, so `served` and the price reflect the key that was just stored.
	model = (await psyche.models()).find((m) => m.name === name) ?? model;
	emit(model, () => {
		say(`Added ${bold(name)} (${upstream} on ${providerName}${madeProvider ? ', a new provider' : ''}), at ${priceText(model.price)}${model.price_from === 'catalogue' ? ' from the shipped catalogue' : ''}.`);
		if (!model.price) {
			warn('Nothing prices this model, so signed-in users are refused it. Give it a price with --price-in and --price-out.');
		}
		if (!model.served && model.problem) {
			warn(`It is not served yet: ${model.problem}`);
		}
		say(dim(`  snoutdata ai test --model ${name}`));
	});
}

export async function removeModel(ref: string, name: string | undefined): Promise<void> {
	if (!name) {
		throw new UsageError('ai models remove needs the model\'s name (see `snoutdata ai models`)');
	}
	const answer = await gateway(ref).deleteModel(name);
	emit(answer, () => say(answer.disabled ? `${name} comes from the gateway's providers file, so it was disabled rather than removed.` : `Removed ${name}.`));
}

// --- keys ------------------------------------------------------------------------------------------

function keyState(key: Key, now = Date.now() / 1000): string {
	if (key.revoked_at !== null) {
		return 'revoked';
	}
	if (key.expires_at !== null && key.expires_at <= now) {
		return 'expired';
	}
	return key.expires_at !== null ? `until ${when(key.expires_at).slice(0, 10)}` : 'active';
}

export async function listKeys(ref: string): Promise<void> {
	const keys = await gateway(ref).keys();
	emit(keys, () => {
		if (keys.length === 0) {
			say(`No keys on ${ref}'s gateway. \`snoutdata ai keys create --name my-server\` makes one for a server.`);
			return;
		}
		say(
			table([
				['NAME', 'ID', 'KEY', 'MODELS', 'CREATED', 'LAST USED', 'STATE'],
				...keys.map((k) => [
					k.name,
					k.id,
					k.hint,
					k.models?.join(', ') ?? 'all',
					when(k.created_at),
					k.last_used_at !== null ? when(k.last_used_at) : (k.last_used_on ?? 'never'),
					keyState(k)
				])
			])
		);
	});
}

export async function createKey(ref: string, options: { name?: string; models?: string; expiresDays?: number }): Promise<void> {
	if (!options.name) {
		throw new UsageError('ai keys create needs --name: what the key is for, shown in ai keys');
	}
	if (options.expiresDays !== undefined && options.expiresDays <= 0) {
		throw new UsageError('--expires is a number of days, 1 or more');
	}
	const models = options.models?.split(',').map((m) => m.trim()).filter(Boolean);
	const made = await gateway(ref).createKey({
		name: options.name,
		...(models && models.length > 0 ? { models } : {}),
		...(options.expiresDays !== undefined ? { expires_in: options.expiresDays * 86_400 } : {})
	});
	const state = await readState(ref);
	emit({ ...made, endpoint: state.ai.endpoint }, () => {
		process.stdout.write(`${made.key}\n`);
		say('');
		say(`${bold(made.name)}: ${made.models ? `for ${made.models.join(', ')}` : 'for every model'}, ${made.expires_at ? `until ${when(made.expires_at)}` : 'until revoked'}.`);
		say('This is the only time it is shown: only its hash is kept. It is a server\'s key; a browser calls with the app key and a signed-in user instead.');
		say(dim(`  OPENAI_BASE_URL=${state.ai.endpoint}  OPENAI_API_KEY=<that key>`));
	});
}

export async function revokeKey(ref: string, id: string | undefined): Promise<void> {
	if (!id) {
		throw new UsageError('ai keys revoke needs the key\'s id (see `snoutdata ai keys`)');
	}
	await gateway(ref).revokeKey(id);
	emit({ ref, revoked: id }, () => say(`Revoked ${id}. A call with it is refused from now on.`));
}

// --- budgets --------------------------------------------------------------------------------------

export async function listBudgets(ref: string): Promise<void> {
	const budgets = await gateway(ref).budgets();
	emit(budgets, () => {
		if (budgets.length === 0) {
			say(`No budgets on ${ref}'s gateway. A browser call needs two hard ones:`);
			say(dim('  snoutdata ai budgets set project --amount 5'));
			say(dim('  snoutdata ai budgets set users --amount 0.50'));
			return;
		}
		say(table([['ID', 'FOR', 'BUDGET'], ...budgets.map((b) => [b.id, scopeText(b), budgetText(b)])]));
	});
}

export type BudgetScope = 'project' | 'users';

export function parseScope(word: string | undefined): BudgetScope {
	if (word === 'project' || word === 'users') {
		return word;
	}
	throw new UsageError('ai budgets set takes project (the whole project) or users (each signed-in user)');
}

/** The budget `set` changes rather than adds: the same scope and period. */
export function sameBudget(budgets: readonly Budget[], scope: BudgetScope, period: 'day' | 'month'): Budget | undefined {
	return budgets.find(
		(b) => b.period === period && !b.key_id && !b.user_id && !b.group_id && (scope === 'users' ? b.every_user : !b.every_user)
	);
}

export async function setBudget(ref: string, word: string | undefined, options: { amount?: string; period?: string; soft: boolean }): Promise<void> {
	const scope = parseScope(word);
	const amount = Number(options.amount);
	if (options.amount === undefined || !Number.isFinite(amount) || amount < 0) {
		throw new UsageError('ai budgets set needs --amount, in dollars, zero or more');
	}
	const period = options.period ?? 'day';
	if (period !== 'day' && period !== 'month') {
		throw new UsageError('--period is day or month');
	}
	const psyche = gateway(ref);
	const existing = sameBudget(await psyche.budgets(), scope, period);
	const budget = existing
		? await psyche.editBudget(existing.id, { amount, hard: !options.soft })
		: await psyche.createBudget({
				name: scope === 'users' ? 'every user' : 'project',
				amount,
				period,
				hard: !options.soft,
				...(scope === 'users' ? { every_user: true } : {})
			});
	// In the scope asked for: an edit's answer does not carry whom the budget is for.
	emit(budget, () => say(`${existing ? 'Changed' : 'Set'}: ${scope === 'users' ? 'every user' : 'the project'}, ${budgetText(budget)}.`));
}

export async function removeBudget(ref: string, id: string | undefined): Promise<void> {
	if (!id) {
		throw new UsageError('ai budgets remove needs the budget\'s id (see `snoutdata ai budgets`)');
	}
	await gateway(ref).deleteBudget(id);
	emit({ ref, removed: id }, () => say(`Removed the budget ${id}.`));
}

// --- usage ----------------------------------------------------------------------------------------

const USAGE_BY: readonly UsageBy[] = ['day', 'model', 'provider', 'operation', 'key', 'user', 'group'];

export async function usage(ref: string, options: { days?: number; by?: string }): Promise<void> {
	const by = (options.by ?? 'model') as UsageBy;
	if (!USAGE_BY.includes(by)) {
		throw new UsageError(`--by is one of ${USAGE_BY.join('|')}`);
	}
	const days = options.days ?? 30;
	if (days < 1 || days > 366) {
		throw new UsageError('--days is 1 to 366');
	}
	const answer = await gateway(ref).usage({ by, from: fromDay(days) });
	emit(answer, () => {
		if (answer.data.length === 0) {
			say(`No calls to ${ref}'s gateway from ${answer.from} to ${answer.to}.`);
			return;
		}
		const total = answer.data.reduce((sum, row) => sum + (dollars(row.cost) ?? 0), 0);
		say(
			table([
				[by.toUpperCase(), 'REQUESTS', 'FAILED', 'TOKENS IN', 'TOKENS OUT', 'COST'],
				...answer.data.map((row) => [
					String(row[by] ?? '-'),
					String(row.requests),
					String(row.failed),
					String(row.prompt_tokens),
					String(row.completion_tokens),
					money(row.cost) + (row.unpriced > 0 ? ` (+${row.unpriced} unpriced)` : '')
				])
			])
		);
		say(`${answer.from} to ${answer.to}: $${total.toFixed(2)}.`);
	});
}

// --- test -----------------------------------------------------------------------------------------

/**
 * One call through the project's own door, as an app makes it: a key made for this call alone
 * (ten minutes, this one model), a chat completion, and the key revoked again whatever happened.
 */
export async function test(ref: string, options: { model?: string; prompt?: string }): Promise<number> {
	const state = await readState(ref);
	if (!state.ai.enabled) {
		throw new CliFailure('not-found', `AI is off for ${ref}. Switch it on first: snoutdata ai enable.`);
	}
	const psyche = gateway(ref);
	const models = await psyche.models();
	const chat = models.filter((m) => m.served && m.embeddings === null);
	const model = options.model ?? chat[0]?.name;
	if (!model) {
		throw new CliFailure('not-found', `${ref}'s gateway serves no chat model yet. Add one: snoutdata ai models add.`);
	}
	const made = await psyche.createKey({ name: 'snoutdata ai test', models: [model], expires_in: 600 });
	const started = Date.now();
	let status = 0;
	let answer: {
		choices?: Array<{ message?: { content?: string } }>;
		usage?: { prompt_tokens?: number; completion_tokens?: number };
		error?: { message?: string; code?: string };
	} = {};
	try {
		const response = await fetch(`${state.ai.endpoint}/chat/completions`, {
			method: 'POST',
			headers: { authorization: `Bearer ${made.key}`, 'content-type': 'application/json' },
			body: JSON.stringify({ model, max_tokens: 64, messages: [{ role: 'user', content: options.prompt ?? 'Say hello in five words.' }] })
		});
		status = response.status;
		const text = await response.text();
		try {
			answer = text ? JSON.parse(text) : {};
		} catch {
			answer = { error: { message: api.unreadableAnswer(response.status, response.statusText, text) } };
		}
	} finally {
		await psyche.revokeKey(made.id).catch(() => {});
	}
	const ms = Date.now() - started;
	if (status < 200 || status >= 300) {
		const said = answer.error?.message ?? `the gateway answered ${status}`;
		throw new CliFailure(codeForStatus(status, answer.error?.code ?? null), `${model} through ${ref}'s gateway: ${said}`, {
			model,
			status,
			gatewayCode: answer.error?.code ?? null
		});
	}
	const reply = answer.choices?.[0]?.message?.content ?? '';
	emit({ ref, model, reply, usage: answer.usage ?? null, ms }, () => {
		process.stdout.write(`${reply}\n`);
		say(dim(`${model}, ${ms} ms, ${answer.usage?.prompt_tokens ?? '?'} tokens in, ${answer.usage?.completion_tokens ?? '?'} out, through ${state.ai.endpoint}`));
	});
	return 0;
}
