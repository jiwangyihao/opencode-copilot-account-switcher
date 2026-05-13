import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { fetchQuota } from "../active-account-quota.js";
import {
	type CommonSettingsStore,
	readCommonSettingsStore,
	writeCommonSettingsStore,
} from "../common-settings-store.js";
import { getGitHubToken, normalizeDomain } from "../copilot-api-helpers.js";
import type { MenuAccountInfo, ProviderMenuAdapter } from "../menu-runtime.js";
import {
	listAssignableAccountsForModel,
	listKnownCopilotModels,
	rewriteModelAccountAssignments,
} from "../model-account-map.js";
import { applyMenuAction, persistAccountSwitch } from "../plugin-actions.js";
import {
	type AccountEntry,
	authPath,
	readAuth,
	readStore,
	type StoreFile,
	type StoreWriteDebugMeta,
} from "../store.js";
import type { AccountInfo } from "../ui/menu.js";
import { select, selectMany } from "../ui/select.js";

const CLIENT_ID = "Ov23li8tweQw6odWQebz";
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000;

type AuthClient = {
	auth: {
		set: (input: {
			path: { id: string };
			body: {
				type: "oauth";
				refresh: string;
				access: string;
				expires: number;
				enterpriseUrl?: string;
			};
		}) => Promise<unknown>;
	};
	tui?: {
		showToast?: (options: {
			body: { message: string; variant: "success" | "warning" };
		}) => Promise<unknown>;
	};
};

type DebugMeta = StoreWriteDebugMeta;

type AdapterDependencies = {
	client: AuthClient;
	readStore?: () => Promise<StoreFile>;
	writeStore?: (store: StoreFile, meta?: DebugMeta) => Promise<void>;
	readAuth?: (filePath?: string) => Promise<Record<string, AccountEntry>>;
	authorizeNewAccount?: (store: StoreFile) => Promise<AccountEntry | undefined>;
	now?: () => number;
	fetchUser?: (
		entry: AccountEntry,
	) => Promise<{ login?: string; email?: string; orgs?: string[] } | undefined>;
	fetchModels?: (entry: AccountEntry) => Promise<AccountEntry["models"]>;
	fetchQuota?: (entry: AccountEntry) => Promise<AccountEntry["quota"]>;
	configureDefaultAccountGroup?: (
		store: StoreFile,
		selectors?: {
			selectAccounts?: (
				options: Array<{ label: string; value: string; hint?: string }>,
			) => Promise<string[] | null>;
		},
	) => Promise<boolean>;
	configureModelAccountAssignments?: (
		store: StoreFile,
		selectors?: {
			selectModel?: (
				options: Array<{ label: string; value: string; hint?: string }>,
			) => Promise<string | null>;
			selectAccounts?: (
				options: Array<{ label: string; value: string; hint?: string }>,
			) => Promise<string[] | null>;
		},
	) => Promise<boolean>;
	clearAllAccounts?: (store: StoreFile) => void;
	removeAccountFromStore?: (store: StoreFile, name: string) => void;
	activateAddedAccount?: (input: {
		store: StoreFile;
		name: string;
		switchAccount: () => Promise<void>;
		writeStore: (store: StoreFile, meta?: StoreWriteDebugMeta) => Promise<void>;
		now?: () => number;
	}) => Promise<void>;
	logSwitchHint?: () => void;
	readCommonSettings?: () => Promise<CommonSettingsStore>;
	writeCommonSettings?: (
		settings: CommonSettingsStore,
		meta?: DebugMeta,
	) => Promise<void>;
};

function getUrls(domain: string) {
	return {
		DEVICE_CODE_URL: `https://${domain}/login/device/code`,
		ACCESS_TOKEN_URL: `https://${domain}/login/oauth/access_token`,
	};
}

