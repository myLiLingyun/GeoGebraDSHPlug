// SPDX-License-Identifier: GPL-3.0-only
/**
 * dsh-geogebra-bridge-bundle 的宿主半边：给网页界面插件当「画布确认」的代理。
 *
 * 背景：桥（server/，MCP stdio 程序）在 canvas_create 里会登记一条「等你打开画布」
 * 的请求并挂住这次工具调用。用户在 DSH 网页界面点开地址、再点「已打开」，工具才返回。
 * 弹窗本身跑在浏览器里（client.js），而浏览器只跟 DSH 自己的 web 服务同源，
 * 所以这里提供两条同源路由，把浏览器与桥接起来：
 *
 *   GET  /api/dsh-geogebra-bridge/pending   轮询：现在有哪些画布在等确认
 *   POST /api/dsh-geogebra-bridge/confirm   用户在弹窗里的选择（opened / skip）
 *   GET  /api/dsh-geogebra-bridge/status    诊断：发现了几座桥、分别在哪
 *
 * 桥只监听回环地址、端口可能从 3460 顺延，所以这里按端口段扫一遍，并要求
 * `/api/pending` 自报 `name === 'geogebra-math-bridge'` 且 `protocol >= 2`——
 * 早先版本留在机器上的孤儿桥进程没有这两行，自然被跳过。
 *
 * 这里不缓存扫描结果：每次界面轮询都真扫一遍，桥刚重启/换端口也能立刻看到。
 * 端口段内没有监听时连接会被立刻拒绝，20 个端口的代价可以忽略。
 */

import { PENDING_ROUTE } from './routes.js';

/** Cordis 插件名。 */
export const name = 'geogebra-bridge-ui';

/** 只依赖 web 服务：这半边是纯 HTTP 代理。 */
export const inject = ['webServer'];

/** 桥自报的名字；对不上就不是我们要找的进程。 */
const BRIDGE_NAME = 'geogebra-math-bridge';

/** 至少要带确认功能的协议号（见 server/src/identity.mjs）。 */
const MIN_PROTOCOL = 2;

/** 单个端口的探测上限；本机连接被拒是立刻返回的，这个值只是兜底。 */
const PROBE_TIMEOUT_MS = 800;

/** 转发 confirm 时的上限。 */
const FORWARD_TIMEOUT_MS = 5_000;

/**
 * 读插件配置。
 *
 * @param {unknown} raw
 * @returns {{basePort: number, ports: number}}
 */
function normalizeConfig(raw) {
	const config = raw !== null && typeof raw === 'object' ? raw : {};
	const fromEnv = Number(process.env.GGB_BRIDGE_PORT);
	const basePort = Number.isFinite(config.basePort)
		? Number(config.basePort)
		: Number.isFinite(fromEnv)
			? fromEnv
			: 3460;
	const ports = Number.isFinite(config.ports) ? Math.max(1, Math.min(64, Number(config.ports))) : 20;
	return { basePort, ports };
}

/** 判断请求是否来自回环地址。 */
function isLoopback(req) {
	const address = req.socket?.remoteAddress ?? '';
	return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** 写一个 JSON 响应。 */
function sendJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'content-length': Buffer.byteLength(body),
	});
	res.end(body);
}

/** 读 JSON 请求体；空体当 {}；解析失败当 null。 */
async function readJson(req, limit = 64 * 1024) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		total += chunk.length;
		if (total > limit) return null;
		chunks.push(chunk);
	}
	if (total === 0) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8'));
	} catch {
		return null;
	}
}

/**
 * 扫一遍端口段，返回所有「带确认协议」的桥。
 *
 * 顺序：新起的在前。界面轮询到旧桥也没关系——确认时会带着 `bridge` 原路送回，
 * 所以多桥共存时也不会把弹窗接到错的登记表上。
 *
 * @param {{basePort: number, ports: number}} config
 * @returns {Promise<{url: string, port: number, startedAt: number, pending: object[]}[]>}
 */
async function scanBridges(config) {
	const ports = [];
	for (let offset = 0; offset < config.ports; offset += 1) ports.push(config.basePort + offset);

	const found = await Promise.all(
		ports.map(async (port) => {
			const url = `http://127.0.0.1:${port}`;
			try {
				const response = await fetch(`${url}/api/pending`, {
					headers: { accept: 'application/json' },
					signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
				});
				if (!response.ok) return null;
				const body = await response.json();
				if (body?.name !== BRIDGE_NAME || Number(body?.protocol ?? 0) < MIN_PROTOCOL) return null;
				return {
					url,
					port,
					startedAt: Number(body.startedAt) || 0,
					pending: Array.isArray(body.pending) ? body.pending : [],
				};
			} catch {
				return null;
			}
		}),
	);

	return found.filter((entry) => entry !== null).sort((a, b) => b.startedAt - a.startedAt || a.port - b.port);
}

