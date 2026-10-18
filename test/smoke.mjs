#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
/**
 * bundle 的离线自检：不需要 DSH，也不需要浏览器。
 *
 * 检查的都是「两端契约」里最容易悄悄坏掉的东西：
 *   1. package.json：bundle patch、`./client` 导出、dsh.client 声明；
 *   2. client.js：`__ModuleLoader__.load` 的 id 必须严格等于包名（dsh-client-modules
 *      用它当登记键，对不上的失败形态是「座位永远不出现」），并且只能 require
 *      运行时基线模块；路由字面量必须与 routes.js 一致；
 *   3. index.js：能被 import，导出 apply / inject；
 *   4. cordis.patch.yml：能被 YAML 解析，插入了宿主行与 preset-math，
 *      !!js 表达式还在，preset 里没有把 toolCallTimeoutMs 调回小于 canvas_create
 *      等待上限的值。
 *
 * 用法：node test/smoke.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const require = createRequire(import.meta.url);

/** 从 DSH 安装目录借一个 YAML 解析器；没有就跳过 YAML 结构断言。 */
function loadYaml() {
	const candidates = [
		process.env.DSH_CHECKOUT ? join(process.env.DSH_CHECKOUT, 'js-yaml') : null,
		process.env.DSH_PROFILE_DIR ? join(process.env.DSH_PROFILE_DIR, 'node_modules', 'js-yaml') : null,
	].filter(Boolean);
	for (const candidate of candidates) {
		try {
			return require(candidate);
		} catch {
			/* 试下一个 */
		}
	}
	return null;
}

/**
 * 从 DSH 安装目录读 shipped 的 preset 补丁（标准模式那一份）。
 * 数学模式+ 的工具面是「标准模式 ∪ 数学模式」的抄件，而 preset 之间没有继承机制，
 * 所以这里直接把 shipped 的标准模式拿来做并集比对——标准模式哪天加了行，这里会红。
 * 找不到安装目录时返回 null，调用方跳过这两条断言。
 */
function loadShippedPreset(fileName) {
	const roots = [
		process.env.DSH_CHECKOUT,
		process.env.DSH_PROFILE_DIR ? join(process.env.DSH_PROFILE_DIR, 'node_modules') : null,
	].filter(Boolean);
	for (const root of roots) {
		try {
			const from = createRequire(join(root, 'noop.js'));
			return readFileSync(from.resolve(`@deepseek-ai/dsh-web-app/presets/${fileName}`), 'utf8');
		} catch {
			/* 试下一个 */
		}
	}
	return null;
}

let failed = 0;
const check = (name, condition, detail) => {
	if (condition) console.log(`  ✓ ${name}`);
	else {
		failed += 1;
		console.error(`  ✗ ${name}${detail === undefined ? '' : `：${detail}`}`);
	}
};

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const clientCode = readFileSync(join(root, 'client.js'), 'utf8');
const hostCode = readFileSync(join(root, 'index.js'), 'utf8');
const patchText = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');

/* ------------------------------------------------------------ 清单 */

console.log('\nbundle 清单：');
check('name 是 dsh-geogebra-bridge-bundle', manifest.name === 'dsh-geogebra-bridge-bundle', manifest.name);
check('声明了 dsh.bundle.patch', manifest.dsh?.bundle?.patch === './cordis.patch.yml', JSON.stringify(manifest.dsh?.bundle));
check('声明了 dsh.client.platform=web', manifest.dsh?.client?.platform === 'web', JSON.stringify(manifest.dsh?.client));
check('exports["./client"] 指向 client.js（双面包的必需导出）', manifest.exports?.['./client'] === './client.js', JSON.stringify(manifest.exports));
check('exports["."] 指向 index.js', manifest.exports?.['.'] === './index.js', JSON.stringify(manifest.exports));
check('package.json 是合法 JSON 且 files 里带了两个半边', Boolean(manifest.files?.includes('client.js') && manifest.files?.includes('index.js')), JSON.stringify(manifest.files));

/* ------------------------------------------------------ 客户端契约 */

