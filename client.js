// SPDX-License-Identifier: GPL-3.0-only
/**
 * dsh-geogebra-bridge-bundle 的浏览器半边：画布确认弹窗。
 *
 * 桥在 `canvas_create` 里会挂住那次工具调用，等用户真的把画布地址打开、并在弹窗里
 * 点「已打开」之后才返回。弹窗就在这里：
 *
 *   - 每隔约 1 秒（没有等待项时约 4 秒）向同源路由 `GET /api/dsh-geogebra-bridge/pending`
 *     要一份「正在等确认」的清单；
 *   - 有的话在 `shell.overlay` 上渲染一张浮层卡片：蓝色可点的画布地址、
 *     实时连接状态、「已打开，继续」/「跳过，先继续」两个出口；
 *   - 用户点「已打开」→ `POST …/confirm {id, action:"opened"}`，桥那边解除阻塞，
 *     工具返回，Agent 接着干活。
 *
 * 本文件**就是**发布产物形态（dsh web 的客户端契约），不经打包器：运行时的
 * `window.__ModuleLoader__.load({ id, factory })` 只登记一个工厂，模块体在首次
 * materialize 时执行；`require` 只解析运行时基线模块（react 等）。
 * load id 必须严格等于 package.json 的 name（dsh-client-modules 用它当登记键）。
 * 路由字面量与宿主半边 bundle/routes.js 一致，test/smoke.mjs 会断言这一点。
 */

