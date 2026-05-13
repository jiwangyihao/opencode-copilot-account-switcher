import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { parseStore, type StoreFile } from "./store.js";
import {
	commonSettingsPath as defaultCommonSettingsPath,
	legacyCopilotStorePath,
} from "./store-paths.js";

export type CommonSettingsStore = {
	networkRetryEnabled?: boolean;
	experimentalSlashCommandsEnabled?: boolean;
	experimentalStatusSlashCommandEnabled?: boolean;
};

export function normalizeCommonSettingsStore(
	input: CommonSettingsStore | undefined,
): CommonSettingsStore {
	const source = input ?? {};
	const legacySlashCommandsEnabled =
		source.experimentalStatusSlashCommandEnabled;
	return {
		...(source.networkRetryEnabled === true
			? { networkRetryEnabled: true }
			: { networkRetryEnabled: false }),
		experimentalSlashCommandsEnabled:
			source.experimentalSlashCommandsEnabled === true ||
			source.experimentalSlashCommandsEnabled === false
				? source.experimentalSlashCommandsEnabled
				: legacySlashCommandsEnabled !== false,
	};
}

function parsePartialCommonSettingsStore(raw: string): CommonSettingsStore {
	const parsed = raw ? (JSON.parse(raw) as CommonSettingsStore) : {};
	const partial: CommonSettingsStore = {};

	if (
		parsed.networkRetryEnabled === true ||
		parsed.networkRetryEnabled === false
	) {
		partial.networkRetryEnabled = parsed.networkRetryEnabled;
	}
	if (
		parsed.experimentalSlashCommandsEnabled === true ||
		parsed.experimentalSlashCommandsEnabled === false
	) {
		partial.experimentalSlashCommandsEnabled =
			parsed.experimentalSlashCommandsEnabled;
	}
	if (
		parsed.experimentalStatusSlashCommandEnabled === true ||
		parsed.experimentalStatusSlashCommandEnabled === false
	) {
		partial.experimentalStatusSlashCommandEnabled =
			parsed.experimentalStatusSlashCommandEnabled;
	}

	return partial;
}

function readLegacyCommonSettings(
	store: StoreFile | undefined,
): CommonSettingsStore {
	if (!store) return {};
	return normalizeCommonSettingsStore({
		networkRetryEnabled: store.networkRetryEnabled,
		experimentalSlashCommandsEnabled: store.experimentalSlashCommandsEnabled,
		experimentalStatusSlashCommandEnabled:
			store.experimentalStatusSlashCommandEnabled,
	});
}

function mergeCommonSettings(
	current: CommonSettingsStore,
	legacy: CommonSettingsStore,
) {
	return normalizeCommonSettingsStore({
		networkRetryEnabled:
			current.networkRetryEnabled ?? legacy.networkRetryEnabled,
		experimentalSlashCommandsEnabled:
			current.experimentalSlashCommandsEnabled ??
			legacy.experimentalSlashCommandsEnabled,
		experimentalStatusSlashCommandEnabled:
			current.experimentalStatusSlashCommandEnabled ??
			legacy.experimentalStatusSlashCommandEnabled,
	});
}

export function parseCommonSettingsStore(raw: string): CommonSettingsStore {
	return normalizeCommonSettingsStore(parsePartialCommonSettingsStore(raw));
}

export function commonSettingsPath() {
	return defaultCommonSettingsPath();
}

export async function readCommonSettingsStore(options?: {
	filePath?: string;
	legacyCopilotFilePath?: string;
}): Promise<CommonSettingsStore> {
	const file = options?.filePath ?? commonSettingsPath();
	const raw = await fs
		.readFile(file, "utf8")
		.catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return "";
			throw error;
		});
	const current = parsePartialCommonSettingsStore(raw);

	const legacyFile = options?.legacyCopilotFilePath ?? legacyCopilotStorePath();
	const legacyRaw = await fs
		.readFile(legacyFile, "utf8")
		.catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return "";
			throw error;
		});

	if (!legacyRaw) return normalizeCommonSettingsStore(current);
	const legacy = readLegacyCommonSettings(parseStore(legacyRaw));
	return mergeCommonSettings(current, legacy);
}

export function readCommonSettingsStoreSync(options?: {
	filePath?: string;
	legacyCopilotFilePath?: string;
}): CommonSettingsStore | undefined {
	const file = options?.filePath ?? commonSettingsPath();
	let current = "";
	try {
		current = readFileSync(file, "utf8");
	} catch (error) {
		const issue = error as NodeJS.ErrnoException;
		if (issue.code !== "ENOENT") return undefined;
	}

	const legacyFile = options?.legacyCopilotFilePath ?? legacyCopilotStorePath();
	let legacyRaw = "";
	try {
		legacyRaw = readFileSync(legacyFile, "utf8");
	} catch (error) {
		const issue = error as NodeJS.ErrnoException;
		if (issue.code !== "ENOENT") return undefined;
	}

	const partial = parsePartialCommonSettingsStore(current);
	if (!legacyRaw) return normalizeCommonSettingsStore(partial);
	return mergeCommonSettings(
		partial,
		readLegacyCommonSettings(parseStore(legacyRaw)),
	);
}

export async function writeCommonSettingsStore(
	store: CommonSettingsStore,
	options?: {
		filePath?: string;
	},
) {
	const file = options?.filePath ?? commonSettingsPath();
	const normalized = normalizeCommonSettingsStore(store);
	const persisted: CommonSettingsStore = {
		networkRetryEnabled: normalized.networkRetryEnabled,
		experimentalSlashCommandsEnabled:
			normalized.experimentalSlashCommandsEnabled,
	};

	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, JSON.stringify(persisted, null, 2), { mode: 0o600 });
}
