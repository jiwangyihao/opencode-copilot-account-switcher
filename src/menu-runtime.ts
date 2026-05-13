type WriteMeta = {
	reason: string;
	source: string;
	actionType?: string;
};

export type ProviderActionResult =
	| boolean
	| {
			handled: boolean;
			persistHandled?: boolean;
			result?: unknown;
	  };

export type ProviderActionOutput = {
	name: string;
	payload?: unknown;
	result: unknown;
};

export type MenuAccountInfo = {
	id?: string;
	name: string;
	workspaceName?: string;
	index: number;
	isCurrent?: boolean;
};

export type MenuActionAccount = {
	id?: string;
	name: string;
};

type SharedActionResult =
	| boolean
	| { changed: boolean; persistHandled?: boolean };

function parseSharedActionResult(result: SharedActionResult | undefined) {
	if (typeof result === "object" && result) {
		return {
			changed: result.changed === true,
			persistHandled: result.persistHandled === true,
		};
	}
	return {
		changed: result === true,
		persistHandled: false,
	};
}

function providerActionReason(name: string) {
	return `provider-action:${name}`;
}

export type MenuAction =
	| { type: "add" }
	| { type: "cancel" }
	| { type: "remove"; account: MenuActionAccount }
	| { type: "remove-all" }
	| { type: "switch"; account: MenuActionAccount }
	| { type: "provider"; name: string; payload?: unknown };

export type ProviderMenuAdapter<TStore, TEntry> = {
	key: string;
	loadStore: () => Promise<TStore>;
	writeStore: (store: TStore, meta: WriteMeta) => Promise<void>;
	bootstrapAuthImport: (store: TStore) => Promise<boolean>;
	authorizeNewAccount: (store: TStore) => Promise<TEntry | undefined>;
	refreshSnapshots: (store: TStore) => Promise<void>;
	toMenuInfo: (store: TStore) => Promise<MenuAccountInfo[]>;
	getCurrentEntry: (store: TStore) => TEntry | undefined;
	getRefreshConfig: (store: TStore) => { enabled: boolean; minutes: number };
	getAccountByName: (
		store: TStore,
		name: string,
	) => { name: string; entry: TEntry } | undefined;
	addAccount?: (
		store: TStore,
		entry: TEntry,
	) => Promise<SharedActionResult> | SharedActionResult;
	removeAccount?: (
		store: TStore,
		name: string,
	) => Promise<SharedActionResult> | SharedActionResult;
	removeAllAccounts?: (
		store: TStore,
	) => Promise<SharedActionResult> | SharedActionResult;
	switchAccount: (
		store: TStore,
		name: string,
		entry: TEntry,
	) => Promise<{ persistHandled?: boolean } | undefined>;
	applyAction?: (
		store: TStore,
		action: Extract<MenuAction, { type: "provider" }>,
	) => Promise<ProviderActionResult>;
};

export async function runProviderMenu<TStore, TEntry>(input: {
	adapter: ProviderMenuAdapter<TStore, TEntry>;
	showMenu: (accounts: MenuAccountInfo[], store: TStore) => Promise<MenuAction>;
	onProviderActionResult?: (
		output: ProviderActionOutput,
	) => Promise<void> | void;
	now?: () => number;
}): Promise<TEntry | undefined> {
	const now = input.now ?? Date.now;
	const store = await input.adapter.loadStore();

	if (await input.adapter.bootstrapAuthImport(store)) {
		await input.adapter.writeStore(store, {
			reason: "bootstrap-auth-import",
			source: "menu-runtime",
			actionType: "bootstrap-auth-import",
		});
	}

	let nextRefreshAt = 0;

	while (true) {
		const refresh = input.adapter.getRefreshConfig(store);
		if (refresh.enabled && now() >= nextRefreshAt) {
			await input.adapter.refreshSnapshots(store);
			await input.adapter.writeStore(store, {
				reason: "auto-refresh",
				source: "menu-runtime",
				actionType: "auto-refresh",
			});
			nextRefreshAt = now() + refresh.minutes * 60_000;
		}

		const accounts = await input.adapter.toMenuInfo(store);
		const action = await input.showMenu(accounts, store);

		if (action.type === "cancel") return input.adapter.getCurrentEntry(store);

		if (action.type === "add") {
			const entry = await input.adapter.authorizeNewAccount(store);
			const result = !entry
				? undefined
				: await input.adapter.addAccount?.(store, entry);
			const parsed = parseSharedActionResult(result);
			if (!entry || !parsed.changed) continue;
			if (!parsed.persistHandled) {
				await input.adapter.writeStore(store, {
					reason: "add-account",
					source: "menu-runtime",
					actionType: "add",
				});
			}
			continue;
		}

		if (action.type === "remove-all") {
			const result = await input.adapter.removeAllAccounts?.(store);
			const parsed = parseSharedActionResult(result);
			if (!parsed.changed) continue;
			if (!parsed.persistHandled) {
				await input.adapter.writeStore(store, {
					reason: "remove-all",
					source: "menu-runtime",
					actionType: "remove-all",
				});
			}
			continue;
		}

		if (action.type === "remove") {
			const accountName = action.account.id ?? action.account.name;
			const result = await input.adapter.removeAccount?.(store, accountName);
			const parsed = parseSharedActionResult(result);
			if (!parsed.changed) continue;
			if (!parsed.persistHandled) {
				await input.adapter.writeStore(store, {
					reason: "remove-account",
					source: "menu-runtime",
					actionType: "remove",
				});
			}
			continue;
		}

		if (action.type === "switch") {
			const accountName = action.account.id ?? action.account.name;
			const selected = input.adapter.getAccountByName(store, accountName);
			if (!selected) continue;
			const switchResult = await input.adapter.switchAccount(
				store,
				selected.name,
				selected.entry,
			);
			if (!switchResult?.persistHandled) {
				await input.adapter.writeStore(store, {
					reason: "persist-account-switch",
					source: "menu-runtime",
					actionType: "switch",
				});
			}
			continue;
		}

		if (!input.adapter.applyAction) continue;
		const providerActionResult = parseProviderActionResult(
			await input.adapter.applyAction(store, action),
		);
		if (!providerActionResult.handled) continue;
		if (providerActionResult.result !== undefined) {
			await input.onProviderActionResult?.({
				name: action.name,
				payload: action.payload,
				result: providerActionResult.result,
			});
		}
		if (providerActionResult.persistHandled) continue;
		await input.adapter.writeStore(store, {
			reason: providerActionReason(action.name),
			source: "menu-runtime",
			actionType: action.name,
		});
	}
}

function parseProviderActionResult(result: ProviderActionResult | undefined) {
	if (typeof result === "object" && result) {
		return {
			handled: result.handled === true,
			persistHandled: result.persistHandled === true,
			result: result.result,
		};
	}

	return {
		handled: result === true,
		persistHandled: false,
		result: undefined,
	};
}