window.__ModuleLoader__.load({
	id: 'dsh-geogebra-bridge-bundle',
	factory: function (require) {
		'use strict';
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(module.exports, Symbol.toStringTag, { value: 'Module' });

		var React = require('react');
		var h = React.createElement;

		/** 同源路由（与宿主半边 bundle/routes.js 保持一致）。 */
		var PENDING_URL = '/api/dsh-geogebra-bridge/pending';
		var CONFIRM_URL = '/api/dsh-geogebra-bridge/confirm';

		/** 客户端插件名（注册座位时用）。 */
		var PLUGIN_NAME = 'geogebra-bridge-ui';

		/** 没有等待项时多久问一次桥。 */
		var POLL_IDLE_MS = 4000;
		/** 有等待项时问得勤一点：连接状态变化要立刻反映到弹窗上。 */
		var POLL_PENDING_MS = 1000;

		//#region 文案

		var DICT = {
			zh: {
				title: '在浏览器里打开 GeoGebra 画布',
				intro: 'Agent 建好了画布 {canvas}（{app} 界面），正在等你打开它。',
				step1: '① 点下面这个蓝色链接打开画布（在新标签页里打开）',
				copy: '复制链接',
				copied: '已复制',
				waiting: '等待页面连接…（打开链接后会自动检测，通常 5–10 秒）',
				connected: '页面已连上 · GeoGebra {version} · {count} 个对象',
				connectedNoInfo: '页面已连上。',
				skip: '跳过，先继续',
				opened: '已打开，继续',
				working: '处理中…',
				hint: 'Agent 正在等这一步。页面一直连不上的话（3D 界面需要浏览器有可用的 WebGL），点「跳过」让它先继续。',
				errorPrefix: '确认失败：',
			},
			en: {
				title: 'Open the GeoGebra canvas in your browser',
				intro: 'The agent created canvas {canvas} ({app}) and is waiting for you to open it.',
				step1: '① Click the blue link below to open the canvas (opens in a new tab)',
				copy: 'Copy link',
				copied: 'Copied',
				waiting: 'Waiting for the page to connect… (detected automatically, usually 5–10s)',
				connected: 'Page connected · GeoGebra {version} · {count} objects',
				connectedNoInfo: 'Page connected.',
				skip: 'Skip and continue',
				opened: 'Opened, continue',
				working: 'Working…',
				hint: 'The agent is waiting on this step. If the page never connects (the 3D app needs a WebGL-capable browser), click “Skip” to let it continue.',
				errorPrefix: 'Confirm failed: ',
			},
		};

		/** 当前语言（apply 时确定）。 */
		var lang = 'zh';

		/** 取文案；{name} 形式做参数替换。 */
		function t(key, params) {
			var table = DICT[lang] || DICT.zh;
			var text = table[key];
			if (text === undefined) text = DICT.zh[key];
			if (text === undefined) return key;
			if (params === undefined) return text;
			return text.replace(/\{(\w+)\}/g, function (whole, name) {
				return params[name] === undefined ? whole : String(params[name]);
			});
		}

		/** 从 locale 服务 / 浏览器语言推断界面语言。 */
		function detectLang(ctx) {
			var candidate = '';
			try {
				var snapshot = ctx.locale && typeof ctx.locale.getSnapshot === 'function' ? ctx.locale.getSnapshot() : null;
				if (snapshot && typeof snapshot.active === 'string') candidate = snapshot.active;
			} catch (error) {
				/* locale 读不到就按浏览器语言处理 */
			}
			if (candidate === '') {
				try {
					candidate = (typeof navigator !== 'undefined' && (navigator.language || navigator.userLanguage)) || '';
				} catch (error) {
					candidate = '';
				}
			}
			return String(candidate).toLowerCase().indexOf('en') === 0 ? 'en' : 'zh';
		}

		//#endregion

		//#region 数据源

		/** 模块级快照：座位只有一个，但保持和宿主一样的 subscribe/getSnapshot 形态。 */
		var state = { phase: 'idle', pending: [], bridges: [], error: null, at: 0 };
		/** @type {Set<Function>} */
		var listeners = new Set();
		/** @type {Promise<unknown> | null} */
		var inflight = null;

		function getSnapshot() {
			return state;
		}

		function subscribe(listener) {
			listeners.add(listener);
			return function () {
				listeners.delete(listener);
			};
		}

		function publish(next) {
			state = next;
			listeners.forEach(function (listener) {
				try {
					listener();
				} catch (error) {
					/* 单个订阅者异常不影响其余 */
				}
			});
		}

		/** 清单没变就不发布：避免每次轮询都白重渲染一遍。 */
		function publishFrom(pending, bridges, error) {
			var signature = JSON.stringify([
				pending.map(function (item) {
					return [item.id, item.canvasId, item.url, item.connected === true, item.page ? item.page.version : null, item.page ? item.page.objectCount : null, item.bridge];
				}),
				bridges,
				error,
			]);
			if (state.signature === signature) return;
			publish({
				phase: error === null ? 'ready' : state.pending.length > 0 ? 'stale' : 'error',
				pending: pending,
				bridges: bridges,
				error: error,
				at: Date.now(),
				signature: signature,
			});
		}

		/** 问一次桥；并发调用合并成一次。 */
		function refresh() {
			if (inflight !== null) return inflight;
			inflight = fetch(PENDING_URL, { headers: { accept: 'application/json' }, cache: 'no-store' })
				.then(function (response) {
					if (!response.ok) throw new Error('HTTP ' + response.status);
					return response.json();
				})
				.then(function (body) {
					var pending = Array.isArray(body && body.pending) ? body.pending : [];
					var bridges = Array.isArray(body && body.bridges) ? body.bridges : [];
					publishFrom(pending, bridges, null);
					return pending;
				})
				.catch(function (error) {
					var message = error && error.message ? error.message : String(error);
					publishFrom(state.pending, state.bridges, message);
					return null;
				})
				.then(function (value) {
					inflight = null;
					return value;
				});
			return inflight;
		}

		/** 自适应轮询：有等待项时 1 秒一次，没有时 4 秒一次；返回停止函数。 */
		function startPolling() {
			var timer = null;
			var stopped = false;
			function schedule() {
				if (stopped) return;
				var delay = state.pending.length > 0 ? POLL_PENDING_MS : POLL_IDLE_MS;
				timer = setTimeout(function () {
					refresh().then(schedule, schedule);
				}, delay);
			}
			refresh().then(schedule, schedule);
			var onVisible = function () {
				if (document.visibilityState === 'visible') refresh();
			};
			document.addEventListener('visibilitychange', onVisible);
			return function () {
				stopped = true;
				if (timer !== null) clearTimeout(timer);
				document.removeEventListener('visibilitychange', onVisible);
			};
		}

		//#endregion

		/** 样式表元素 id（幂等注入用）。 */
		var STYLE_ID = 'dsh-geogebra-bridge-ui-style';

		//#region 样式

		var CSS = [
			// 外层只是定位层：pointer-events 保持 none，让底下的界面照常可点。
			// 只有卡片自己 opt-in——不然用户离开一会儿，Agent 等确认的这 5 分钟里
			// 整个 DSH 界面会被一个遮罩挡住，连看对话、按停止都做不到。
			'.ggbui-backdrop{position:fixed;inset:0;z-index:60;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:12px;padding:9vh 24px 24px;box-sizing:border-box;pointer-events:none;overflow:auto;font-family:var(--dsw-font-family,system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif);font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary,#1b1b1f)}',
			'.ggbui-dialog{pointer-events:auto;width:min(520px,calc(100vw - 48px));max-height:72vh;overflow:auto;box-sizing:border-box;border-radius:14px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:var(--dsw-alias-bg-overlay,#fff);box-shadow:0 18px 48px rgba(0,0,0,.3);padding:18px 18px 14px}',
			'.ggbui-title{font-size:15px;font-weight:600;margin:0 0 6px}',
			'.ggbui-text{margin:0 0 10px;color:var(--dsw-alias-label-secondary,#5f6368)}',
			'.ggbui-step{margin:0 0 6px;font-weight:600}',
			'.ggbui-linkrow{display:flex;align-items:flex-start;gap:8px;margin:0 0 10px}',
			'.ggbui-link{flex:1 1 auto;min-width:0;word-break:break-all;color:var(--dsw-alias-link,#4176e6);text-decoration:underline;text-underline-offset:2px;font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px}',
			'.ggbui-link:hover{text-decoration-thickness:2px}',
			'.ggbui-status{display:flex;align-items:center;gap:6px;margin:0 0 4px;color:var(--dsw-alias-label-secondary,#5f6368)}',
			'.ggbui-status-waiting::before{content:"";width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-state-warn-primary,#d97706)}',
			'.ggbui-status-ok{color:var(--dsw-alias-state-success-primary,#15803d);font-weight:600}',
			'.ggbui-status-ok::before{content:"";width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-state-success-primary,#15803d)}',
			'.ggbui-hint{margin:8px 0 12px;color:var(--dsw-alias-label-tertiary,#80868b);font-size:12px}',
			'.ggbui-error{margin:0 0 10px;color:var(--dsw-alias-state-error-primary,#d93025);font-size:12px;word-break:break-all}',
			'.ggbui-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}',
			'.ggbui-btn{font:inherit;font-size:12px;border-radius:8px;padding:5px 12px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));background:transparent;color:inherit}',
			'.ggbui-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05))}',
			'.ggbui-btn:disabled{opacity:.5;cursor:default}',
			'.ggbui-btn-primary{border-color:transparent;background:var(--dsw-alias-brand-primary,#4176e6);color:#fff}',
			'.ggbui-btn-primary:hover:not(:disabled){filter:brightness(1.06)}',
			'.ggbui-btn-small{padding:2px 8px;font-size:11px}',
		].join('\n');

		/**
		 * 注入样式表；返回移除函数。
		 *
		 * `data-plugin` 必须写成**本包的包名**：客户端模块系统在 materialize 时会
		 * 把所有**没有 `data-plugin` 的 `<style>`** 一起标记成「正在 materialize 的那个
		 * 插件」，然后在那个插件被 HMR 替换或从图上摘掉时按这个标记整批删除。
		 * 所以：
		 *   - 不标记 → 别的插件 materialize 时会把我们的样式认领走，它一重载我们就没样式了；
		 *   - 反过来，我们 materialize 时也会把**别人**没标记的样式认领走，之后我们一重载
		 *     就把别人的样式删了（account-insight 曾因此掉样式）。
		 * 标成自己的包名，两条都断开：harness 只在替换/摘除我们这一行时才删它。
		 * 另一半（别人也要守规矩）见 bundle/README.md 的「样式表归属」。
		 */
		function ensureStyle() {
			if (typeof document === 'undefined' || document.head === null) return function () {};
			var existing = document.getElementById(STYLE_ID);
			if (existing !== null) return function () {};
			var element = document.createElement('style');
			element.id = STYLE_ID;
			element.setAttribute('data-plugin', 'dsh-geogebra-bridge-bundle');
			element.setAttribute('data-plugin-css', PLUGIN_NAME);
			element.textContent = CSS;
			document.head.appendChild(element);
			return function () {
				var current = document.getElementById(STYLE_ID);
				if (current !== null && current.parentNode !== null) current.parentNode.removeChild(current);
			};
		}

		//#endregion

		//#region 样式表归属

		/**
		 * 把 materialize 时被 harness 误标的样式放回去。
		 *
		 * 客户端模块系统在 materialize 时会把**当时文档里所有没有 `data-plugin` 的
		 * `<style>`** 一并标成「正在 materialize 的这个插件」，之后这个插件被 HMR 替换或
		 * 从图上摘掉时按标记整批删除。猜的是「刚注入的样式」，但它不区分作者——所以我们
		 * materialize 时，别的插件留在文档里的未标记样式会被算到我们头上，我们一重载
		 * 就把人家删了（实测：`dsh-account-insight` 的余额胶囊就是这么掉样式的）。
		 *
		 * 这里只做一件事：把标着**我们包名**、但不是我们那张样式表的元素还原成未标记——
		 * 也就是还回它们原本的样子，不碰它们的内容。真正的修法在各自插件那边
		 * （给自己的 `<style>` 加 `data-plugin`，见 bundle/README.md「样式表归属」）。
		 */
		function releaseForeignStyleClaims() {
			if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
			var mine = document.getElementById(STYLE_ID);
			var claimed = document.querySelectorAll('style[data-plugin="dsh-geogebra-bridge-bundle"]');
			for (var index = 0; index < claimed.length; index += 1) {
				var element = claimed[index];
				if (element === mine) continue;
				element.removeAttribute('data-plugin');
				element.removeAttribute('data-plugin-css');
			}
		}

		//#endregion

		//#region 组件

		/**
		 * 一条等待确认的请求 = 一张卡片。
		 * @param {{item: object}} props
		 */
		function ConfirmDialog(props) {
			var item = props.item;
			var connected = item.connected === true;
			var page = item.page && typeof item.page === 'object' ? item.page : null;

			var busyPair = React.useState(false);
			var busy = busyPair[0];
			var setBusy = busyPair[1];
			var errorPair = React.useState(null);
			var error = errorPair[0];
			var setError = errorPair[1];
			var copiedPair = React.useState(false);
			var copied = copiedPair[0];
			var setCopied = copiedPair[1];

			var linkRef = React.useRef(null);
			React.useEffect(function () {
				if (linkRef.current && typeof linkRef.current.focus === 'function') linkRef.current.focus();
			}, []);

			/** 用户在弹窗里做出选择；无论结果如何都刷新一次，让已经作废的卡片消失。 */
			function choose(action) {
				if (busy) return;
				setBusy(true);
				setError(null);
				fetch(CONFIRM_URL, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ id: item.id, action: action, bridge: item.bridge }),
				})
					.then(function (response) {
						return response
							.json()
							.catch(function () {
								return null;
							})
							.then(function (body) {
								return { status: response.status, body: body };
							});
					})
					.then(function (outcome) {
						setBusy(false);
						if (outcome.body && outcome.body.accepted === true) {
							refresh();
							return;
						}
						var reason = (outcome.body && outcome.body.reason) || 'HTTP ' + outcome.status;
						setError(t('errorPrefix') + reason);
						// 请求已经不在等待（超时/已被处理）时刷新会让这张卡片自己消失。
						refresh();
					})
					.catch(function (failure) {
						setBusy(false);
						setError(t('errorPrefix') + (failure && failure.message ? failure.message : String(failure)));
					});
			}

			/** 复制链接：没有剪贴板权限就退回到「选中文本」。 */
			function copyLink() {
				var url = String(item.url || '');
				var done = function () {
					setCopied(true);
					setTimeout(function () {
						setCopied(false);
					}, 1500);
				};
				try {
					if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
						navigator.clipboard.writeText(url).then(done, done);
						return;
					}
				} catch (error) {
					/* 走下面的兜底 */
				}
				if (linkRef.current && typeof linkRef.current.select === 'function') {
					linkRef.current.select();
				}
				done();
			}

			var statusText = connected
				? page && page.version
					? t('connected', { version: page.version, count: page.objectCount === null || page.objectCount === undefined ? '?' : page.objectCount })
					: t('connectedNoInfo')
				: t('waiting');

			return h(
				'div',
				{ className: 'ggbui-dialog', role: 'dialog', 'aria-label': t('title') },
				h('h2', { className: 'ggbui-title' }, t('title')),
				h('p', { className: 'ggbui-text' }, t('intro', { canvas: item.canvasId, app: item.app || 'classic' })),
				h('p', { className: 'ggbui-step' }, t('step1')),
				h(
					'div',
					{ className: 'ggbui-linkrow' },
					h(
						'a',
						{
							ref: linkRef,
							className: 'ggbui-link',
							href: item.url,
							target: '_blank',
							rel: 'noreferrer noopener',
						},
						String(item.url || ''),
					),
					h(
						'button',
						{ type: 'button', className: 'ggbui-btn ggbui-btn-small', onClick: copyLink },
						copied ? t('copied') : t('copy'),
					),
				),
				h('div', { className: 'ggbui-status ' + (connected ? 'ggbui-status-ok' : 'ggbui-status-waiting') }, statusText),
				error === null ? null : h('div', { className: 'ggbui-error' }, error),
				h('p', { className: 'ggbui-hint' }, t('hint')),
				h(
					'div',
					{ className: 'ggbui-actions' },
					h(
						'button',
						{ type: 'button', className: 'ggbui-btn', disabled: busy, onClick: function () { choose('skip'); } },
						t('skip'),
					),
					h(
						'button',
						{
							type: 'button',
							className: 'ggbui-btn ggbui-btn-primary',
							disabled: busy || !connected,
							title: connected ? '' : t('waiting'),
							onClick: function () { choose('opened'); },
						},
						busy ? t('working') : t('opened'),
					),
				),
			);
		}

		/** shell.overlay 上的座位：有等待项才渲染。 */
		function OpenConfirmOverlay() {
			var snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
			var pending = snapshot.pending;
			React.useEffect(function () {
				// Esc == 跳过：不给用户留一个按不掉的弹窗。
				if (pending.length === 0) return undefined;
				var onKeyDown = function (event) {
					if (event.key !== 'Escape') return;
					event.preventDefault();
					var first = pending[0];
					fetch(CONFIRM_URL, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ id: first.id, action: 'skip', bridge: first.bridge }),
					})
						.then(function () {
							refresh();
						})
						.catch(function () {
							/* 下一轮轮询会纠正显示 */
						});
				};
				document.addEventListener('keydown', onKeyDown);
				return function () {
					document.removeEventListener('keydown', onKeyDown);
				};
			}, [pending.length]);
			if (pending.length === 0) return null;
			return h(
				'div',
				{ className: 'ggbui-backdrop' },
				pending.map(function (item) {
					return h(ConfirmDialog, { key: item.id, item: item });
				}),
			);
		}

		//#endregion

		//#region 插件契约

		/** 依赖的客户端服务。 */
		var inject = ['slots', 'locale'];

		/**
		 * 注册座位；失败不抛出（抛出去会让整个 slot entry 崩掉）。
		 *
		 * @param {object} slots
		 * @param {string} slotName
		 * @param {object} options
		 * @param {Function} component
		 * @returns {(() => void) | undefined}
		 */
		function registerSeat(slots, slotName, options, component) {
			try {
				if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return undefined;
				var disposer = slots.inject(slotName, function () {
					return slots.register(Object.assign({ name: slotName }, options), component);
				});
				return typeof disposer === 'function' ? disposer : undefined;
			} catch (error) {
				console.warn('[geogebra-bridge-ui] 座位注册失败（' + slotName + '）', error);
				return undefined;
			}
		}

		/**
		 * 挂载客户端插件。
		 *
		 * @param {object} ctx
		 */
		function apply(ctx) {
			try {
				if (typeof document === 'undefined' || document.body === null) return;
				lang = detectLang(ctx);
				var removeStyle = ensureStyle();
				releaseForeignStyleClaims();
				var stopPolling = startPolling();
				var disposeSeat = registerSeat(
					ctx.slots,
					'shell.overlay',
					{ id: PLUGIN_NAME + '.open-confirm', order: 30, label: function () { return t('title'); } },
					OpenConfirmOverlay,
				);
				ctx.effect(
					function () {
						return function () {
							stopPolling();
							removeStyle();
							if (disposeSeat !== undefined) {
								try {
									disposeSeat();
								} catch (error) {
									/* 重复退订是幂等空操作 */
								}
							}
							state = { phase: 'idle', pending: [], bridges: [], error: null, at: 0 };
						};
					},
					'geogebra-bridge-ui: lifecycle',
				);
			} catch (error) {
				console.warn('[geogebra-bridge-ui] 客户端挂载失败', error);
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = PLUGIN_NAME;

		// materialize 刚结束（harness 的 claimStyles 已经跑过）：把被误标的别人的样式放回去。
		// 放在 factory 体里是为了覆盖「插件最终没被激活」的情况——那种情况下 apply 不会跑，
		// 我们这一行被摘掉时照样会把误标的样式一起删掉。微任务在 claimStyles 之后执行。
		try {
			if (typeof document !== 'undefined' && typeof queueMicrotask === 'function') {
				queueMicrotask(releaseForeignStyleClaims);
			}
		} catch (error) {
			/* 清理是尽力而为，不因为 DOM 环境异常拖垮加载 */
		}

		return module.exports;
	},
});
