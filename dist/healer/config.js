import { relaywrightHome } from '../config/paths.js';
import { readGlobalConfig, updateGlobalConfig } from '../privacy/store.js';
const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY';
export function readHealConfig(root = relaywrightHome()) {
    const stored = readGlobalConfig(root).heal ?? {};
    return {
        base_url: normalizeBaseUrl(stored.base_url || DEFAULT_BASE_URL),
        model: stored.model?.trim() || DEFAULT_MODEL,
        api_key_env: stored.api_key_env?.trim() || DEFAULT_API_KEY_ENV,
    };
}
export function writeHealConfig(update, root = relaywrightHome()) {
    if (update.base_url !== undefined)
        assertBaseUrl(update.base_url);
    if (update.model !== undefined && !update.model.trim())
        throw new Error('model must not be empty');
    if (update.api_key_env !== undefined)
        assertEnvName(update.api_key_env);
    updateGlobalConfig((config) => {
        const current = config.heal ?? {};
        config.heal = {
            ...current,
            ...(update.base_url !== undefined ? { base_url: normalizeBaseUrl(update.base_url) } : {}),
            ...(update.model !== undefined ? { model: update.model.trim() } : {}),
            ...(update.api_key_env !== undefined ? { api_key_env: update.api_key_env.trim() } : {}),
        };
    }, root);
    return readHealConfig(root);
}
export function healKeySet(config, env = process.env) {
    return Boolean(env[config.api_key_env]?.trim());
}
export function missingKeyHint(envName) {
    return `No ${envName} set. Set it, or run: relaywright heal config`;
}
export function formatHealConfig(config, env = process.env) {
    return [`base_url: ${config.base_url}`, `model: ${config.model}`, `api_key_env: ${config.api_key_env}`, `api_key: ${healKeySet(config, env) ? 'set' : 'missing'}`].join('\n');
}
function normalizeBaseUrl(value) {
    return value.trim().replace(/\/+$/, '');
}
function assertBaseUrl(value) {
    let url;
    try {
        url = new URL(value.trim());
    }
    catch {
        throw new Error(`Invalid heal base_url: ${value}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`heal base_url must be http or https, got ${url.protocol}`);
    }
}
function assertEnvName(value) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.trim())) {
        throw new Error(`Invalid api_key_env ${value}`);
    }
}
//# sourceMappingURL=config.js.map