async function sleep(ms: number) {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

function buildName(entry: AccountEntry, login?: string) {
	const user = login ?? entry.user;
	if (!user) return entry.name;
	if (!entry.enterpriseUrl) return user;
	const host = normalizeDomain(entry.enterpriseUrl);
	return `${host}:${user}`;
}

function score(entry: AccountEntry) {
	return (
		(entry.user ? 2 : 0) + (entry.email ? 2 : 0) + (entry.orgs?.length ? 1 : 0)
	);
}

function key(entry: AccountEntry) {
	if (entry.refresh) return `refresh:${entry.refresh}`;
	return undefined;
}

function dedupe(store: StoreFile) {
	const seen = new Map<string, string>();
	for (const [name, entry] of Object.entries(store.accounts)) {
		const k = key(entry);
		if (!k) continue;
		const current = seen.get(k);
		if (!current) {
			seen.set(k, name);
			continue;
		}
		const currentEntry = store.accounts[current];
		if (score(entry) > score(currentEntry)) {
			rewriteModelAccountAssignments(store, { [current]: name });
			delete store.accounts[current];
			seen.set(k, name);
			if (store.active === current) store.active = name;
			continue;
		}
		rewriteModelAccountAssignments(store, { [name]: current });
		delete store.accounts[name];
		if (store.active === name) store.active = current;
	}
}

function mergeAuth(store: StoreFile, imported: Array<[string, AccountEntry]>) {
	dedupe(store);
	const byRefresh = new Map<string, string>();
	for (const [name, entry] of Object.entries(store.accounts)) {
		if (entry.refresh) byRefresh.set(entry.refresh, name);
	}
	for (const [providerKey, entry] of imported) {
		const match = byRefresh.get(entry.refresh);
		if (match) {
			store.accounts[match] = {
				...store.accounts[match],
				...entry,
				name: store.accounts[match].name,
				source: "auth",
				providerId: providerKey,
			};
			if (!store.active) store.active = match;
			continue;
		}
		const name = entry.name || `auth:${providerKey}`;
		store.accounts[name] = {
			...entry,
			name,
			source: "auth",
			providerId: providerKey,
		};
		if (!store.active) store.active = name;
	}
}

function renameAccounts(
	store: StoreFile,
	items: Array<{ oldName: string; base: string; entry: AccountEntry }>,
) {
	const counts = new Map<string, number>();
	const renamed = items.map((item) => {
		const count = (counts.get(item.base) ?? 0) + 1;
		counts.set(item.base, count);
		const name = count === 1 ? item.base : `${item.base}#${count}`;
		return { ...item, name, entry: { ...item.entry, name } };
	});
	store.accounts = renamed.reduce(
		(acc, item) => {
			acc[item.name] = item.entry;
			return acc;
		},
		{} as Record<string, AccountEntry>,
	);
	rewriteModelAccountAssignments(
		store,
		Object.fromEntries(renamed.map((item) => [item.oldName, item.name])),
	);
	const active = renamed.find((item) => item.oldName === store.active);
	if (active) store.active = active.name;
}

function toInfo(
	name: string,
	entry: AccountEntry,
	index: number,
	active?: string,
	now = Date.now,
): AccountInfo {
	const status =
		entry.expires && entry.expires > 0 && entry.expires < now()
			? "expired"
			: "active";
	const labelName = name.startsWith("github.com:")
		? name.slice("github.com:".length)
		: name;
	const hasUser = entry.user ? labelName.includes(entry.user) : false;
	const suffix = entry.user
		? hasUser
			? ""
			: ` (${entry.user})`
		: entry.email
			? ` (${entry.email})`
			: "";
	const label = `${labelName}${suffix}`;
	return {
		name: label,
		index,
		addedAt: entry.addedAt,
		lastUsed: entry.lastUsed,
		status,
		isCurrent: active === name,
	};
}

async function promptText(message: string): Promise<string> {
	const rl = createInterface({ input, output });
	try {
		const answer = await rl.question(message);
		return answer.trim();
	} finally {
		rl.close();
	}
}

async function promptAccountName(existing: string[]): Promise<string> {
	while (true) {
		const name = await promptText("Account name: ");
		if (!name) continue;
		if (!existing.includes(name)) return name;
		console.log(`Name already exists: ${name}`);
	}
}

async function promptAccountEntry(
	existing: string[],
	nowFn: () => number,
): Promise<{ name: string; entry: AccountEntry }> {
	const name = await promptAccountName(existing);
	const refresh = await promptText("OAuth refresh/access token: ");
	const access = await promptText(
		"Copilot access token (optional, press Enter to skip): ",
	);
	const expiresRaw = await promptText(
		"Access token expires (unix ms, optional): ",
	);
	const enterpriseUrl = await promptText("Enterprise URL (optional): ");
	const expires = Number(expiresRaw);
	const entry: AccountEntry = {
		name,
		refresh,
		access: access || refresh,
		expires: Number.isFinite(expires) ? expires : 0,
		enterpriseUrl: enterpriseUrl || undefined,
		addedAt: nowFn(),
		source: "manual",
	};
	return { name, entry };
}

async function promptFilePath(
	message: string,
	defaultValue: string,
): Promise<string> {
	const rl = createInterface({ input, output });
	try {
		const answer = await rl.question(`${message} (${defaultValue}): `);
		return answer.trim() || defaultValue;
	} finally {
		rl.close();
	}
}

async function loginOauth(
	deployment: "github.com" | "enterprise",
	nowFn: () => number,
	fetchUserFn: (
		entry: AccountEntry,
	) => Promise<{ login?: string; email?: string; orgs?: string[] } | undefined>,
	enterpriseUrl?: string,
): Promise<AccountEntry> {
	const domain =
		deployment === "enterprise"
			? normalizeDomain(enterpriseUrl ?? "")
			: "github.com";
	const urls = getUrls(domain);
	const deviceResponse = await fetch(urls.DEVICE_CODE_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			client_id: CLIENT_ID,
			scope: "read:user user:email",
		}),
	});

	if (!deviceResponse.ok)
		throw new Error("Failed to initiate device authorization");

	const deviceData = (await deviceResponse.json()) as {
		verification_uri: string;
		user_code: string;
		device_code: string;
		interval: number;
	};

	console.log(`Go to: ${deviceData.verification_uri}`);
	console.log(`Enter code: ${deviceData.user_code}`);

	while (true) {
		const response = await fetch(urls.ACCESS_TOKEN_URL, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				client_id: CLIENT_ID,
				device_code: deviceData.device_code,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			}),
		});

		if (!response.ok) throw new Error("Failed to poll token");

		const data = (await response.json()) as {
			access_token?: string;
			error?: string;
			interval?: number;
		};

		if (data.access_token) {
			const entry = {
				name:
					deployment === "enterprise" ? `enterprise:${domain}` : "github.com",
				refresh: data.access_token,
				access: data.access_token,
				expires: 0,
				enterpriseUrl: deployment === "enterprise" ? domain : undefined,
				addedAt: nowFn(),
				source: "auth",
			} as AccountEntry;
			const user = await fetchUserFn(entry);
			if (user?.login) entry.user = user.login;
			if (user?.email) entry.email = user.email;
			if (user?.orgs?.length) entry.orgs = user.orgs;
			return entry;
		}

		if (data.error === "authorization_pending") {
			await sleep(deviceData.interval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS);
			continue;
		}

		if (data.error === "slow_down") {
			const serverInterval = data.interval;
			const next =
				(serverInterval && serverInterval > 0
					? serverInterval
					: deviceData.interval + 5) * 1000;
			await sleep(next + OAUTH_POLLING_SAFETY_MARGIN_MS);
			continue;
		}

		throw new Error("Authorization failed");
	}
}

