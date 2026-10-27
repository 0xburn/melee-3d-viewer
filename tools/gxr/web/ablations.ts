// Pieces of the pixel shader taken out, to see what each costs (compile time in ablate.ts, GPU time in replayperf.ts): the pictures are wrong.
export const rep = (fs: string, a: string, b: string): string => { if (!fs.includes(a)) throw new Error("missing: " + a); return fs.replace(a, b); };
export const cut = (fs: string, from: string, to: string, body: string): string => { const a = fs.indexOf(from), b = fs.indexOf(to); if (a < 0 || b < 0) throw new Error("cut " + from); return fs.slice(0, a) + body + fs.slice(b); };
const NA = "uint f_add(uint a, uint b) { return floatBitsToUint(uintBitsToFloat(a) + uintBitsToFloat(b)); }\n";
const NM = "uint f_mul(uint a, uint b) { return floatBitsToUint(uintBitsToFloat(a) * uintBitsToFloat(b)); }\n";
const ND = "uint f_div(uint a, uint b) { return floatBitsToUint(uintBitsToFloat(a) / uintBitsToFloat(b)); }\n";
const cutAdd = (s: string) => cut(s, "uint f_add(uint a, uint b) {", "uint f_sub(uint a, uint b)", NA);
const cutMul = (s: string) => cut(s, "uint f_mul(uint a, uint b) {", "uint f_div(uint a, uint b)", NM);
const cutDiv = (s: string) => cut(s, "uint f_div(uint a, uint b) {", "// float(n) for", ND);
export const variants: Record<string, (fs: string) => string> = {
  nativef: (s) => cutDiv(cutMul(cutAdd(s))),
  nativeadd: cutAdd,
  nativemul: cutMul,
  nativediv: cutDiv,
  full: (s) => s,
  // whole parts of the per-pixel work (the pictures are wrong; only the GPU time means anything)
  walk: (s) => rep(s, "  uint stIdx = gState;", "  if (gState != 0xffffffffu) return;  uint stIdx = gState;"),
  afterz: (s) => rep(s, "  // raster colors", "  if (gState != 0xffffffffu) { col = (col & 0xff00ffffu) | uint(z & 255) << 16; dep = newDep; return; }  // raster colors"),
  nofog: (s) => rep(s, "  if (fsel != 0u) fogPixel(fsel, z, x, src);", ""),
  noblend: (s) => rep(rep(s, "  ivec4 res = blendPixel(S(0x41u), S(0x42u), src, dst);", "  ivec4 res = src;"), "  ivec4 dst = readColor(col, pixFmt);", "  ivec4 dst = ivec4(0);"),
  notex: (s) => rep(s, "bool texEn = bf(ord, 6, 1) == 1u;", "bool texEn = false;"),
  nocomb: (s) => rep(s, "    ivec3 ca = csel(", "    gRegs[0] = int(cc); continue;\n    ivec3 ca = csel("),
  nosample: (s) => rep(s, "      ivec4 tx = sampleMap(mp, cS, cT, lod, lin);", "      ivec4 tx = ivec4(cS, cT, lod, lin ? 1 : 0);"),
  nocoords: (s) => rep(s, "  for (int j = 0; j < uK.x; j++) genST(n, bx + (j & 1), by + (j >> 1), sv[j], tv[j]);", "  for (int j = 0; j < uK.x; j++) { sv[j] = uint(bx + j); tv[j] = uint(by + j); }"),
  nofetch: (s) => rep(s, "      sum += fetchTexel(mp, off, W, wrapC(s0 + dx, W, mp.ws), wrapC(t0 + dy, H, mp.wt)) * wgt;", "      sum += ivec4(wrapC(s0 + dx, W, mp.ws), wrapC(t0 + dy, H, mp.wt), int(off), 0) * wgt;"),
};
