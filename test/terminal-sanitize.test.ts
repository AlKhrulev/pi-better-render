import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeTerminalText } from "../src/sanitize.ts";
import { noMath } from "../src/render/context.ts";
import { latexFallback, renderInline } from "../src/render/inline.ts";
import { placeholderRows } from "../src/math/kitty.ts";
import { renderMarkdown } from "../src/render/rich-markdown.ts";
import { decodeEntities } from "../src/render/util.ts";
import { plainStyle } from "../src/style.ts";

const style = plainStyle();
const render = (text: string) => renderMarkdown(text, 100, { style, math: noMath, streaming: false }).join("\n");
const controls = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;

function assertSafe(text: string): void {
	assert.ok(!controls.test(text), JSON.stringify(text));
}

test("terminal sanitizer preserves text and whitespace, but not C0/C1 commands", () => {
	assert.equal(sanitizeTerminalText("中文 🙂\tline\r\nnext\rend"), "中文 🙂\tline\nnext\nend");
	for (let code = 0; code <= 0x9f; code++) {
		if ((code > 0x1f && code < 0x7f) || code === 9 || code === 10 || code === 13) continue;
		assert.equal(sanitizeTerminalText(String.fromCharCode(code)), "\uFFFD", String(code));
	}
	assert.equal(sanitizeTerminalText("plain text"), "plain text");
});

test("entity decoding cannot recreate terminal controls", () => {
	for (const input of ["&#27;]52;c;UFJPQkU=&#7;", "&#x1b;[2J", "&#155;2J", "&#x9d;52;c;payload&#156;", "&#13;spoofed"]) {
		assertSafe(decodeEntities(input));
		assertSafe(render(input));
	}
	assert.equal(decodeEntities("&lt;x&gt; &amp; &#20013;"), "<x> & 中");
});

test("raw controls are neutralized in every Markdown source path", () => {
	const payload = "\x1b]52;c;UFJPQkU=\x07\x9b2J";
	for (const input of [
		payload,
		`# ${payload}`,
		`> ${payload}`,
		`- ${payload}`,
		`\`${payload}\``,
		`\`\`\`text\n${payload}\n\`\`\``,
		`<div>${payload}</div>`,
		`![alt \x1bOlabel](https://example.com/image.png)`,
		`| h |\n|---|\n| ${payload} |`,
		`$${payload}$`,
		`$$\n${payload}\n$$`,
	]) assertSafe(render(input));
	assertSafe(latexFallback(payload));
});

test("highlighter receives sanitized source but its own styling survives", () => {
	let source = "";
	const highlighted = { ...style, key: "sanitize-highlight", highlight: (code: string) => {
		source = code;
		return [`\x1b[31m${code}\x1b[39m`];
	} };
	const out = renderMarkdown("```text\n\x1b[2Jhello\n```", 80, { style: highlighted, math: noMath, streaming: false }).join("\n");
	assertSafe(source);
	assert.ok(out.includes("\x1b[31m"));
	assert.ok(!out.includes("\x1b[2J"));
});

test("only valid web and email URLs become OSC 8 links", () => {
	for (const href of ["https://example.com/path", "http://example.com", "mailto:test@example.com"]) {
		assert.ok(render(`[open](${href})`).includes(`\x1b]8;;${href}\x1b\\`));
	}
	for (const href of ["javascript:alert", "data:text/plain,hello", "file:///tmp/example", "command:run", "#anchor", "relative/path"]) {
		assert.ok(!render(`[open](${href})`).includes("\x1b]8;"), href);
	}
	const ctx = { style, math: noMath, width: 100, streaming: false, listDepth: 0 };
	for (const href of ["https://example.com/\x1b\\\x1b]52;c;payload\x07", "https://example.com/&#27;\\&#27;]52;c;payload&#7;"]) {
		const out = renderInline([{ type: "link", href, tokens: [{ type: "text", text: "open" }] }], ctx);
		assertSafe(out);
		assert.ok(!out.includes("\x1b]8;"));
	}
});

test("renderer-generated Kitty placeholders are preserved", () => {
	const image = placeholderRows(0x123456, 3, 1)[0]!;
	const math = { ...noMath, key: "sanitize-image", inline: () => image };
	const out = renderMarkdown("inline $x$", 80, { style, math, streaming: false }).join("\n");
	assert.ok(out.includes(image));
});