async function switchAccount(client: AuthClient, entry: AccountEntry) {
	const payload = {
		type: "oauth" as const,
		refresh: entry.refresh,
		access: entry.access,
		expires: entry.expires,
		...(entry.enterpriseUrl ? { enterpriseUrl: entry.enterpriseUrl } : {}),
	};
	await client.auth.set({
		path: {
			id: entry.enterpriseUrl ? "github-copilot-enterprise" : "github-copilot",
		},
		body: payload,
	});
}

function parseModels(modelData: {
	data?: Array<{
		id?: string;
		model_picker_enabled?: boolean;
		policy?: { state?: string };
	}>;
}): AccountEntry["models"] {
	const available: string[] = [];
	const disabled: string[] = [];
	for (const item of modelData.data ?? []) {
		if (!item.id) continue;
		const enabled =
			item.model_picker_enabled === true && item.policy?.state !== "disabled";
		if (enabled) available.push(item.id);
		else disabled.push(item.id);
	}
	return { available, disabled, updatedAt: Date.now() };
}

async function fetchModelsDefault(
	entry: AccountEntry,
): Promise<AccountEntry["models"]> {
	try {
		const headers = {
			Accept: "application/json",
			Authorization: `Bearer ${entry.access}`,
			"User-Agent": "GitHubCopilotChat/0.26.7",
			"Editor-Version": "vscode/1.96.2",
			"Editor-Plugin-Version": "copilot/1.159.0",
			"Copilot-Integration-Id": "vscode-chat",
			"X-Github-Api-Version": "2025-04-01",
		};
		const modelsUrl = entry.enterpriseUrl
			? `https://copilot-api.${normalizeDomain(entry.enterpriseUrl)}/models`
			: "https://api.githubcopilot.com/models";
		const modelRes = await fetch(modelsUrl, { headers });
		if (!modelRes.ok) {
			const base = entry.enterpriseUrl
				? `https://api.${normalizeDomain(entry.enterpriseUrl)}`
				: "https://api.github.com";
			const tokenRes = await fetch(`${base}/copilot_internal/v2/token`, {
				headers: {
					Accept: "application/json",
					Authorization: `token ${getGitHubToken(entry)}`,
					"User-Agent": "GitHubCopilotChat/0.26.7",
					"Editor-Version": "vscode/1.96.2",
					"Editor-Plugin-Version": "copilot/1.159.0",
					"X-Github-Api-Version": "2025-04-01",
				},
			});
			if (!tokenRes.ok)
				return {
					available: [],
					disabled: [],
					error: `token ${tokenRes.status}`,
				};
			const tokenData = (await tokenRes.json()) as {
				token?: string;
				expires_at?: number;
			};
			if (!tokenData.token)
				return { available: [], disabled: [], error: "token missing" };

			entry.access = tokenData.token;
			if (tokenData.expires_at) entry.expires = tokenData.expires_at * 1000;

			const fallbackRes = await fetch(modelsUrl, {
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${tokenData.token}`,
					"User-Agent": "GitHubCopilotChat/0.26.7",
					"Editor-Version": "vscode/1.96.2",
					"Editor-Plugin-Version": "copilot/1.159.0",
					"Copilot-Integration-Id": "vscode-chat",
					"X-Github-Api-Version": "2025-04-01",
				},
			});
			if (!fallbackRes.ok)
				return {
					available: [],
					disabled: [],
					error: `models ${fallbackRes.status}`,
				};
			return parseModels(
				(await fallbackRes.json()) as {
					data?: Array<{
						id?: string;
						model_picker_enabled?: boolean;
						policy?: { state?: string };
					}>;
				},
			);
		}
		return parseModels(
			(await modelRes.json()) as {
				data?: Array<{
					id?: string;
					model_picker_enabled?: boolean;
					policy?: { state?: string };
				}>;
			},
		);
	} catch (error) {
		return {
			available: [],
			disabled: [],
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function fetchUserDefault(
	entry: AccountEntry,
): Promise<{ login?: string; email?: string; orgs?: string[] } | undefined> {
	try {
		const base = entry.enterpriseUrl
			? `https://api.${normalizeDomain(entry.enterpriseUrl)}`
			: "https://api.github.com";
		const headers = {
			Accept: "application/json",
			Authorization: `token ${getGitHubToken(entry)}`,
			"User-Agent": "GitHubCopilotChat/0.26.7",
		};
		const userRes = await fetch(`${base}/user`, { headers });
		if (!userRes.ok) return undefined;
		const user = (await userRes.json()) as { login?: string; email?: string };
		let email = user.email;
		if (!email) {
			const emailRes = await fetch(`${base}/user/emails`, { headers });
			if (emailRes.ok) {
				const items = (await emailRes.json()) as Array<{
					email?: string;
					primary?: boolean;
					verified?: boolean;
				}>;
				const primary = items.find((item) => item.primary && item.verified);
				email = primary?.email ?? items[0]?.email;
			}
		}
		const orgRes = await fetch(`${base}/user/orgs`, { headers });
		const orgs = orgRes.ok
			? (((await orgRes.json()) as Array<{ login?: string }>)
					.map((o) => o.login)
					.filter(Boolean) as string[])
			: undefined;
		return { login: user.login, email, orgs };
	} catch {
		return undefined;
	}
}

async function refreshIdentity(
	store: StoreFile,
	fetchUserFn: (
		entry: AccountEntry,
	) => Promise<{ login?: string; email?: string; orgs?: string[] } | undefined>,
) {
	const items = await Promise.all(
		Object.entries(store.accounts).map(async ([name, entry]) => {
			const user = await fetchUserFn(entry);
			const base = buildName(entry, user?.login ?? entry.user);
			return {
				oldName: name,
				base,
				entry: {
					...entry,
					user: user?.login ?? entry.user,
					email: user?.email ?? entry.email,
					orgs: user?.orgs ?? entry.orgs,
					name: base,
				},
			};
		}),
	);
	renameAccounts(store, items);
}

export function createCopilotMenuAdapter(
	inputDeps: AdapterDependencies,
): ProviderMenuAdapter<StoreFile, AccountEntry> {
	const now = inputDeps.now ?? Date.now;
	const loadStore = inputDeps.readStore ?? readStore;
	const persistStore =
		inputDeps.writeStore ??
		(async (store, meta) => {
			const { writeStore } = await import("../store.js");
			await writeStore(store, { debug: meta });
		});
	const loadAuth = inputDeps.readAuth ?? readAuth;
	const fetchUserFn = inputDeps.fetchUser ?? fetchUserDefault;
	const fetchModelsFn = inputDeps.fetchModels ?? fetchModelsDefault;
	const fetchQuotaFn = inputDeps.fetchQuota ?? fetchQuota;
	const readCommonSettings =
		inputDeps.readCommonSettings ?? readCommonSettingsStore;
	const writeCommonSettings =
		inputDeps.writeCommonSettings ?? writeCommonSettingsStore;
	let nextAutoRefreshAt = 0;

	async function maybeAutoRefresh(store: StoreFile) {
		if (store.autoRefresh !== true || now() < nextAutoRefreshAt) return;
		const updated = await Promise.all(
			Object.entries(store.accounts).map(async ([name, entry]) => ({
				name,
				entry: {
					...entry,
					quota: await fetchQuotaFn(entry),
				},
			})),
		);
		for (const item of updated) {
			store.accounts[item.name] = item.entry;
		}
		store.lastQuotaRefresh = now();
		await persistStore(store, {
			reason: "auto-refresh",
			source: "plugin.runMenu",
			actionType: "toggle-refresh",
		});
		nextAutoRefreshAt = now() + (store.refreshMinutes ?? 15) * 60_000;
	}

	return {
		key: "copilot",
		loadStore,
		writeStore: persistStore,
		bootstrapAuthImport: async (store) => {
			const auth = await loadAuth().catch(() => ({}));
			const imported = Object.entries(auth).filter(
				([providerKey]) =>
					providerKey === "github-copilot" ||
					providerKey === "github-copilot-enterprise",
			);
			if (imported.length > 0) {
				mergeAuth(store, imported);
				const preferred =
					imported.find(([providerKey]) => providerKey === "github-copilot") ??
					imported[0];
				if (!store.active) store.active = preferred?.[1].name;
			}

			if (
				Object.keys(store.accounts).length > 0 &&
				!Object.values(store.accounts).some(
					(entry) =>
						entry.user || entry.email || (entry.orgs && entry.orgs.length > 0),
				)
			) {
				await refreshIdentity(store, fetchUserFn);
				dedupe(store);
				await persistStore(store, {
					reason: "refresh-identity-bootstrap",
					source: "plugin.runMenu",
				});
			}

			return false;
		},
		authorizeNewAccount: async (store: StoreFile) => {
			if (inputDeps.authorizeNewAccount) {
				return inputDeps.authorizeNewAccount(store);
			}

			const mode = await promptText("Add via device login? (y/n): ");
			const useDevice =
				mode.toLowerCase() === "y" || mode.toLowerCase() === "yes";
			if (useDevice) {
				const dep = await promptText("Enterprise? (y/n): ");
				const isEnterprise =
					dep.toLowerCase() === "y" || dep.toLowerCase() === "yes";
				const domain = isEnterprise
					? await promptText("Enterprise URL or domain: ")
					: undefined;
				const entry = await loginOauth(
					isEnterprise ? "enterprise" : "github.com",
					now,
					fetchUserFn,
					domain,
				);
				const user = await fetchUserFn(entry);
				if (user?.login) entry.user = user.login;
				if (user?.email) entry.email = user.email;
				if (user?.orgs?.length) entry.orgs = user.orgs;
				entry.name = buildName(entry, user?.login);
				return entry;
			}

			const manual = await promptAccountEntry(Object.keys(store.accounts), now);
			const user = await fetchUserFn(manual.entry);
			if (user?.login) manual.entry.user = user.login;
			if (user?.email) manual.entry.email = user.email;
			if (user?.orgs?.length) manual.entry.orgs = user.orgs;
			manual.entry.name = buildName(manual.entry, user?.login);
			return manual.entry;
		},
		refreshSnapshots: async () => {},
		toMenuInfo: async (store) => {
			await maybeAutoRefresh(store);
			const entries = Object.entries(store.accounts);
			const refreshed = await Promise.all(
				entries.map(async ([name, entry]) => {
					if (
						entry.user ||
						entry.email ||
						(entry.orgs && entry.orgs.length > 0)
					)
						return { name, entry };
					const user = await fetchUserFn(entry);
					return {
						name,
						entry: {
							...entry,
							user: user?.login ?? entry.user,
							email: user?.email ?? entry.email,
							orgs: user?.orgs ?? entry.orgs,
						},
					};
				}),
			);
			for (const item of refreshed) {
				store.accounts[item.name] = item.entry;
			}
			return Object.entries(store.accounts).map(([name, entry], index) => ({
				id: name,
				...toInfo(name, entry, index, store.active, now),
				source: entry.source,
				orgs: entry.orgs,
				plan: entry.quota?.plan,
				sku: entry.quota?.sku,
				reset: entry.quota?.reset,
				models: entry.models
					? {
							enabled: entry.models.available.length,
							disabled: entry.models.disabled.length,
						}
					: undefined,
				modelsError: entry.models?.error,
				modelList: entry.models
					? {
							available: entry.models.available,
							disabled: entry.models.disabled,
						}
					: undefined,
				quota: entry.quota?.snapshots
					? {
							premium: entry.quota.snapshots.premium,
							chat: entry.quota.snapshots.chat,
							completions: entry.quota.snapshots.completions,
						}
					: undefined,
			})) as MenuAccountInfo[];
		},
		getCurrentEntry: (store) =>
			store.active ? store.accounts[store.active] : undefined,
		getRefreshConfig: () => ({ enabled: false, minutes: 15 }),
		getAccountByName: (store, name) => {
			const entry = store.accounts[name];
			if (!entry) return undefined;
			return { name, entry };
		},
		addAccount: async (store, entry) => {
			store.accounts[entry.name] = entry;
			store.active = store.active ?? entry.name;

			if (store.active === entry.name) {
				if (inputDeps.activateAddedAccount) {
					await inputDeps.activateAddedAccount({
						store,
						name: entry.name,
						switchAccount: () => switchAccount(inputDeps.client, entry),
						writeStore: persistStore,
						now,
					});
				} else {
					await switchAccount(inputDeps.client, entry);
					await persistAccountSwitch({
						store,
						name: entry.name,
						at: now(),
						writeStore: persistStore,
					});
				}
				return { changed: true, persistHandled: true };
			}

			await persistStore(store, {
				reason: "add-account",
				source: "plugin.runMenu",
				actionType: "add",
			});
			return { changed: true, persistHandled: true };
		},
		removeAccount: async (store, name) => {
			if (!store.accounts[name]) return false;
			if (inputDeps.removeAccountFromStore) {
				inputDeps.removeAccountFromStore(store, name);
			} else {
				delete store.accounts[name];
			}
			await persistStore(store, {
				reason: "remove-account",
				source: "plugin.runMenu",
				actionType: "remove",
			});
			return { changed: true, persistHandled: true };
		},
		removeAllAccounts: async (store) => {
			if (Object.keys(store.accounts).length === 0) return false;
			if (inputDeps.clearAllAccounts) {
				inputDeps.clearAllAccounts(store);
			} else {
				store.accounts = {};
				store.active = undefined;
			}
			await persistStore(store, {
				reason: "remove-all",
				source: "plugin.runMenu",
				actionType: "remove-all",
			});
			return { changed: true, persistHandled: true };
		},
		switchAccount: async (store, name, entry) => {
			await switchAccount(inputDeps.client, entry);
			await persistAccountSwitch({
				store,
				name,
				at: now(),
				writeStore: persistStore,
			});
			inputDeps.logSwitchHint?.();
			return { persistHandled: true };
		},
		applyAction: async (store, action) => {
			if (action.name === "import-auth") {
				const file = await promptFilePath("auth.json path", authPath());
				const auth = await loadAuth(file).catch(() => ({}));
				const imported = Object.entries(auth).filter(
					([providerKey]) =>
						providerKey === "github-copilot" ||
						providerKey === "github-copilot-enterprise",
				);
				for (const [_providerKey, entry] of imported) {
					const user = await fetchUserFn(entry);
					if (user?.login) entry.user = user.login;
					if (user?.email) entry.email = user.email;
					if (user?.orgs?.length) entry.orgs = user.orgs;
					entry.name = buildName(entry, user?.login);
				}
				mergeAuth(store, imported);
				await persistStore(store, {
					reason: "import-auth",
					source: "plugin.runMenu",
					actionType: "import",
				});
				return false;
			}

			if (action.name === "refresh-identity") {
				await refreshIdentity(store, fetchUserFn);
				dedupe(store);
				await persistStore(store, {
					reason: "refresh-identity",
					source: "plugin.runMenu",
					actionType: "refresh-identity",
				});
				return false;
			}

			if (action.name === "toggle-refresh") {
				store.autoRefresh = !store.autoRefresh;
				store.refreshMinutes = store.refreshMinutes ?? 15;
				await persistStore(store, {
					reason: "toggle-refresh",
					source: "plugin.runMenu",
					actionType: "toggle-refresh",
				});
				return false;
			}

			if (action.name === "set-interval") {
				const value = await promptText("Refresh interval (minutes): ");
				const minutes = Math.max(1, Math.min(180, Number(value)));
				if (Number.isFinite(minutes)) store.refreshMinutes = minutes;
				await persistStore(store, {
					reason: "set-interval",
					source: "plugin.runMenu",
					actionType: "set-interval",
				});
				return false;
			}

			if (action.name === "quota-refresh") {
				const entries = Object.entries(store.accounts);
				const updated = await Promise.all(
					entries.map(async ([name, entry]) => ({
						name,
						entry: {
							...entry,
							quota: await fetchQuotaFn(entry),
						},
					})),
				);
				for (const item of updated) {
					store.accounts[item.name] = item.entry;
				}
				store.lastQuotaRefresh = now();
				await persistStore(store, {
					reason: "quota-refresh",
					source: "plugin.runMenu",
					actionType: "quota",
				});
				return false;
			}

			if (action.name === "check-models") {
				const entries = Object.entries(store.accounts);
				const updated = await Promise.all(
					entries.map(async ([name, entry]) => ({
						name,
						entry: {
							...entry,
							models: await fetchModelsFn(entry),
						},
					})),
				);
				for (const item of updated) {
					store.accounts[item.name] = item.entry;
				}
				await persistStore(store, {
					reason: "check-models",
					source: "plugin.runMenu",
					actionType: "check-models",
				});
				return false;
			}

			if (action.name === "configure-default-group") {
				if (!inputDeps.configureDefaultAccountGroup) return false;
				const changed = await inputDeps.configureDefaultAccountGroup(store);
				if (!changed) return false;
				await persistStore(store, {
					reason: "configure-default-account-group",
					source: "plugin.runMenu",
					actionType: "configure-default-account-group",
				});
				return false;
			}

			if (action.name === "assign-models") {
				if (!inputDeps.configureModelAccountAssignments) return false;
				const changed = await inputDeps.configureModelAccountAssignments(store);
				if (!changed) return false;
				await persistStore(store, {
					reason: "assign-model-account",
					source: "plugin.runMenu",
					actionType: "assign-model-account",
				});
				return false;
			}

			if (
				action.name === "toggle-experimental-slash-commands" ||
				action.name === "toggle-network-retry" ||
				action.name === "toggle-synthetic-agent-initiator"
			) {
				await applyMenuAction({
					action: { type: action.name },
					store,
					writeStore: persistStore,
					readCommonSettings,
					writeCommonSettings,
				} as never);
				return false;
			}

			if (action.name === "list-models") {
				const modelID = await select(
					[
						{ label: "Back", value: "" },
						...listKnownCopilotModels(store).map((name) => ({
							label: name,
							value: name,
						})),
					],
					{
						message: "Choose a Copilot model",
						subtitle: "Inspect current assignment candidates",
						clearScreen: true,
						autoSelectSingle: false,
					},
				);
				if (!modelID) return false;
				const options = listAssignableAccountsForModel(store, modelID);
				await selectMany(
					options.map((item) => ({
						label: item.name,
						value: item.name,
						hint: item.entry.enterpriseUrl
							? normalizeDomain(item.entry.enterpriseUrl)
							: "github.com",
					})),
					{
						message: modelID,
						subtitle: "Inspect accounts exposing this model",
						clearScreen: true,
						autoSelectSingle: false,
						minSelected: 0,
					},
				);
				return false;
			}

			return false;
		},
	};
}
