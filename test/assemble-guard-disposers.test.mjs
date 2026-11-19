import { test } from "node:test";
import assert from "node:assert/strict";
import { Context, Service } from "@deepseek-ai/cordis";
import { installAssembleGuard } from "../lib/identity.js";

const native = () => ({ sections: [{ name: "ordinary", text: "KEEP USER TEXT" }], contexts: [], tools: [] });
class Prompt extends Service {
  constructor(ctx) { super(ctx, "systemPrompt"); }
  async assemble() { return native(); }
  section() { return () => {}; }
}

test("释放后旧改写失效;旧 cleanup 摘不掉新 owner", async () => {
  const prompt = { assemble: async () => native() };
  const a = installAssembleGuard(prompt, (v) => ({ ...v, marker: "a" }));
  assert.equal((await prompt.assemble()).marker, "a");
  const b = installAssembleGuard(prompt, (v) => ({ ...v, marker: "b" }));
  a();
  assert.equal((await prompt.assemble()).marker, "b");
  b();
  assert.deepEqual(await prompt.assemble(), native());
});

test("同一个 rewriteFn 在新鲜 Cordis 代理上拿到同一个 disposer,释放后可重装", async () => {
  const root = new Context();
  await root.plugin(Prompt);
  try {
    const rewrite = (v) => ({ ...v, marker: "reused" });
    const p1 = root.systemPrompt, p2 = root.systemPrompt;
    assert.notEqual(p1, p2);
    const d1 = installAssembleGuard(p1, rewrite);
    const d2 = installAssembleGuard(p2, rewrite);
    const d3 = installAssembleGuard(root.systemPrompt, rewrite);
    assert.equal(typeof d1, "function");
    assert.equal(d2, d1);
    assert.equal(d3, d1);
    assert.equal((await root.systemPrompt.assemble()).marker, "reused");
    d1();
    assert.deepEqual(await root.systemPrompt.assemble(), native());
    const d4 = installAssembleGuard(root.systemPrompt, rewrite);
    assert.notEqual(d4, d1);
    d1(); // 迟到的旧 cleanup 不能摘掉当前绑定
    assert.equal(installAssembleGuard(root.systemPrompt, rewrite), d4);
    assert.equal((await root.systemPrompt.assemble()).marker, "reused");
    d4();
    assert.deepEqual(await root.systemPrompt.assemble(), native());

    // assemble 不可配置的宿主:退化成赋值路径,disposer 依旧有效且复用
    const target = {};
    Object.defineProperty(target, "assemble", { value: async () => native(), writable: true, configurable: false, enumerable: true });
    const wrapProxy = () => new Proxy(target, {});
    const f1 = installAssembleGuard(wrapProxy(), rewrite);
    const f2 = installAssembleGuard(wrapProxy(), rewrite);
    assert.equal(typeof f1, "function");
    assert.equal(f2, f1);
    assert.equal((await target.assemble()).marker, "reused");
    f1();
    assert.deepEqual(await target.assemble(), native());
  } finally {
    await root.fiber.dispose();
  }
});

test("交替改写时 disposer 有界,跨对象包装赋值也不串", async () => {
  const root = new Context();
  await root.plugin(Prompt);
  try {
    const rewriteA = (v) => ({ ...v, marker: "A" });
    const rewriteB = (v) => ({ ...v, marker: "B" });
    const seen = new Set();
    for (let i = 0; i < 50; i++) {
      seen.add(installAssembleGuard(root.systemPrompt, rewriteA));
      seen.add(installAssembleGuard(root.systemPrompt, rewriteB));
    }
    assert.equal(seen.size, 2);
    for (const d of seen) d();
    assert.deepEqual(await root.systemPrompt.assemble(), native());

    const a = { assemble: async () => native() };
    const b = { assemble: async () => native() };
    const disposeA = installAssembleGuard(a, rewriteA);
    installAssembleGuard(b, rewriteB);
    b.assemble = a.assemble;
    const disposeB = installAssembleGuard(a, rewriteB);
    assert.notEqual(disposeB, disposeA);
    assert.equal((await a.assemble()).marker, "B");
    disposeB();
    assert.deepEqual(await a.assemble(), native());
  } finally {
    await root.fiber.dispose();
  }
});
