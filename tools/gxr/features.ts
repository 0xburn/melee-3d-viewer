// which optional features the windows' draws use
import { parseDff } from "../../src/render3d/gxr/dff.ts";
import { GxGpu } from "../../src/render3d/gxr/gpu.ts";
import { bits } from "../../src/render3d/gxr/state.ts";
const SPEC = Deno.env.get("GX_SPEC_HARNESS") ?? "spec/harness";
const manifest = JSON.parse(Deno.readTextFileSync(`${SPEC}/manifest.json`));
const tot: Record<string, number> = {};
for (const w of manifest.windows) {
  const dff = parseDff(Deno.readFileSync(`${SPEC}/${w.recording}`));
  const be: any = {
    draw(regs: any, _m: any, _vd: any, _a: any, _b: any, _c: any, prims: any[]) {
      const bp = regs.bp, x = regs.xf;
      const add = (k: string) => (tot[k] = (tot[k] ?? 0) + 1);
      if (bits(bp[0], 16, 3) > 0) add("indirect stages");
      if (bits(bp[0], 19, 1)) add("zfreeze");
      for (const p of prims) { if (p.type === 5 || p.type === 6) add("line prims"); if (p.type === 7) add("point prims"); if (p.type === 4) add("fan prims"); if (p.type <= 1) add("quads"); }
      const ns = bits(bp[0], 10, 4) + 1;
      for (let i = 0; i < ns; i++) {
        const cc = bp[0xc0 + 2 * i], ac = bp[0xc1 + 2 * i];
        if (bits(cc, 16, 2) === 3 || bits(ac, 16, 2) === 3) add("compare mode");
        if (bits(cc, 20, 2) !== 0 || bits(ac, 20, 2) !== 0) add("scale != x1");
        if (bits(cc, 16, 2) === 1 || bits(cc, 16, 2) === 2 || bits(ac, 16, 2) === 1 || bits(ac, 16, 2) === 2) add("bias");
        const ord = bp[0x28 + (i >> 1)] >> (i & 1 ? 12 : 0);
        if (bits(ord, 7, 3) >= 5 && bits(ord, 7, 3) !== 7) add("alpha bump ras");
      }
      if (bits(bp[0xf1], 21, 3) > 2) add("fog exp");
      if (bits(bp[0xf1], 20, 1)) add("fog ortho");
      if ((bp[0xe8] >> 10) & 1) add("fog range adjust");
      if (bits(bp[0xf5], 2, 2)) add("depth texture");
      if (bits(bp[0x43], 0, 3) !== 0) add("pixfmt!=0");
      if (bits(bp[0x41], 1, 1) && !bits(bp[0x41], 0, 1)) add("logic op");
      if (bits(bp[0x41], 11, 1)) add("blend subtract");
      for (let m = 0; m < 8; m++) { const hi = m >= 4, k = m & 3; const img1 = bp[(hi ? 0xac : 0x8c) + k]; if (bits(img1, 21, 1)) add("tmem image"); const f = bits(bp[(hi ? 0xa8 : 0x88) + k], 20, 4); if (f === 10) add("c14x2"); }
      for (let n = 0; n < 8; n++) { const t = x[0x1040 + n]; const ty = bits(t, 4, 3); if (ty >= 2) add("texgen color"); }
    },
    copy(regs: any) { const c = regs.bp[0x52]; if (!(c >> 14 & 1)) { const k = `copy tp=${bits(c, 3, 4)} i=${bits(c, 15, 1)} half=${bits(c, 9, 1)}`; tot[k] = (tot[k] ?? 0) + 1; } return { toXfb: !!(c >> 14 & 1), rect: [], clear: false }; },
    copyClear() {},
  };
  const gpu = new GxGpu(be, dff, null);
  for (const f of dff.frames) gpu.runFrame(f);
}
console.log(JSON.stringify(tot, null, 1));
