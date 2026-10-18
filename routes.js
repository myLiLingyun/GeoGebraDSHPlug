// SPDX-License-Identifier: GPL-3.0-only
/**
 * 宿主半边对外提供的 HTTP 路由。
 *
 * 客户端 bundle 是 `__ModuleLoader__.load({ factory })` 的契约产物，只能 require
 * 运行时基线模块（react 等），不能 import 这个文件——所以 client.js 里是同一份
 * 路径的字面量。为了不让两边悄悄漂移，`test/smoke.mjs` 会断言 client.js 里确实
 * 出现了下面这几个路径。
 */

/** 本插件在 DSH web 服务上的路由前缀。 */
export const ROUTE_PREFIX = '/api/dsh-geogebra-bridge';

/** 路由表。 */
export const PENDING_ROUTE = Object.freeze({
	/** GET：现在有哪些画布在等用户确认打开。 */
	pending: `${ROUTE_PREFIX}/pending`,
	/** POST：用户在弹窗里的选择（{ id, action, bridge }）。 */
	confirm: `${ROUTE_PREFIX}/confirm`,
	/** GET：诊断——按端口段扫到了哪几座桥。 */
	status: `${ROUTE_PREFIX}/status`,
});

export default PENDING_ROUTE;