/**
 * 挂载宿主半边：注册三条同源路由。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} [rawConfig]
 */
export function apply(ctx, rawConfig) {
	const config = normalizeConfig(rawConfig);
	const warn = (message) => ctx.logger?.warn?.(`[geogebra-bridge-ui] ${message}`);

	// 诊断用：浏览器那边的弹窗是不是真的在轮询。status 路由会报出来，
	// 「弹窗不出现」时先看这个计数有没有在涨。
	let pendingPolls = 0;
	let lastPendingPollAt = 0;

	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: 'exact',
				path: PENDING_ROUTE.pending,
				handler: async (req, res) => {
					if (req.method !== 'GET' && req.method !== 'HEAD') {
						sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
						return;
					}
					if (!isLoopback(req)) {
						sendJson(res, 403, { ok: false, error: 'forbidden' });
						return;
					}
					pendingPolls += 1;
					lastPendingPollAt = Date.now();
					const bridges = await scanBridges(config);
					// 每条请求都带上它属于哪座桥：多桥共存时确认要原路送回。
					const pending = bridges.flatMap((bridge) =>
						bridge.pending.map((item) => ({ ...item, bridge: bridge.url })),
					);
					sendJson(res, 200, {
						ok: true,
						bridges: bridges.map((bridge) => ({ url: bridge.url, port: bridge.port })),
						pending,
					});
				},
			}),
		'geogebra-bridge-ui: pending route',
	);

	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: 'exact',
				path: PENDING_ROUTE.confirm,
				handler: async (req, res) => {
					if (req.method !== 'POST') {
						sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
						return;
					}
					if (!isLoopback(req)) {
						sendJson(res, 403, { ok: false, error: 'forbidden' });
						return;
					}
					const body = await readJson(req);
					if (body === null) {
						sendJson(res, 400, { ok: false, accepted: false, reason: '请求体不是 JSON。' });
						return;
					}
					const id = typeof body.id === 'string' ? body.id.trim() : '';
					const action = typeof body.action === 'string' ? body.action.trim() : '';
					if (id === '' || (action !== 'opened' && action !== 'skip')) {
						sendJson(res, 400, { ok: false, accepted: false, reason: '要带 id 和 action（opened / skip）。' });
						return;
					}

					const bridges = await scanBridges(config);
					if (bridges.length === 0) {
						sendJson(res, 503, { ok: false, accepted: false, reason: '没有找到带确认功能的 GeoGebra 桥（桥可能刚重启）。' });
						return;
					}
					// 只认刚刚扫到的那几座桥，避免把请求转发到任意地址。
					const requested = typeof body.bridge === 'string' ? body.bridge.trim().replace(/\/+$/, '') : '';
					const target = bridges.find((bridge) => bridge.url === requested) ?? bridges[0];

					try {
						const response = await fetch(`${target.url}/api/pending/confirm`, {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({ id, action }),
							signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
						});
						const payload = await response.json().catch(() => ({ ok: false, accepted: false, reason: '桥返回的不是 JSON。' }));
						sendJson(res, 200, { ...payload, bridge: target.url });
					} catch (error) {
						warn(`转发确认到 ${target.url} 失败：${error?.message ?? error}`);
						sendJson(res, 502, { ok: false, accepted: false, reason: `桥没有回应：${error?.message ?? error}` });
					}
				},
			}),
		'geogebra-bridge-ui: confirm route',
	);

	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: 'exact',
				path: PENDING_ROUTE.status,
				handler: async (req, res) => {
					if (req.method !== 'GET' && req.method !== 'HEAD') {
						sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
						return;
					}
					if (!isLoopback(req)) {
						sendJson(res, 403, { ok: false, error: 'forbidden' });
						return;
					}
					const bridges = await scanBridges(config);
					sendJson(res, 200, {
						ok: true,
						basePort: config.basePort,
						ports: config.ports,
						pendingPolls,
						lastPendingPollAt,
						bridges: bridges.map((bridge) => ({
							url: bridge.url,
							port: bridge.port,
							startedAt: bridge.startedAt,
							pending: bridge.pending.length,
						})),
					});
				},
			}),
		'geogebra-bridge-ui: status route',
	);
}
