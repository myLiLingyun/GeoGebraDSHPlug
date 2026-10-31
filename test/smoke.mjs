#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
/**
 * bundle 的离线自检：不需要 DSH，也不需要浏览器。
 *
 *   node test/smoke.mjs
 *
 * 这个 bundle 现在只声明两个 agent preset，不再带网页插件；这里检查
 * package.json、cordis.patch.yml 与提示词契约。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/** 从 DSH 安装目录读 shipped 的标准模式 preset；找不到返回 null。 */
function loadShippedPreset(fileName) {
	const roots = [
		process.env.DSH_CHECKOUT,
		process.env.DSH_PROFILE_DIR ? join(process.env.DSH_PROFILE_DIR, 'node_modules') : null,
	].filter(Boolean);
	for (const rootDir of roots) {
		try {
			const from = createRequire(join(rootDir, 'noop.js'));
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
const patchText = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');

/* ------------------------------------------------------------ 清单 */

console.log('\nbundle 清单：');
check('name 是 dsh-geogebra-bridge-bundle', manifest.name === 'dsh-geogebra-bridge-bundle', manifest.name);
check('版本 0.2.1', manifest.version === '0.2.1', manifest.version);
check('声明了 dsh.bundle.patch', manifest.dsh?.bundle?.patch === './cordis.patch.yml', JSON.stringify(manifest.dsh?.bundle));
check('不再声明 dsh.client（网页插件已移除）', manifest.dsh?.client === undefined, JSON.stringify(manifest.dsh?.client));
check('不再有 main / exports 入口', manifest.main === undefined && manifest.exports === undefined, JSON.stringify({ main: manifest.main, exports: manifest.exports }));
check('files 里只有 patch 与许可证/README', Array.isArray(manifest.files) && manifest.files.includes('cordis.patch.yml') && !manifest.files.includes('client.js') && !manifest.files.includes('index.js'), JSON.stringify(manifest.files));

/* ------------------------------------------------------------ patch */

console.log('\ncordis.patch.yml：');
check('没有制表符（YAML 里会炸）', !patchText.includes('\t'));
check('不再插入 geogebra-bridge-ui 宿主行', !/- id: geogebra-bridge-ui/.test(patchText));
check('插入 preset-math', /- id: preset-math\s*\n\s*name: '@deepseek-ai\/dsh-agent-preset'/.test(patchText));
check('插入 preset-math-plus', /- id: preset-math-plus\s*\n\s*name: '@deepseek-ai\/dsh-agent-preset'/.test(patchText));
check('保留 !!js 的桥入口表达式', patchText.includes('process.env.GGB_BRIDGE_BIN'));
check('提示词不再提确认框/已打开', !/确认框|已打开/.test(patchText));
check('提示词要求立即返回 id 与 url', patchText.includes('立即返回 id 和浏览器要访问的 url'));
check('提示词要求把 url 告诉用户并结束本轮', patchText.includes('把 url 原样告诉用户') && patchText.includes('结束本轮'));

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
		const preset = insert.find((row) => row.id === 'preset-math');
		const plusPreset = insert.find((row) => row.id === 'preset-math-plus');
		const mcp = preset?.config?.plugins?.find((row) => row.id === 'mcp-geogebra');
		const plusMcp = plusPreset?.config?.plugins?.find((row) => row.id === 'mcp-geogebra');

		check('preset-math 是 math / 数学模式', preset?.config?.id === 'math' && preset?.config?.name === '数学模式', JSON.stringify({ id: preset?.config?.id, name: preset?.config?.name }));
		check('preset-math-plus 是 math-plus / 数学模式+', plusPreset?.config?.id === 'math-plus' && plusPreset?.config?.name === '数学模式+', JSON.stringify({ id: plusPreset?.config?.id, name: plusPreset?.config?.name }));
		check('toolCallTimeoutMs 覆盖 120s 的 state', mcp?.config?.toolCallTimeoutMs >= 180_000, String(mcp?.config?.toolCallTimeoutMs));
		check('数学模式+ 的 mcp-client 也覆盖 120s 的 state', plusMcp?.config?.toolCallTimeoutMs >= 180_000, String(plusMcp?.config?.toolCallTimeoutMs));
		check(
			'persona 的 prefix 要求「精确完成用户要求、不考虑外观等额外因素」',
			/精确完成用户提出的要求/.test(String(preset?.config?.plugins?.find((row) => row.id === 'persona')?.config?.prefix ?? '')) &&
				/不要为了「好看」/.test(String(preset?.config?.plugins?.find((row) => row.id === 'persona')?.config?.prefix ?? '')),
			'prefix 里没有这条要求',
		);

		const standardText = loadShippedPreset('standard.patch.yml');
		const standardYaml = standardText === null ? null : yaml.load(standardText, { schema });
		const standardPersona = standardYaml?.[0]?.insert?.find((row) => row.id === 'preset-standard')?.config?.plugins?.find((row) => row.id === 'persona')?.config;
		if (standardPersona === undefined) {
			console.log('  （跳过「prefix = 标准 + 数学」的逐字断言：没找到 shipped 的 preset-standard）');
		} else {
			const mathPersona = preset?.config?.plugins?.find((row) => row.id === 'persona')?.config ?? {};
			const plusPersona = plusPreset?.config?.plugins?.find((row) => row.id === 'persona')?.config ?? {};
			check(
				'prefix 逐字等于 标准模式 prefix + "\\n\\n" + 数学模式 prefix',
				plusPersona.prefix === `${standardPersona.prefix}\n\n${mathPersona.prefix}`,
				'拼接结果与两边原文不一致',
			);
		}
	}
}

console.log(failed === 0 ? '\nbundle 自检通过。' : `\nbundle 自检失败 ${failed} 项。`);
process.exit(failed === 0 ? 0 : 1);