console.log('\n客户端半边（client.js）：');
const loadId = /__ModuleLoader__\.load\(\s*\{\s*id:\s*['"]([^'"]+)['"]/.exec(clientCode);
check('用 __ModuleLoader__.load 登记工厂', loadId !== null, '没找到 load({ id })');
check('load id 严格等于包名（登记键契约）', loadId !== null && loadId[1] === manifest.name, loadId === null ? '缺失' : loadId[1]);
check('导出 apply / inject 装配', /exports\.apply\s*=/.test(clientCode) && /exports\.inject\s*=/.test(clientCode));
check('只 require 运行时基线模块（react）', !/require\(\s*['"](?!react['"])/.test(clientCode), (clientCode.match(/require\(\s*['"][^'"]+['"]/g) ?? []).join(', '));

const routes = await import(pathToFileURL(join(root, 'routes.js')).href);
// status 只是宿主侧的诊断路由，浏览器半边用不到；pending / confirm 两边都要一致。
for (const key of ['pending', 'confirm']) {
	const path = routes.PENDING_ROUTE[key];
	check(`client.js 里有 ${key} 路由字面量 ${path}`, clientCode.includes(path), '两端路由漂移了');
}

// 样式表归属：客户端模块系统会把「没有 data-plugin 的 <style>」认领给正在 materialize
// 的插件，并在那个插件被 HMR 替换/摘除时整批删掉。所以自己的样式必须标上自己的包名，
// 也不要把 <style> 渲染进 React 树（那样它是无标记的，会被别人认领）。
check(
	'注入的 <style> 标了自己的包名（不被别人认领 / 不误删别人的）',
	clientCode.includes("setAttribute('data-plugin', 'dsh-geogebra-bridge-bundle')"),
	'没找到 data-plugin 标记',
);
check('样式不渲染进 React 树（避免无标记的 <style>）', !/h\(\s*['"]style['"]/.test(clientCode), 'React 树里还有 <style>');
check('样式注入登记在 ctx.effect 里并有移除函数', /var removeStyle = ensureStyle\(\)/.test(clientCode) && /removeStyle\(\)/.test(clientCode));
check(
	'会把 harness 误标给自己、其实属于别人的 <style> 放回去',
	/function releaseForeignStyleClaims\(\)/.test(clientCode) &&
		/releaseForeignStyleClaims\(\);/.test(clientCode) &&
		/queueMicrotask\(releaseForeignStyleClaims\)/.test(clientCode),
	'缺少误标释放',
);

/* -------------------------------------------------------- 宿主半边 */

console.log('\n宿主半边（index.js）：');
const host = await import(pathToFileURL(join(root, 'index.js')).href);
check('导出 apply()', typeof host.apply === 'function');
check('导出 inject 且含 webServer', Array.isArray(host.inject) && host.inject.includes('webServer'), JSON.stringify(host.inject));
check('注册了三条同源路由', ['pending', 'confirm', 'status'].every((key) => hostCode.includes(routes.PENDING_ROUTE[key])));
check('只认自报名字与协议的桥', hostCode.includes('geogebra-math-bridge') && /MIN_PROTOCOL\s*=\s*2/.test(hostCode));

/* ------------------------------------------------------------ patch */

console.log('\ncordis.patch.yml：');
check('没有制表符（YAML 里会炸）', !patchText.includes('\t'));
check('插入宿主行 geogebra-bridge-ui', /- id: geogebra-bridge-ui\s*\n\s*name: 'dsh-geogebra-bridge-bundle'/.test(patchText));
check('插入 preset-math', /- id: preset-math\s*\n\s*name: '@deepseek-ai\/dsh-agent-preset'/.test(patchText));
check('插入 preset-math-plus', /- id: preset-math-plus\s*\n\s*name: '@deepseek-ai\/dsh-agent-preset'/.test(patchText));
check('保留 !!js 的桥入口表达式', patchText.includes('process.env.GGB_BRIDGE_BIN'));

const yaml = loadYaml();
if (yaml === null) {
	console.log('  （跳过 YAML 结构断言：没找到 js-yaml）');
} else {
	// cordis 的 YAML 方言带一个 `!!js` 标签（表达式在装载时求值）。js-yaml 不认它，
	// 这里注册成一个「原样收下」的标量类型，既能解析结构，又不会去执行表达式。
	const schema = yaml.DEFAULT_SCHEMA.extend([
		new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (data) => ({ __js: String(data) }) }),
	]);
	let parsed = null;
	try {
		parsed = yaml.load(patchText, { schema });
	} catch (error) {
		check('YAML 能被解析（含 !!js 标签）', false, error.message);
	}
	if (parsed !== null) {
		check('YAML 能被解析（含 !!js 标签）', true);
		const insert = parsed[0]?.insert ?? [];
		const ui = insert.find((row) => row.id === 'geogebra-bridge-ui');
		const preset = insert.find((row) => row.id === 'preset-math');
		const basePort = ui?.config?.basePort;
		check(
			'宿主行有 basePort / ports 配置',
			basePort !== undefined && (Number.isFinite(basePort) || typeof basePort?.__js === 'string') && Number.isFinite(ui?.config?.ports),
			JSON.stringify(ui?.config),
		);
		const mcp = preset?.config?.plugins?.find((row) => row.id === 'mcp-geogebra');
		check('mcp-client 的 toolCallTimeoutMs 大于 canvas_create 的确认上限（5 分钟）', mcp?.config?.toolCallTimeoutMs > 300_000, String(mcp?.config?.toolCallTimeoutMs));
		check('persona 的 prefix 说明了 canvas_create 会等确认', String(preset?.config?.plugins?.find((row) => row.id === 'persona')?.config?.prefix ?? '').includes('确认框'));
		check(
			'persona 的 prefix 要求「精确完成用户要求、不考虑外观等额外因素」',
			/精确完成用户提出的要求/.test(String(preset?.config?.plugins?.find((row) => row.id === 'persona')?.config?.prefix ?? '')) &&
				/不要为了「好看」/.test(String(preset?.config?.plugins?.find((row) => row.id === 'persona')?.config?.prefix ?? '')),
			'prefix 里没有这条要求',
		);

		/* ------------------------------------------- 数学模式+（标准 ∪ 数学） */

		console.log('\n数学模式+（preset-math-plus）：');
		const mathPersona = preset?.config?.plugins?.find((row) => row.id === 'persona')?.config ?? {};
		const plusPreset = insert.find((row) => row.id === 'preset-math-plus');
		const plusConfig = plusPreset?.config ?? {};
		const plusPlugins = Array.isArray(plusConfig.plugins) ? plusConfig.plugins : [];
		const plusById = new Map(plusPlugins.map((row) => [row.id, row]));

		check('id 是 math-plus、名称是「数学模式+」', plusConfig.id === 'math-plus' && plusConfig.name === '数学模式+', `${plusConfig.id} / ${plusConfig.name}`);
		check('order 排在数学模式（6）之后', plusConfig.order > (preset?.config?.order ?? 0), String(plusConfig.order));

		// 提示词：标准模式的装配方式 + 标准 prefix 与数学 prefix 首尾相接。
		const plusPersona = plusById.get('persona')?.config ?? {};
		check(
			'persona 不设 complete / 不关运行时上下文（保留标准模式的提示词装配）',
			plusPersona.complete !== true && plusPersona.includeRuntimeContext !== false,
			`complete=${plusPersona.complete} includeRuntimeContext=${plusPersona.includeRuntimeContext}`,
		);
		check('persona 的 suffix 沿用标准模式的 {{cwd}}', plusPersona.suffix === 'Your working directory is {{cwd}}.', String(plusPersona.suffix));

		const standardText = loadShippedPreset('standard.patch.yml');
		const standardYaml = standardText === null || yaml === null ? null : yaml.load(standardText, { schema });
		const standardPersona = standardYaml?.[0]?.insert?.find((row) => row.id === 'preset-standard')?.config?.plugins?.find((row) => row.id === 'persona')?.config;
		if (standardPersona === undefined) {
			console.log('  （跳过「prefix = 标准 + 数学」的逐字断言：没找到 shipped 的 preset-standard）');
		} else {
			check(
				'prefix 逐字等于 标准模式 prefix + "\\n\\n" + 数学模式 prefix',
				plusPersona.prefix === `${standardPersona.prefix}\n\n${mathPersona.prefix}`,
				'拼接结果与两边原文不一致',
			);
		}

		// 工具面：标准模式每一行都要在，且 name / disabled / config 逐字相同（persona 除外，
		// 它本来就该是拼起来的那一份）。
		const sameEntry = (a, b) =>
			a.name === b.name && JSON.stringify(a.disabled) === JSON.stringify(b.disabled) && JSON.stringify(a.config) === JSON.stringify(b.config);
		const standardPlugins = standardYaml?.[0]?.insert?.find((row) => row.id === 'preset-standard')?.config?.plugins;
		if (!Array.isArray(standardPlugins)) {
			console.log('  （跳过「标准模式工具面全覆盖」断言：没找到 shipped 的 preset-standard）');
		} else {
			const drift = standardPlugins
				.filter((row) => row.id !== 'persona')
				.filter((row) => plusById.get(row.id) === undefined || !sameEntry(plusById.get(row.id), row))
				.map((row) => row.id);
			check(
				`标准模式的 ${standardPlugins.length - 1} 行工具/流程都在，且配置逐字相同`,
				drift.length === 0,
				`缺行或配置漂移：${drift.join(', ')}`,
			);
		}

		// 数学模式那一份：mcp-client 与流程行必须原样搬过来；分组行（planning /
		// delegation）用的是标准模式的配置——计划模式的 section 属于标准模式的提示词，
		// 数学模式的 delegation 也只是标准模式那一组的子集——所以只比子行 id 是否都在；
		// persona 本来就该是拼起来的那一份。
		const strictDrift = (preset?.config?.plugins ?? [])
			.filter((row) => !['persona', 'planning', 'delegation'].includes(row.id))
			.filter((row) => plusById.get(row.id) === undefined || !sameEntry(plusById.get(row.id), row))
			.map((row) => row.id);
		check('数学模式的非分组行（含 mcp-geogebra）原样都在', strictDrift.length === 0, `缺行或配置漂移：${strictDrift.join(', ')}`);

		const groupDrift = [];
		for (const group of (preset?.config?.plugins ?? []).filter((row) => Array.isArray(row.config))) {
			const mineChildren = new Set((plusById.get(group.id)?.config ?? []).map((row) => row.id));
			for (const child of group.config) if (!mineChildren.has(child.id)) groupDrift.push(`${group.id}/${child.id}`);
		}
		check('数学模式的分组行（planning / delegation）里的子行都在', groupDrift.length === 0, `缺行：${groupDrift.join(', ')}`);

		const plusMcp = plusById.get('mcp-geogebra')?.config;
		check('数学模式+ 的 mcp-client 也把 toolCallTimeoutMs 放到确认上限之上', plusMcp?.toolCallTimeoutMs > 300_000, String(plusMcp?.toolCallTimeoutMs));
	}
}

console.log(failed === 0 ? '\nbundle 自检通过。' : `\nbundle 自检失败 ${failed} 项。`);
process.exit(failed === 0 ? 0 : 1);
